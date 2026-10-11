import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { sql } from "./db.js";
import { id, params, actor, workspaceAccess, audit } from "./app.js";
import { token, digest } from "./security.js";
import { HttpError } from "./http-error.js";
import { requireWidgetOrigin } from "./channels.js";
import { branding } from "@agentconnect/schemas/customer-experience";
export async function customerSession(
  r: FastifyRequest,
  deploymentId: string,
  raw?: string,
) {
  const secret =
    raw ??
    (typeof r.headers["x-customer-token"] === "string"
      ? r.headers["x-customer-token"]
      : r.headers.authorization?.replace(/^Bearer /, ""));
  if (!secret || secret.length > 128) return null;
  const [s] =
    await sql`SELECT s.* FROM customer_sessions s JOIN deployments d ON d.id=s.deployment_id JOIN agents a ON a.id=d.agent_id WHERE s.token_hash=${digest(secret)} AND s.deployment_id=${deploymentId} AND s.expires_at>now() AND d.enabled AND a.archived_at IS NULL`;
  if (!s) return null;
  const widget = r.url.startsWith("/public/widgets/");
  if (
    (s.channel === "widget") !== widget ||
    (widget && s.widget_origin !== r.headers.origin)
  )
    return null;
  if (widget) await requireWidgetOrigin(r);
  return s;
}
export async function customerOwnsConversation(
  r: FastifyRequest,
  c: { deployment_id?: string | null; customer_session_id?: string | null },
) {
  if (!c.deployment_id || !c.customer_session_id) return false;
  const s = await customerSession(r, c.deployment_id);
  return s?.id === c.customer_session_id;
}
export async function customerConversationActive(c: {
  customer_session_id?: string | null;
  deployment_id?: string | null;
}) {
  if (!c.customer_session_id) return true;
  const [s] =
    await sql`SELECT id FROM customer_sessions WHERE id=${c.customer_session_id} AND deployment_id=${c.deployment_id!} AND expires_at>now()`;
  return !!s;
}
export async function registerCustomerSessions(app: FastifyInstance) {
  app.put(
    "/workspaces/:workspaceId/channels/:deploymentId/branding",
    async (r) => {
      const u = await actor(r),
        w = await workspaceAccess(
          u.id,
          id(params(r).workspaceId),
          "operations:manage",
        ),
        b = branding.parse(r.body);
      await sql.begin(async (tx) => {
        const [d] =
          await tx`UPDATE deployments SET branding=${tx.json(b)} WHERE id=${id(params(r).deploymentId)} AND workspace_id=${w.id} AND organization_id=${w.organization_id} RETURNING id`;
        if (!d) throw new HttpError(404, "Deployment not found");
        await audit(
          tx,
          r,
          u.id,
          "deployment.branding_updated",
          d.id,
          w.organization_id,
          w.id,
        );
      });
      return { ok: true };
    },
  );
  for (const channel of ["deployments", "widgets"]) {
    const base = "/public/" + channel + "/:deploymentId";
    app.post(
      base + "/sessions",
      { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (r, reply) => {
        if (channel === "widgets") await requireWidgetOrigin(r);
        const deploymentId = id(params(r).deploymentId);
        const [d] =
          await sql`SELECT d.* FROM deployments d JOIN agents a ON a.id=d.agent_id WHERE d.id=${deploymentId} AND d.enabled AND a.archived_at IS NULL`;
        if (!d) throw new HttpError(404, "Deployment not found");
        const supplied = r.headers.authorization;
        if (supplied) {
          const s = await customerSession(r, deploymentId);
          if (!s)
            throw new HttpError(401, "Customer session expired or unavailable");
          await sql`UPDATE customer_sessions SET last_seen_at=now() WHERE id=${s.id}`;
          return { id: s.id, expiresAt: s.expires_at };
        }
        const raw = token();
        const [s] =
          await sql`INSERT INTO customer_sessions(id,deployment_id,workspace_id,organization_id,token_hash,channel,widget_origin) VALUES(${randomUUID()},${d.id},${d.workspace_id},${d.organization_id},${digest(raw)},${channel === "widgets" ? "widget" : "hosted"},${channel === "widgets" ? r.headers.origin! : null}) RETURNING id,expires_at`;
        return reply
          .code(201)
          .header("cache-control", "no-store")
          .send({ id: s!.id, token: raw, expiresAt: s!.expires_at });
      },
    );
    app.get(base + "/history", async (r, reply) => {
      const s = await customerSession(r, id(params(r).deploymentId));
      if (!s)
        throw new HttpError(401, "Customer session expired or unavailable");
      const q = z
        .object({
          before: z.iso.datetime().optional(),
          beforeId: z.uuid().optional(),
        })
        .parse(r.query);
      if (!!q.before !== !!q.beforeId)
        throw new HttpError(400, "History cursor requires both fields");
      reply.header("cache-control", "no-store");
      return sql`SELECT c.id,c.created_at,c.last_customer_message_at,c.conversation_mode,c.handoff_status,(SELECT left(content,120) FROM messages WHERE conversation_id=c.id AND role='user' ORDER BY created_at,id LIMIT 1) AS title FROM conversations c WHERE c.customer_session_id=${s.id} AND c.deployment_id=${s.deployment_id} AND (c.created_at,c.id)<(${q.before ?? new Date().toISOString()},${q.beforeId ?? "ffffffff-ffff-ffff-ffff-ffffffffffff"}) ORDER BY c.created_at DESC,c.id DESC LIMIT 30`;
    });
    app.get(base + "/history/:conversationId", async (r, reply) => {
      const s = await customerSession(r, id(params(r).deploymentId));
      if (!s)
        throw new HttpError(401, "Customer session expired or unavailable");
      const [c] =
        await sql`SELECT id,conversation_mode,handoff_status FROM conversations WHERE id=${id(params(r).conversationId)} AND customer_session_id=${s.id} AND deployment_id=${s.deployment_id}`;
      if (!c) throw new HttpError(404, "Conversation not found");
      reply.header("cache-control", "no-store");
      const q = z
        .object({
          before: z.iso.datetime().optional(),
          beforeId: z.uuid().optional(),
        })
        .parse(r.query);
      if (!!q.before !== !!q.beforeId)
        throw new HttpError(400, "Transcript cursor requires both fields");
      const rows =
        await sql`SELECT m.id AS "messageId",m.role,m.content,m.citations,m.ui_blocks AS blocks,m.created_at FROM messages m JOIN agent_runs ar ON ar.id=m.run_id WHERE m.conversation_id=${c.id} AND ar.status IN ('completed','failed','cancelled') AND (m.created_at,m.id)<(${q.before ?? new Date().toISOString()},${q.beforeId ?? "ffffffff-ffff-ffff-ffff-ffffffffffff"}) ORDER BY m.created_at DESC,m.id DESC LIMIT 201`;
      return {
        ...c,
        messages: rows.slice(0, 200).reverse(),
        hasMore: rows.length > 200,
      };
    });
    app.delete(base + "/sessions", async (r, reply) => {
      const s = await customerSession(r, id(params(r).deploymentId));
      if (!s)
        throw new HttpError(401, "Customer session expired or unavailable");
      await sql.begin(async (tx) => {
        await tx`UPDATE customer_sessions SET expires_at=now() WHERE id=${s.id}`;
        await tx`UPDATE conversations SET guest_token_hash=${digest(token())} WHERE customer_session_id=${s.id}`;
      });
      return reply.code(204).send();
    });
  }
}
