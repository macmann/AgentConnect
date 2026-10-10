import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  handoffPolicy,
  handoffPolicyScope,
} from "@agentconnect/schemas/support";
import { sql } from "../db.js";
import { HttpError } from "../http-error.js";
import { effectivePolicy, validatePolicy } from "./policy.js";
import { lockCase, appendEvent } from "./cases.js";
import { initializeTriage } from "./triage.js";
type Helpers = Pick<
  typeof import("../app.js"),
  "actor" | "audit" | "id" | "params" | "workspaceAccess"
>;
export async function registerPolicyRoutes(app: FastifyInstance, h: Helpers) {
  const base = "/workspaces/:workspaceId/support";
  const options = (summary: string) => ({
    schema: { tags: ["Human support"], summary },
  });
  app.get(
    base + "/policy/targets",
    options("List scoped handoff policy targets"),
    async (r) => {
      const u = await h.actor(r),
        w = await h.workspaceAccess(
          u.id,
          h.id(h.params(r).workspaceId),
          "support:view",
        );
      const [agents, deployments, models] = await Promise.all([
        sql`SELECT id,name FROM agents WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} AND archived_at IS NULL ORDER BY name LIMIT 200`,
        sql`SELECT id,name FROM deployments WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} ORDER BY name LIMIT 200`,
        sql`SELECT id,name FROM model_configurations WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} AND archived_at IS NULL ORDER BY name LIMIT 200`,
      ]);
      return { agents, deployments, models };
    },
  );
  for (const method of ["get", "put", "delete"] as const) {
    app[method](
      base + "/policy",
      options(
        method === "get"
          ? "Read resolved handoff policy and scoped override"
          : method === "put"
            ? "Save a complete handoff policy override"
            : "Remove a scoped policy override and restore inheritance",
      ),
      async (r) => {
        const u = await h.actor(r),
          w = await h.workspaceAccess(
            u.id,
            h.id(h.params(r).workspaceId),
            method === "get" ? "support:view" : "support:queue:manage",
          );
        const q = handoffPolicyScope.parse(r.query),
          target = q.scope === "workspace" ? w.id : q.targetId!;
        return sql.begin(async (tx) => {
          let agentId = "",
            deploymentId: string | null = null;
          if (q.scope === "agent") {
            const [a] =
              await tx`SELECT id FROM agents WHERE id=${target} AND workspace_id=${w.id} AND organization_id=${w.organization_id} AND archived_at IS NULL`;
            if (!a) throw new HttpError(404, "Agent unavailable");
            agentId = a.id;
          }
          if (q.scope === "deployment") {
            const [d] =
              await tx`SELECT agent_id,id FROM deployments WHERE id=${target} AND workspace_id=${w.id} AND organization_id=${w.organization_id}`;
            if (!d) throw new HttpError(404, "Deployment unavailable");
            agentId = d.agent_id;
            deploymentId = d.id;
          }
          if (method === "put") {
            const p = handoffPolicy.parse(r.body);
            await validatePolicy(tx, w.id, w.organization_id, p);
            await tx`INSERT INTO support_policies(id,workspace_id,organization_id,scope,target_id,policy) VALUES (${randomUUID()},${w.id},${w.organization_id},${q.scope},${target},${tx.json(p)}) ON CONFLICT(workspace_id,scope,target_id) DO UPDATE SET policy=EXCLUDED.policy,revision=support_policies.revision+1,updated_at=now()`;
          } else if (method === "delete")
            await tx`DELETE FROM support_policies WHERE workspace_id=${w.id} AND scope=${q.scope} AND target_id=${target}`;
          if (method !== "get")
            await h.audit(
              tx,
              r,
              u.id,
              "support.policy." + (method === "put" ? "updated" : "reset"),
              target,
              w.organization_id,
              w.id,
            );
          const resolved = await effectivePolicy(tx, {
            id: "",
            workspace_id: w.id,
            organization_id: w.organization_id,
            agent_id: agentId || w.id,
            deployment_id: deploymentId,
          });
          const [override] =
            await tx`SELECT policy,revision FROM support_policies WHERE workspace_id=${w.id} AND scope=${q.scope} AND target_id=${target}`;
          return { ...resolved, override: override?.policy ?? null };
        });
      },
    );
  }
  app.post(
    base + "/cases/:caseId/brief/refresh",
    {
      ...options("Queue one bounded private handoff brief refresh"),
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (r) => {
      const u = await h.actor(r),
        w = await h.workspaceAccess(
          u.id,
          h.id(h.params(r).workspaceId),
          "support:reply",
        );
      z.strictObject({}).parse(r.body ?? {});
      return sql.begin(async (tx) => {
        const s = await lockCase(tx, h.id(h.params(r).caseId), w.id);
        const [live] =
          await tx`SELECT triage_status FROM support_cases WHERE id=${s.id}`;
        if (["pending", "running"].includes(live?.triage_status))
          return { queued: false, status: live!.triage_status };
        const [c] =
          await tx`SELECT * FROM conversations WHERE id=${s.conversation_id}`;
        const current = await effectivePolicy(tx, c as never);
        if (
          !current.policy.aiTriageEnabled &&
          !current.policy.generateHandoffSummary
        )
          throw new HttpError(
            409,
            "Enable AI triage or handoff briefs in the policy first",
          );
        await initializeTriage(
          tx,
          s.id,
          current.policy,
          current.source,
          current.revision,
        );
        await appendEvent(
          tx,
          s,
          "triage.requested",
          { id: u.id, type: "operator" },
          { refresh: true },
        );
        await h.audit(
          tx,
          r,
          u.id,
          "support.brief.refresh",
          s.id,
          w.organization_id,
          w.id,
        );
        return { queued: true, status: "pending" };
      });
    },
  );
}
