import { agentConfig } from "@agentconnect/schemas/agents";
import { validateKnowledgeIds } from "./knowledge-core.js";
import { validateToolIds } from "./tool-runtime.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  apiKeyInput,
  reviewInput,
  priceInput,
  webhookInput,
  deploymentPromotion,
} from "@agentconnect/schemas/operations";
import { validateEndpoint } from "@agentconnect/provider-sdk";
import { actor, workspaceAccess, audit, id, params } from "./app.js";
import { HttpError } from "./http-error.js";
import { sql } from "./db.js";
import { token, digest, encrypt } from "./security.js";
import { config } from "./config.js";
async function context(
  r: FastifyRequest,
  cap:
    | "operations:view"
    | "operations:manage"
    | "member:manage" = "operations:view",
) {
  const u = await actor(r);
  const w = await workspaceAccess(u.id, id(params(r).workspaceId), cap);
  return { u, w };
}
export async function registerOperationsRoutes(app: FastifyInstance) {
  app.get("/workspaces/:workspaceId/operations/audit", async (r) => {
    const { u, w } = await context(r);
    await workspaceAccess(u.id, w.id, "audit:view");
    const q = z
      .object({
        action: z.string().max(100).optional(),
        before: z.iso.datetime().optional(),
        beforeId: z.uuid().optional(),
      })
      .parse(r.query);
    if (!!q.before !== !!q.beforeId)
      throw new HttpError(400, "Cursor requires before and beforeId");
    return sql`SELECT a.id,a.action,a.entity_id,a.created_at,u.name AS actor FROM audit_events a JOIN users u ON u.id=a.actor_id WHERE a.workspace_id=${w.id} AND a.organization_id=${w.organization_id} AND (${q.action ?? null}::text IS NULL OR a.action=${q.action ?? null}) AND (a.created_at,a.id)<(${q.before ?? new Date().toISOString()},${q.beforeId ?? "ffffffff-ffff-ffff-ffff-ffffffffffff"}) ORDER BY a.created_at DESC,a.id DESC LIMIT 100`;
  });
  app.get("/workspaces/:workspaceId/operations/analytics", async (r) => {
    const { w } = await context(r);
    const { days } = z
      .object({ days: z.coerce.number().int().min(1).max(90).default(30) })
      .parse(r.query);
    const from = new Date(Date.now() - days * 86400000).toISOString();
    const [summary] =
      await sql`SELECT count(*)::int AS runs,count(*) FILTER(WHERE status='completed')::int AS completed,count(*) FILTER(WHERE status='failed')::int AS failed,count(DISTINCT conversation_id)::int AS conversations,sum(input_tokens)::float8 AS input_tokens,sum(output_tokens)::float8 AS output_tokens,count(*) FILTER(WHERE input_tokens IS NULL OR output_tokens IS NULL)::int AS unknown_usage,avg(extract(epoch FROM (finished_at-started_at))*1000)::float8 AS average_latency_ms,sum((input_tokens*input_usd_per_million+output_tokens*output_usd_per_million)/1000000)::float8 AS estimated_cost_usd,count(*) FILTER(WHERE input_tokens IS NULL OR output_tokens IS NULL OR input_usd_per_million IS NULL OR output_usd_per_million IS NULL)::int AS unpriced_runs FROM agent_runs WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} AND started_at>=${from}`;
    const agents =
      await sql`SELECT a.id,a.name,count(*)::int AS runs,count(*) FILTER(WHERE ar.status='failed')::int AS failed,sum(ar.input_tokens)::float8 AS input_tokens,sum(ar.output_tokens)::float8 AS output_tokens,sum((ar.input_tokens*ar.input_usd_per_million+ar.output_tokens*ar.output_usd_per_million)/1000000)::float8 AS estimated_cost_usd FROM agent_runs ar JOIN conversations c ON c.id=ar.conversation_id JOIN agents a ON a.id=c.agent_id WHERE ar.workspace_id=${w.id} AND ar.started_at>=${from} GROUP BY a.id,a.name ORDER BY count(*) DESC LIMIT 100`;
    const workflows =
      await sql`SELECT w.id,w.name,count(*)::int AS runs,count(*) FILTER(WHERE wr.status='completed')::int AS completed,count(*) FILTER(WHERE wr.status='failed')::int AS failed,avg(extract(epoch FROM (wr.finished_at-wr.created_at))*1000)::float8 AS average_latency_ms FROM workflow_runs wr JOIN workflows w ON w.id=wr.workflow_id WHERE wr.workspace_id=${w.id} AND wr.created_at>=${from} GROUP BY w.id,w.name ORDER BY count(*) DESC LIMIT 100`;
    const [feedback] =
      await sql`SELECT count(*)::int AS reviews,count(*) FILTER(WHERE cr.rating='like')::int AS likes,count(*) FILTER(WHERE cr.rating='dislike')::int AS dislikes,count(*) FILTER(WHERE cr.corrected_response IS NOT NULL)::int AS corrections FROM conversation_reviews cr WHERE cr.workspace_id=${w.id} AND cr.created_at>=${from}`;
    return { days, summary, agents, workflows, feedback };
  });
  app.get("/workspaces/:workspaceId/operations/conversations", async (r) => {
    const { w } = await context(r);
    await workspaceAccess((await actor(r)).id, w.id, "conversation:view");
    const q = z
      .object({
        agentId: z.uuid().optional(),
        status: z
          .enum(["running", "completed", "failed", "cancelled"])
          .optional(),
        rating: z.enum(["like", "dislike"]).optional(),
        channel: z.enum(["playground", "hosted", "widget"]).optional(),
        days: z.coerce.number().int().min(1).max(90).default(30),
        before: z.iso.datetime().optional(),
        beforeId: z.uuid().optional(),
      })
      .parse(r.query);
    if (!!q.before !== !!q.beforeId)
      throw new HttpError(400, "Cursor requires before and beforeId");
    const from = new Date(Date.now() - q.days * 86400000).toISOString();
    return sql`SELECT c.id,c.created_at,c.agent_id,c.deployment_id,a.name,latest.status,latest.error_code,c.channel FROM conversations c JOIN agents a ON a.id=c.agent_id LEFT JOIN LATERAL (SELECT status,error_code FROM agent_runs WHERE conversation_id=c.id ORDER BY started_at DESC,id DESC LIMIT 1) latest ON true WHERE c.workspace_id=${w.id} AND c.created_at>=${from} AND (${q.agentId ?? null}::uuid IS NULL OR c.agent_id=${q.agentId ?? null}) AND (${q.status ?? null}::text IS NULL OR latest.status=${q.status ?? null}) AND (${q.channel ?? null}::text IS NULL OR c.channel=${q.channel ?? null}) AND (${q.rating ?? null}::text IS NULL OR EXISTS(SELECT 1 FROM conversation_reviews cr JOIN messages m ON m.id=cr.message_id WHERE m.conversation_id=c.id AND cr.rating=${q.rating ?? null})) AND (c.created_at,c.id)<(${q.before ?? new Date().toISOString()},${q.beforeId ?? "ffffffff-ffff-ffff-ffff-ffffffffffff"}) ORDER BY c.created_at DESC,c.id DESC LIMIT 30`;
  });
  app.get("/conversations/:conversationId/reviews", async (r) => {
    const u = await actor(r);
    const [c] =
      await sql`SELECT workspace_id FROM conversations WHERE id=${id(params(r).conversationId)}`;
    if (!c) throw new HttpError(404, "Conversation not found");
    await workspaceAccess(u.id, c.workspace_id, "conversation:view");
    return sql`SELECT cr.id,cr.message_id,cr.rating,cr.label,cr.comment,cr.corrected_response,cr.reason,cr.created_at,u.name AS reviewer FROM conversation_reviews cr JOIN messages m ON m.id=cr.message_id JOIN users u ON u.id=cr.reviewer_id WHERE m.conversation_id=${id(params(r).conversationId)} ORDER BY cr.created_at,cr.id LIMIT 500`;
  });
  app.post("/messages/:messageId/reviews", async (r, reply) => {
    const u = await actor(r);
    const [m] =
      await sql`SELECT id,workspace_id,organization_id FROM messages WHERE id=${id(params(r).messageId)} AND role='assistant'`;
    if (!m) throw new HttpError(404, "Assistant message not found");
    await workspaceAccess(u.id, m.workspace_id, "conversation:review");
    const data = reviewInput.parse(r.body),
      reviewId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO conversation_reviews(id,workspace_id,organization_id,message_id,reviewer_id,rating,label,comment,corrected_response,reason) VALUES (${reviewId},${m.workspace_id},${m.organization_id},${m.id},${u.id},${data.rating},${data.label},${data.comment},${data.correctedResponse},${data.reason})`;
      await audit(
        tx,
        r,
        u.id,
        "conversation.reviewed",
        reviewId,
        m.organization_id,
        m.workspace_id,
      );
    });
    return reply.code(201).send({ id: reviewId });
  });
  app.get("/workspaces/:workspaceId/operations/prices", async (r) => {
    const { w } = await context(r);
    return sql`SELECT p.model_id,m.name,p.input_usd_per_million,p.output_usd_per_million,p.updated_at FROM model_prices p JOIN model_configurations m ON m.id=p.model_id WHERE p.workspace_id=${w.id}`;
  });
  app.put("/workspaces/:workspaceId/operations/prices", async (r) => {
    const { u, w } = await context(r, "operations:manage"),
      d = priceInput.parse(r.body);
    const [m] =
      await sql`SELECT id FROM model_configurations WHERE id=${d.modelId} AND workspace_id=${w.id} AND archived_at IS NULL`;
    if (!m) throw new HttpError(400, "Select a model in this workspace");
    await sql.begin(async (tx) => {
      await tx`INSERT INTO model_prices(model_id,workspace_id,organization_id,input_usd_per_million,output_usd_per_million,updated_by) VALUES (${m.id},${w.id},${w.organization_id},${d.inputUsdPerMillion},${d.outputUsdPerMillion},${u.id}) ON CONFLICT(model_id) DO UPDATE SET input_usd_per_million=EXCLUDED.input_usd_per_million,output_usd_per_million=EXCLUDED.output_usd_per_million,updated_by=EXCLUDED.updated_by,updated_at=now()`;
      await audit(
        tx,
        r,
        u.id,
        "model.price_updated",
        m.id,
        w.organization_id,
        w.id,
      );
    });
    return { ok: true };
  });
  app.put("/workspaces/:workspaceId/members/:membershipId/role", async (r) => {
    const { u, w } = await context(r, "member:manage");
    const d = z
      .object({
        role: z.enum([
          "workspace_admin",
          "builder",
          "operator",
          "analyst",
          "viewer",
        ]),
      })
      .parse(r.body);
    await sql.begin(async (tx) => {
      const [m] =
        await tx`SELECT id,user_id,role FROM memberships WHERE id=${id(params(r).membershipId)} AND workspace_id=${w.id} AND organization_id=${w.organization_id} FOR UPDATE`;
      if (!m)
        throw new HttpError(
          404,
          "Workspace membership not found; organization roles cannot be changed here",
        );
      if (m.user_id === u.id)
        throw new HttpError(409, "You cannot change your own role");
      if (
        w.role === "workspace_admin" &&
        (m.role === "workspace_admin" || d.role === "workspace_admin")
      )
        throw new HttpError(
          403,
          "Only an organization administrator may grant or change workspace administrators",
        );
      await tx`UPDATE memberships SET role=${d.role} WHERE id=${m.id}`;
      await audit(
        tx,
        r,
        u.id,
        "member.role_updated",
        m.id,
        w.organization_id,
        w.id,
      );
    });
    return { ok: true };
  });
  app.get("/workspaces/:workspaceId/operations/api-keys", async (r) => {
    const { w } = await context(r, "operations:manage");
    return sql`SELECT id,label,agent_id,prefix,scope,expires_at,last_used_at,revoked_at FROM workspace_api_keys WHERE workspace_id=${w.id} ORDER BY created_at DESC LIMIT 100`;
  });
  app.post("/workspaces/:workspaceId/operations/api-keys", async (r, reply) => {
    const { u, w } = await context(r, "operations:manage"),
      d = apiKeyInput.parse(r.body);
    const [a] =
      await sql`SELECT id FROM agents WHERE id=${d.agentId} AND workspace_id=${w.id} AND archived_at IS NULL`;
    if (!a) throw new HttpError(400, "Select an agent in this workspace");
    const raw = `ac_${token()}`,
      keyId = randomUUID(),
      expiresAt = new Date(
        Date.now() + d.expiresInDays * 86400000,
      ).toISOString();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO workspace_api_keys(id,workspace_id,organization_id,agent_id,label,token_hash,prefix,created_by,expires_at) VALUES (${keyId},${w.id},${w.organization_id},${a.id},${d.label},${digest(raw)},${raw.slice(0, 11)},${u.id},${expiresAt})`;
      await audit(
        tx,
        r,
        u.id,
        "api_key.created",
        keyId,
        w.organization_id,
        w.id,
      );
    });
    return reply.code(201).send({ id: keyId, key: raw, expiresAt });
  });
  app.delete(
    "/workspaces/:workspaceId/operations/api-keys/:keyId",
    async (r) => {
      const { u, w } = await context(r, "operations:manage");
      await sql.begin(async (tx) => {
        const [k] =
          await tx`UPDATE workspace_api_keys SET revoked_at=now() WHERE id=${id(params(r).keyId)} AND workspace_id=${w.id} AND revoked_at IS NULL RETURNING id`;
        if (!k) throw new HttpError(404, "Active API key not found");
        await audit(
          tx,
          r,
          u.id,
          "api_key.revoked",
          k.id,
          w.organization_id,
          w.id,
        );
      });
      return { ok: true };
    },
  );
  app.get("/workspaces/:workspaceId/operations/webhooks", async (r) => {
    const { w } = await context(r, "operations:manage");
    return sql`SELECT id,name,url,enabled,created_at FROM workspace_webhooks WHERE workspace_id=${w.id} ORDER BY created_at DESC LIMIT 100`;
  });
  app.post("/workspaces/:workspaceId/operations/webhooks", async (r, reply) => {
    const { u, w } = await context(r, "operations:manage"),
      d = webhookInput.parse(r.body),
      webhookId = randomUUID(),
      signingSecret = token();
    try {
      validateEndpoint(
        d.url,
        config.WEBHOOK_ALLOWED_HOSTS.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } catch {
      throw new HttpError(
        400,
        "Webhook requires HTTPS and a hostname approved in WEBHOOK_ALLOWED_HOSTS",
      );
    }
    const url = new URL(d.url);
    if (url.search || url.hash)
      throw new HttpError(
        400,
        "Webhook URLs cannot include query strings or fragments",
      );
    await sql.begin(async (tx) => {
      await tx`INSERT INTO workspace_webhooks(id,workspace_id,organization_id,name,url,signing_secret,created_by) VALUES (${webhookId},${w.id},${w.organization_id},${d.name},${d.url},${tx.json(encrypt(signingSecret, `webhook:${webhookId}`))},${u.id})`;
      await audit(
        tx,
        r,
        u.id,
        "webhook.created",
        webhookId,
        w.organization_id,
        w.id,
      );
    });
    return reply.code(201).send({ id: webhookId, signingSecret });
  });
  app.put(
    "/workspaces/:workspaceId/operations/webhooks/:webhookId",
    async (r) => {
      const { u, w } = await context(r, "operations:manage"),
        d = z.object({ enabled: z.boolean() }).parse(r.body);
      await sql.begin(async (tx) => {
        const [h] =
          await tx`UPDATE workspace_webhooks SET enabled=${d.enabled} WHERE id=${id(params(r).webhookId)} AND workspace_id=${w.id} RETURNING id`;
        if (!h) throw new HttpError(404, "Webhook not found");
        await audit(
          tx,
          r,
          u.id,
          "webhook.updated",
          h.id,
          w.organization_id,
          w.id,
        );
      });
      return { ok: true };
    },
  );
  app.get(
    "/workspaces/:workspaceId/operations/webhook-deliveries",
    async (r) => {
      const { w } = await context(r, "operations:manage");
      return sql`SELECT id,webhook_id,status,attempts,error_code,http_status,created_at,delivered_at FROM webhook_deliveries WHERE workspace_id=${w.id} ORDER BY created_at DESC LIMIT 100`;
    },
  );
  app.post(
    "/workspaces/:workspaceId/operations/webhooks/:webhookId/rotate",
    async (r) => {
      const { u, w } = await context(r, "operations:manage"),
        signingSecret = token();
      await sql.begin(async (tx) => {
        const [h] =
          await tx`UPDATE workspace_webhooks SET signing_secret=${tx.json(encrypt(signingSecret, `webhook:${id(params(r).webhookId)}`))} WHERE id=${id(params(r).webhookId)} AND workspace_id=${w.id} RETURNING id`;
        if (!h) throw new HttpError(404, "Webhook not found");
        await audit(
          tx,
          r,
          u.id,
          "webhook.secret_rotated",
          h.id,
          w.organization_id,
          w.id,
        );
      });
      return { signingSecret };
    },
  );
  app.post(
    "/workspaces/:workspaceId/operations/webhook-deliveries/:deliveryId/retry",
    async (r) => {
      const { u, w } = await context(r, "operations:manage");
      await sql.begin(async (tx) => {
        const [d] =
          await tx`UPDATE webhook_deliveries d SET status='pending',attempts=0,error_code=NULL,http_status=NULL,next_attempt_at=now(),lease_until=NULL WHERE d.id=${id(params(r).deliveryId)} AND d.workspace_id=${w.id} AND d.status='failed' AND EXISTS(SELECT 1 FROM workspace_webhooks h WHERE h.id=d.webhook_id AND h.enabled=true) RETURNING id`;
        if (!d)
          throw new HttpError(
            409,
            "Only a failed delivery with an enabled webhook can be retried",
          );
        await audit(
          tx,
          r,
          u.id,
          "webhook.delivery_retried",
          d.id,
          w.organization_id,
          w.id,
        );
      });
      return { ok: true };
    },
  );
  app.get("/workspaces/:workspaceId/operations/deployments", async (r) => {
    const { w } = await context(r);
    return sql`SELECT d.id,d.name,d.agent_id,d.version_id,d.environment,d.enabled,v.version FROM deployments d JOIN agent_versions v ON v.id=d.version_id WHERE d.workspace_id=${w.id} ORDER BY d.created_at DESC LIMIT 100`;
  });
  app.put(
    "/workspaces/:workspaceId/operations/deployments/:deploymentId",
    async (r) => {
      const { u, w } = await context(r, "operations:manage"),
        d = deploymentPromotion.parse(r.body);
      await sql.begin(async (tx) => {
        const [deployment] =
          await tx`SELECT agent_id FROM deployments WHERE id=${id(params(r).deploymentId)} AND workspace_id=${w.id} FOR UPDATE`;
        if (!deployment) throw new HttpError(404, "Deployment not found");
        const [v] =
          await tx`SELECT id,config FROM agent_versions WHERE id=${d.versionId} AND agent_id=${deployment.agent_id} AND workspace_id=${w.id}`;
        if (!v)
          throw new HttpError(400, "Select a published version of this agent");
        const published = agentConfig.parse(v.config);
        await validateKnowledgeIds(
          published.rag.knowledgeBaseIds,
          w.id,
          w.organization_id,
          true,
        );
        await validateToolIds(published.tools.toolIds, {
          workspaceId: w.id,
          organizationId: w.organization_id,
          publicAccess: true,
        });
        // Promotion changes future conversations; existing conversation snapshots stay fixed.
        await tx`UPDATE deployments SET version_id=${v.id},environment=${d.environment} WHERE id=${id(params(r).deploymentId)}`;
        await audit(
          tx,
          r,
          u.id,
          "deployment.promoted",
          id(params(r).deploymentId),
          w.organization_id,
          w.id,
        );
      });
      return { ok: true };
    },
  );
}
