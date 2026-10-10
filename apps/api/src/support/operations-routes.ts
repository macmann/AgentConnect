import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  supportTransfer,
  supportPriorityChange,
  supportAnalyticsQuery,
  supportPage,
} from "@agentconnect/schemas/support";
import { permitted, type Capability } from "@agentconnect/schemas/foundation";
import { sql } from "../db.js";
import { HttpError } from "../http-error.js";
import { lockCase, appendEvent, readCase, type SupportActor } from "./cases.js";
import { transferCase } from "./operations.js";
import { supportAnalytics, supervisorOverview } from "./analytics.js";
import { supportStream } from "./live.js";
type Helpers = Pick<
  typeof import("../app.js"),
  "actor" | "audit" | "id" | "params" | "workspaceAccess"
>;
export async function registerOperationsRoutes(
  app: FastifyInstance,
  h: Helpers,
) {
  const base = "/workspaces/:workspaceId/support";
  async function context(r: FastifyRequest, cap: Capability) {
    const u = await h.actor(r),
      w = await h.workspaceAccess(u.id, h.id(h.params(r).workspaceId), cap);
    const a: SupportActor = {
      id: u.id,
      type: permitted(w.role!, "support:supervise") ? "supervisor" : "operator",
      supervise: permitted(w.role!, "support:supervise"),
    };
    return { u, w, a };
  }
  app.get(base + "/stream", async (r, reply) => {
    const { w } = await context(r, "support:view");
    return supportStream(r, reply, async () => {
      await context(r, "support:view");
      const [row] =
        await sql`SELECT revision FROM support_live_revisions WHERE workspace_id=${w.id} AND organization_id=${w.organization_id}`;
      return String(row?.revision ?? 0);
    });
  });
  app.get(base + "/analytics", async (r) => {
    const { w } = await context(r, "support:analytics:view"),
      q = supportAnalyticsQuery.parse(r.query);
    return supportAnalytics(w.id, w.organization_id, q.days, q.queueId);
  });
  app.get(base + "/supervision", async (r) => {
    const { w } = await context(r, "support:supervise");
    return supervisorOverview(w.id, w.organization_id);
  });
  app.get(base + "/notifications", async (r) => {
    const { u, w } = await context(r, "support:view"),
      q = supportPage.parse(r.query);
    const rows =
      await sql`SELECT id,support_case_id,kind,created_at,read_at FROM support_notifications WHERE user_id=${u.id} AND workspace_id=${w.id} AND organization_id=${w.organization_id} AND (created_at,id)<(${q.before ?? new Date().toISOString()},${q.beforeId ?? "ffffffff-ffff-ffff-ffff-ffffffffffff"}) ORDER BY created_at DESC,id DESC LIMIT ${q.limit + 1}`;
    const items = rows.slice(0, q.limit),
      last = items.at(-1);
    const [unread] =
      await sql`SELECT count(*)::int AS count FROM support_notifications WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} AND user_id=${u.id} AND read_at IS NULL`;
    return {
      items,
      unread: unread!.count,
      nextCursor:
        rows.length > q.limit && last
          ? { before: last.created_at, beforeId: last.id }
          : null,
    };
  });
  app.post(base + "/notifications/:notificationId/read", async (r) => {
    const { u, w } = await context(r, "support:view");
    z.strictObject({}).parse(r.body ?? {});
    const [n] =
      await sql`UPDATE support_notifications SET read_at=COALESCE(read_at,clock_timestamp()) WHERE id=${h.id(h.params(r).notificationId)} AND user_id=${u.id} AND workspace_id=${w.id} AND organization_id=${w.organization_id} RETURNING id`;
    if (!n) throw new HttpError(404, "Notification unavailable");
    return { ok: true };
  });
  for (const action of ["transfer", "priority"] as const)
    app.post(base + "/cases/:caseId/" + action, async (r) => {
      const { u, w, a } = await context(
        r,
        action === "transfer" ? "support:transfer" : "support:supervise",
      );
      const caseId = h.id(h.params(r).caseId),
        input =
          action === "transfer"
            ? supportTransfer.parse(r.body)
            : supportPriorityChange.parse(r.body);
      await sql.begin(async (tx) => {
        const s = await lockCase(tx, caseId, w.id);
        if (action === "transfer")
          await transferCase(
            tx,
            s,
            a,
            input as z.infer<typeof supportTransfer>,
          );
        else {
          const p = input as z.infer<typeof supportPriorityChange>;
          await tx`UPDATE support_cases SET priority=${p.priority},updated_at=clock_timestamp() WHERE id=${s.id}`;
          await appendEvent(tx, s, "case.priority_changed", a, {
            priority: p.priority,
            reason: p.reason,
          });
        }
        await h.audit(
          tx,
          r,
          u.id,
          "support.case." + action,
          s.id,
          w.organization_id,
          w.id,
          { reason: input.reason },
        );
      });
      return readCase(caseId, w.id);
    });
}
