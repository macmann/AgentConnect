import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Capability } from "@agentconnect/schemas/foundation";
import { permitted } from "@agentconnect/schemas/foundation";
import {
  caseInput,
  queueInput,
  queuePatch,
  supportResolution,
  supportAssignment,
  supportTransition,
  supportPage,
  supportCaseQuery,
} from "@agentconnect/schemas/support";
import { z } from "zod";
import { randomUUID } from "node:crypto";
type Helpers = Pick<
  typeof import("../app.js"),
  "actor" | "audit" | "id" | "params" | "workspaceAccess"
>;
import { sql } from "../db.js";
import { listCases } from "./queries.js";
import { registerOperatorRoutes } from "./operator-routes.js";
import { lockSupportCapacity } from "./operator-capacity.js";
import { validateRoutingSkills } from "./routing.js";
import { registerSupportConsoleRoutes } from "./console-routes.js";
import { HttpError } from "../http-error.js";
import {
  createCase,
  eligibleOperator,
  lockCase,
  claimCase,
  assignCase,
  transitionCase,
  resolveCase,
  sendSupportMessage,
  readCase,
  type SupportActor,
} from "./cases.js";
const pageRows = (rows: Record<string, unknown>[], limit: number) => {
  const items = rows.slice(0, limit),
    last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? { before: last.created_at, beforeId: last.id }
        : null,
  };
};
const routeOptions = (summary: string) => ({
  schema: { tags: ["Human support"], summary },
});
export async function registerSupportRoutes(
  app: FastifyInstance,
  helpers: Helpers,
) {
  const { actor, audit, id, params, workspaceAccess } = helpers;
  async function context(r: FastifyRequest, capability: Capability) {
    const u = await actor(r);
    const w = await workspaceAccess(
      u.id,
      id(params(r).workspaceId),
      capability,
    );
    const a: SupportActor = {
      id: u.id,
      type: permitted(w.role!, "support:supervise") ? "supervisor" : "operator",
      supervise: permitted(w.role!, "support:supervise"),
    };
    return { u, w, a };
  }

  await registerSupportConsoleRoutes(app, helpers);
  await registerOperatorRoutes(app, helpers);
  const base = "/workspaces/:workspaceId/support";
  app.get(
    base + "/queues",
    routeOptions("List workspace support queues"),
    async (r) => {
      const { w } = await context(r, "support:queue:view");
      const q = supportPage.parse(r.query);
      const rows =
        await sql`SELECT * FROM support_queues WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} AND (created_at,id)<(${q.before ?? new Date().toISOString()},${q.beforeId ?? "ffffffff-ffff-ffff-ffff-ffffffffffff"}) ORDER BY created_at DESC,id DESC LIMIT ${q.limit + 1}`;
      return pageRows(rows, q.limit);
    },
  );
  app.post(
    base + "/queues",
    routeOptions("Create a support queue with a validated routing policy"),
    async (r, reply) => {
      const { u, w } = await context(r, "support:queue:manage"),
        input = queueInput.parse(r.body);
      const queue = await sql
        .begin(async (tx) => {
          await lockSupportCapacity(tx, w.id);
          await validateRoutingSkills(tx, w.id, [
            ...input.routingConfig.requiredSkills,
            ...input.routingConfig.preferredSkills,
          ]);
          if (input.isDefault)
            await tx`UPDATE support_queues SET is_default=false WHERE workspace_id=${w.id} AND is_default`;
          const [s] =
            await tx`INSERT INTO support_queues(id,workspace_id,organization_id,name,description,enabled,priority,routing_strategy,assignment_mode,is_default,routing_config) VALUES (${randomUUID()},${w.id},${w.organization_id},${input.name},${input.description},${input.enabled},${input.priority},${input.routingStrategy},${input.assignmentMode},${input.isDefault},${tx.json(input.routingConfig)}) RETURNING *`;
          await audit(
            tx,
            r,
            u.id,
            "support.queue.created",
            s!.id,
            w.organization_id,
            w.id,
          );
          return s;
        })
        .catch((e) => {
          if (e.code === "23505")
            throw new HttpError(409, "Queue name already exists");
          throw e;
        });
      return reply.code(201).send(queue);
    },
  );
  app.patch(
    base + "/queues/:queueId",
    routeOptions(
      "Update or disable a support queue; retain historical references",
    ),
    async (r) => {
      const { u, w } = await context(r, "support:queue:manage"),
        input = queuePatch.parse(r.body);
      return sql
        .begin(async (tx) => {
          await lockSupportCapacity(tx, w.id);
          const [s] =
            await tx`SELECT * FROM support_queues WHERE id=${id(params(r).queueId)} AND workspace_id=${w.id} AND organization_id=${w.organization_id} FOR UPDATE`;
          if (!s) throw new HttpError(404, "Support queue unavailable");
          if (input.routingConfig)
            await validateRoutingSkills(tx, w.id, [
              ...input.routingConfig.requiredSkills,
              ...input.routingConfig.preferredSkills,
            ]);
          if (input.isDefault)
            await tx`UPDATE support_queues SET is_default=false WHERE workspace_id=${w.id} AND is_default AND id<>${s.id}`;
          if (input.members) {
            for (const m of input.members) {
              await eligibleOperator(tx, m.userId, w.id, w.organization_id);
              const [p] =
                await tx`SELECT user_id FROM operator_profiles WHERE workspace_id=${w.id} AND user_id=${m.userId}`;
              if (!p)
                throw new HttpError(
                  400,
                  "Queue members need a support profile",
                );
            }
            await tx`DELETE FROM support_queue_members WHERE queue_id=${s.id} AND NOT(user_id=ANY(${input.members.map((m) => m.userId)}::uuid[]))`;
            for (const m of input.members)
              await tx`INSERT INTO support_queue_members(organization_id,workspace_id,queue_id,user_id,enabled,priority_weight) VALUES (${w.organization_id},${w.id},${s.id},${m.userId},${m.enabled},${m.priorityWeight}) ON CONFLICT(queue_id,user_id) DO UPDATE SET enabled=EXCLUDED.enabled,priority_weight=EXCLUDED.priority_weight`;
          }
          const [updated] =
            await tx`UPDATE support_queues SET name=${input.name ?? s.name},description=${input.description ?? s.description},enabled=${input.enabled ?? s.enabled},priority=${input.priority ?? s.priority},routing_strategy=${input.routingStrategy ?? s.routing_strategy},assignment_mode=${input.assignmentMode ?? s.assignment_mode},is_default=${input.isDefault ?? s.is_default},routing_config=${tx.json(input.routingConfig ?? s.routing_config)},updated_at=now() WHERE id=${s.id} RETURNING *`;
          await audit(
            tx,
            r,
            u.id,
            "support.queue.updated",
            s.id,
            w.organization_id,
            w.id,
          );
          return updated;
        })
        .catch((e) => {
          if (e.code === "23505")
            throw new HttpError(409, "Queue name already exists");
          throw e;
        });
    },
  );
  app.get(
    base + "/cases",
    routeOptions(
      "List support cases with filters and stable cursor pagination",
    ),
    async (r) => {
      const { u, w } = await context(r, "support:view"),
        q = supportCaseQuery.parse(r.query);
      const rows = await listCases(w.id, w.organization_id, u.id, q);
      return pageRows(rows, q.limit);
    },
  );
  app.post(
    base + "/cases",
    routeOptions(
      "Escalate an existing conversation without creating a second chat",
    ),
    async (r, reply) => {
      const { u, w, a } = await context(r, "support:claim"),
        input = caseInput.parse(r.body);
      const result = await sql
        .begin(async (tx) => {
          const result = await createCase(
            tx,
            { ...input, workspaceId: w.id },
            a,
          );
          if (result.created)
            await audit(
              tx,
              r,
              u.id,
              "support.case.created",
              result.supportCase.id,
              w.organization_id,
              w.id,
            );
          return result;
        })
        .catch((e) => {
          if (e.code === "23505")
            throw new HttpError(
              409,
              "Support request conflicts with an existing case or idempotency key",
            );
          throw e;
        });
      return reply.code(result.created ? 201 : 200).send(result.supportCase);
    },
  );
  app.get(
    base + "/cases/:caseId",
    routeOptions("Read a tenant-scoped support case"),
    async (r) => {
      const { w } = await context(r, "support:view");
      return readCase(id(params(r).caseId), w.id);
    },
  );
  app.get(
    base + "/cases/:caseId/events",
    routeOptions("Read the internal append-only case timeline"),
    async (r) => {
      const { w } = await context(r, "support:view"),
        q = supportPage.parse(r.query),
        caseId = id(params(r).caseId);
      await readCase(caseId, w.id);
      const rows =
        await sql`SELECT * FROM support_events WHERE support_case_id=${caseId} AND workspace_id=${w.id} AND organization_id=${w.organization_id} AND (created_at,id)<(${q.before ?? new Date().toISOString()},${q.beforeId ?? "ffffffff-ffff-ffff-ffff-ffffffffffff"}) ORDER BY created_at DESC,id DESC LIMIT ${q.limit + 1}`;
      return pageRows(rows, q.limit);
    },
  );
  const actions = ["claim", "assign", "status", "resolve", "messages"] as const;
  for (const action of actions) {
    app.post(
      base + "/cases/:caseId/" + action,
      routeOptions(`Support case ${action}`),
      async (r) => {
        const cap: Capability =
          action === "claim"
            ? "support:claim"
            : action === "assign"
              ? "support:assign"
              : action === "messages"
                ? "support:reply"
                : "support:resolve";
        const { u, w, a } = await context(r, cap),
          caseId = id(params(r).caseId);
        const input =
          action === "assign"
            ? supportAssignment.parse(r.body)
            : action === "status"
              ? supportTransition.parse(r.body)
              : action === "resolve"
                ? supportResolution.parse(r.body)
                : action === "messages"
                  ? z
                      .strictObject({
                        content: z.string().trim().min(1).max(4000),
                      })
                      .parse(r.body)
                  : z.strictObject({}).parse(r.body ?? {});
        await sql.begin(async (tx) => {
          const s = await lockCase(tx, caseId, w.id);
          if (action === "claim") await claimCase(tx, s, a);
          else if (action === "assign")
            await assignCase(
              tx,
              s,
              (input as { operatorId: string }).operatorId,
              a,
              (input as { queueId?: string | null }).queueId,
            );
          else if (action === "status")
            await transitionCase(
              tx,
              s,
              (input as { status: typeof s.status }).status,
              a,
            );
          else if (action === "resolve") {
            const resolution = input as {
              summary: string;
              code: string;
              finalResponse?: string;
            };
            if (resolution.finalResponse && s.status !== "resolved")
              await sendSupportMessage(tx, s, a, resolution.finalResponse);
            await resolveCase(tx, s, a, resolution.summary, resolution.code);
          } else
            await sendSupportMessage(
              tx,
              s,
              a,
              (input as { content: string }).content,
            );
          await audit(
            tx,
            r,
            u.id,
            `support.case.${action}`,
            s.id,
            w.organization_id,
            w.id,
          );
        });
        return readCase(caseId, w.id);
      },
    );
  }
}
