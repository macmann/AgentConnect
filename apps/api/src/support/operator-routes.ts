import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  operatorProfileInput,
  presenceStatus,
  skillInput,
  queueMembersInput,
  supportPage,
} from "@agentconnect/schemas/support";
import type { Capability } from "@agentconnect/schemas/foundation";
import { sql } from "../db.js";
import { HttpError } from "../http-error.js";
import { eligibleOperator, lockCase } from "./cases.js";
import { lockSupportCapacity } from "./operator-capacity.js";
import {
  profileRows,
  routingCandidates,
  routeCase,
  validateRoutingSkills,
} from "./routing.js";
type Helpers = Pick<
  typeof import("../app.js"),
  "actor" | "audit" | "id" | "params" | "workspaceAccess"
>;
export async function registerOperatorRoutes(
  app: FastifyInstance,
  helpers: Helpers,
) {
  const { actor, audit, id, params, workspaceAccess } = helpers,
    base = "/workspaces/:workspaceId/support";
  async function context(r: FastifyRequest, cap: Capability) {
    const u = await actor(r),
      w = await workspaceAccess(u.id, id(params(r).workspaceId), cap);
    return { u, w };
  }
  app.get(base + "/profiles", async (r) => {
    const { w } = await context(r, "support:operator:view"),
      q = supportPage.parse(r.query);
    const rows = await sql.begin((tx) =>
      profileRows(tx, w.id, w.organization_id, q),
    );
    const items = rows.slice(0, q.limit),
      last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > q.limit && last
          ? { before: last.created_at, beforeId: last.user_id }
          : null,
    };
  });
  app.get(base + "/operators/:userId/profile", async (r) => {
    const { w } = await context(r, "support:operator:view"),
      userId = id(params(r).userId);
    const rows = await sql.begin((tx) =>
      profileRows(tx, w.id, w.organization_id, { limit: 1, userId }),
    );
    return { profile: rows[0] ?? null };
  });
  app.put(base + "/operators/:userId/profile", async (r) => {
    const { u, w } = await context(r, "support:supervise"),
      userId = id(params(r).userId),
      input = operatorProfileInput.parse(r.body);
    return sql.begin(async (tx) => {
      await lockSupportCapacity(tx, w.id);
      await eligibleOperator(tx, userId, w.id, w.organization_id);
      await validateRoutingSkills(
        tx,
        w.id,
        input.skills.map((s) => s.skillId),
        false,
      );
      const [p] =
        await tx`INSERT INTO operator_profiles(organization_id,workspace_id,user_id,enabled,manual_availability,capacity_limit,priority_weight,timezone,languages) VALUES (${w.organization_id},${w.id},${userId},${input.enabled},${input.manualAvailability},${input.capacityLimit},${input.priorityWeight},${input.timezone},${tx.json(input.languages)}) ON CONFLICT(workspace_id,user_id) DO UPDATE SET enabled=EXCLUDED.enabled,manual_availability=EXCLUDED.manual_availability,capacity_limit=EXCLUDED.capacity_limit,priority_weight=EXCLUDED.priority_weight,timezone=EXCLUDED.timezone,languages=EXCLUDED.languages,presence_expires_at=CASE WHEN EXCLUDED.enabled AND EXCLUDED.manual_availability THEN operator_profiles.presence_expires_at ELSE NULL END,updated_at=now() RETURNING *`;
      await tx`DELETE FROM operator_skills WHERE workspace_id=${w.id} AND user_id=${userId}`;
      for (const sk of input.skills)
        await tx`INSERT INTO operator_skills(organization_id,workspace_id,user_id,skill_id,proficiency) VALUES (${w.organization_id},${w.id},${userId},${sk.skillId},${sk.proficiency})`;
      await audit(
        tx,
        r,
        u.id,
        "support.operator.updated",
        userId,
        w.organization_id,
        w.id,
        { enabled: input.enabled, capacityLimit: input.capacityLimit },
      );
      return p;
    });
  });
  app.post(base + "/operators/:userId/presence", async (r) => {
    const { u, w } = await context(r, "support:reply"),
      userId = id(params(r).userId),
      input = z.strictObject({ status: presenceStatus }).parse(r.body);
    if (userId !== u.id)
      throw new HttpError(403, "Operators can only set their own presence");
    return sql.begin(async (tx) => {
      await lockSupportCapacity(tx, w.id);
      const [p] =
        await tx`UPDATE operator_profiles SET presence_status=${input.status},presence_expires_at=CASE WHEN ${input.status}='offline' THEN NULL ELSE clock_timestamp()+interval '90 seconds' END WHERE workspace_id=${w.id} AND user_id=${u.id} AND enabled AND manual_availability RETURNING user_id,presence_status,presence_expires_at`;
      if (!p)
        throw new HttpError(
          409,
          "Ask a supervisor to enable your support profile and availability",
        );
      return p;
    });
  });
  app.get(base + "/skills", async (r) => {
    const { w } = await context(r, "support:operator:view"),
      q = supportPage.parse(r.query);
    const rows =
      await sql`SELECT * FROM support_skills WHERE workspace_id=${w.id} AND (created_at,id)<(${q.before ?? new Date().toISOString()},${q.beforeId ?? "ffffffff-ffff-ffff-ffff-ffffffffffff"}) ORDER BY created_at DESC,id DESC LIMIT ${q.limit + 1}`;
    const items = rows.slice(0, q.limit),
      last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > q.limit && last
          ? { before: last.created_at, beforeId: last.id }
          : null,
    };
  });
  for (const update of [false, true])
    app[update ? "put" : "post"](
      base + "/skills" + (update ? "/:skillId" : ""),
      async (r, reply) => {
        const { u, w } = await context(r, "support:supervise"),
          input = skillInput.parse(r.body),
          skillId = update ? id(params(r).skillId) : randomUUID();
        const result = await sql
          .begin(async (tx) => {
            await lockSupportCapacity(tx, w.id);
            const [s] = update
              ? await tx`UPDATE support_skills SET name=${input.name},description=${input.description},enabled=${input.enabled},updated_at=now() WHERE id=${skillId} AND workspace_id=${w.id} RETURNING *`
              : await tx`INSERT INTO support_skills(id,organization_id,workspace_id,name,description,enabled) VALUES (${skillId},${w.organization_id},${w.id},${input.name},${input.description},${input.enabled}) RETURNING *`;
            if (!s) throw new HttpError(404, "Support skill unavailable");
            await audit(
              tx,
              r,
              u.id,
              "support.skill.updated",
              skillId,
              w.organization_id,
              w.id,
            );
            return s;
          })
          .catch((e) => {
            if (e.code === "23505")
              throw new HttpError(409, "Skill name already exists");
            throw e;
          });
        return reply.code(update ? 200 : 201).send(result);
      },
    );
  app.get(base + "/queues/:queueId/members", async (r) => {
    const { w } = await context(r, "support:operator:view"),
      queueId = id(params(r).queueId);
    const [queue] =
      await sql`SELECT id FROM support_queues WHERE id=${queueId} AND workspace_id=${w.id}`;
    if (!queue) throw new HttpError(404, "Support queue unavailable");
    return {
      items:
        await sql`SELECT m.user_id,m.enabled,m.priority_weight,u.name FROM support_queue_members m JOIN users u ON u.id=m.user_id WHERE m.queue_id=${queueId} AND m.workspace_id=${w.id} ORDER BY u.name,m.user_id LIMIT 100`,
    };
  });
  app.put(base + "/queues/:queueId/members", async (r) => {
    const { u, w } = await context(r, "support:queue:manage"),
      queueId = id(params(r).queueId),
      input = queueMembersInput.parse(r.body);
    return sql.begin(async (tx) => {
      await lockSupportCapacity(tx, w.id);
      const [queue] =
        await tx`SELECT id FROM support_queues WHERE id=${queueId} AND workspace_id=${w.id} FOR UPDATE`;
      if (!queue) throw new HttpError(404, "Support queue unavailable");
      for (const m of input.members) {
        await eligibleOperator(tx, m.userId, w.id, w.organization_id);
        const [p] =
          await tx`SELECT user_id FROM operator_profiles WHERE workspace_id=${w.id} AND user_id=${m.userId}`;
        if (!p)
          throw new HttpError(400, "Queue members need a support profile");
      }
      await tx`DELETE FROM support_queue_members WHERE queue_id=${queueId} AND NOT(user_id=ANY(${input.members.map((m) => m.userId)}::uuid[]))`;
      for (const m of input.members)
        await tx`INSERT INTO support_queue_members(organization_id,workspace_id,queue_id,user_id,enabled,priority_weight) VALUES (${w.organization_id},${w.id},${queueId},${m.userId},${m.enabled},${m.priorityWeight}) ON CONFLICT(queue_id,user_id) DO UPDATE SET enabled=EXCLUDED.enabled,priority_weight=EXCLUDED.priority_weight`;
      await audit(
        tx,
        r,
        u.id,
        "support.queue.members.updated",
        queueId,
        w.organization_id,
        w.id,
        { count: input.members.length },
      );
      return { updated: true };
    });
  });
  app.get(base + "/cases/:caseId/routing", async (r) => {
    const { w } = await context(r, "support:operator:view");
    return sql.begin(async (tx) => {
      const s = await lockCase(tx, id(params(r).caseId), w.id);
      return routingCandidates(tx, s);
    });
  });
  app.post(base + "/cases/:caseId/route", async (r) => {
    const { u, w } = await context(r, "support:assign");
    z.strictObject({}).parse(r.body ?? {});
    return sql.begin(async (tx) => {
      const s = await lockCase(tx, id(params(r).caseId), w.id);
      const result = await routeCase(tx, s, u.id);
      if (result.assigned)
        await audit(
          tx,
          r,
          u.id,
          "support.routing.assigned",
          s.id,
          w.organization_id,
          w.id,
        );
      return result;
    });
  });
}
