import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  permitted,
  type Capability,
  roles,
} from "@agentconnect/schemas/foundation";
import {
  supportMessage,
  supportPage,
  isOpenCase,
} from "@agentconnect/schemas/support";
import { sql } from "../db.js";
import {
  appendEvent,
  assertController,
  lockCase,
  readCase,
  type SupportActor,
} from "./cases.js";
import { conversationTimeline } from "./queries.js";
import { HttpError } from "../http-error.js";
type Helpers = Pick<
  typeof import("../app.js"),
  "actor" | "audit" | "id" | "params" | "workspaceAccess"
>;
export async function registerSupportConsoleRoutes(
  app: FastifyInstance,
  helpers: Helpers,
) {
  const { actor, audit, id, params, workspaceAccess } = helpers;
  async function context(r: FastifyRequest, cap: Capability) {
    const u = await actor(r);
    const w = await workspaceAccess(u.id, id(params(r).workspaceId), cap);
    return { u, w };
  }
  const base = "/workspaces/:workspaceId/support";
  app.get(
    base + "/summary",
    {
      schema: {
        tags: ["Human support"],
        summary: "Live support backlog counts; no estimated staffing or SLA",
      },
    },
    async (r) => {
      const { u, w } = await context(r, "support:view");
      const q = z.strictObject({ queueId: z.uuid().optional() }).parse(r.query);
      const [counts] =
        await sql`SELECT count(*) FILTER(WHERE status IN ('requested','triaging','queued','assigned'))::int AS waiting,count(*) FILTER(WHERE status IN ('active','waiting_customer','waiting_external'))::int AS active,count(*) FILTER(WHERE assigned_operator_id IS NULL)::int AS unassigned,count(*) FILTER(WHERE assigned_operator_id=${u.id})::int AS mine FROM support_cases WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} AND status NOT IN ('resolved','closed','cancelled') AND (${q.queueId ?? null}::uuid IS NULL OR queue_id=${q.queueId ?? null})`;
      return counts;
    },
  );
  app.get(
    base + "/operators",
    {
      schema: {
        tags: ["Human support"],
        summary: "Eligible existing users for manual assignment",
      },
    },
    async (r) => {
      const { w } = await context(r, "support:operator:view"),
        q = supportPage.parse(r.query);
      const eligibleRoles = roles.filter((role) =>
        permitted(role, "support:reply"),
      );
      const rows =
        await sql`SELECT u.id,u.name,u.created_at FROM users u WHERE EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=u.id AND m.organization_id=${w.organization_id} AND ((m.workspace_id=${w.id} AND m.role=ANY(${eligibleRoles}::text[])) OR (m.workspace_id IS NULL AND m.role IN ('owner','org_admin')))) AND (u.created_at,u.id)<(${q.before ?? new Date().toISOString()},${q.beforeId ?? "ffffffff-ffff-ffff-ffff-ffffffffffff"}) ORDER BY u.created_at DESC,u.id DESC LIMIT ${q.limit + 1}`;
      const items = rows.slice(0, q.limit),
        last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > q.limit && last
            ? { before: last.created_at, beforeId: last.id }
            : null,
      };
    },
  );
  app.get(
    base + "/cases/:caseId/timeline",
    {
      schema: {
        tags: ["Human support"],
        summary: "Paginated private unified conversation timeline",
      },
    },
    async (r) => {
      const { w } = await context(r, "support:view"),
        q = supportPage.parse(r.query),
        s = await readCase(id(params(r).caseId), w.id);
      const rows = await conversationTimeline(
        s.conversation_id,
        w.id,
        q.before,
        q.beforeId,
        q.limit,
      );
      const items = rows.slice(0, q.limit),
        last = items.at(-1);
      return {
        items,
        nextCursor:
          rows.length > q.limit && last
            ? { before: last.created_at, beforeId: last.id }
            : null,
      };
    },
  );
  app.post(
    base + "/cases/:caseId/notes",
    {
      schema: {
        tags: ["Human support"],
        summary:
          "Create a private operator note, excluded from customer APIs and AI prompts",
      },
    },
    async (r, reply) => {
      const { u, w } = await context(r, "support:note"),
        input = supportMessage.parse(r.body),
        noteId = randomUUID();
      const a: SupportActor = {
        id: u.id,
        type: permitted(w.role!, "support:supervise")
          ? "supervisor"
          : "operator",
        supervise: permitted(w.role!, "support:supervise"),
      };
      await sql.begin(async (tx) => {
        const s = await lockCase(tx, id(params(r).caseId), w.id);
        assertController(s, a);
        if (!isOpenCase(s.status))
          throw new HttpError(409, "Support case is no longer open");
        await tx`INSERT INTO support_notes(id,organization_id,workspace_id,conversation_id,support_case_id,author_id,content) VALUES (${noteId},${w.organization_id},${w.id},${s.conversation_id},${s.id},${u.id},${input.content})`;
        await appendEvent(tx, s, "note.created", a, { noteId });
        await audit(
          tx,
          r,
          u.id,
          "support.note.created",
          noteId,
          w.organization_id,
          w.id,
          { caseId: s.id },
        );
      });
      return reply.code(201).send({ id: noteId });
    },
  );
}
