import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  messagingInput,
  messagingCredentialFields,
  type MessagingProvider,
} from "@agentconnect/schemas/messaging";
import { actor, workspaceAccess, params, id, audit } from "./app.js";
import { sql } from "./db.js";
import { config } from "./config.js";
import { token, encrypt, decrypt } from "./security.js";
import { HttpError } from "./http-error.js";
import {
  connectMessaging,
  incomingMessages,
  validSignature,
  equalSecret,
  verifyTeamsActivity,
  MessagingError,
  defaultMessagingHttp,
  type MessagingHttp,
  type Credentials,
} from "./customer-messaging-adapters.js";
export const messagingRawBodies = new WeakMap<FastifyRequest, string>();
export const messagingWebhookPath = (url: string) =>
  /^\/messaging\/webhooks\/[0-9a-f-]{36}$/.test(url.split("?")[0]!);
export const credentialContext = (row: {
  id: string;
  organization_id: string;
  workspace_id: string;
}) => `messaging:${row.organization_id}:${row.workspace_id}:${row.id}`;
export function channelCredentials(row: import("postgres").Row): Credentials {
  return JSON.parse(
    decrypt(
      row.credentials,
      credentialContext({
        id: row.id,
        workspace_id: row.workspace_id,
        organization_id: row.organization_id,
      }),
    ),
  );
}
export function messagingCallback(channelId: string) {
  return config.MESSAGING_PUBLIC_URL
    ? config.MESSAGING_PUBLIC_URL.replace(/\/$/, "") +
        "/messaging/webhooks/" +
        channelId
    : null;
}
async function owned(r: FastifyRequest, manage = false) {
  const u = await actor(r),
    w = await workspaceAccess(
      u.id,
      id(params(r).workspaceId),
      manage ? "operations:manage" : "operations:view",
    );
  return { u, w };
}
const publicColumns = sql`id,name,provider,deployment_id,enabled,settings,connected_at,last_error,created_at,last_received_at`;
export async function registerMessagingChannels(
  app: FastifyInstance,
  http: MessagingHttp = defaultMessagingHttp,
) {
  const base = "/workspaces/:workspaceId/messaging-channels";
  app.get(base, async (r) => {
    const { w } = await owned(r);
    const rows =
      await sql`SELECT ${publicColumns} FROM messaging_channels WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} ORDER BY created_at DESC`;
    return rows.map((row) => ({
      ...row,
      callbackUrl: messagingCallback(row.id),
    }));
  });
  app.post(base, async (r, reply) => {
    const { u, w } = await owned(r, true),
      d = messagingInput.parse(r.body),
      channelId = randomUUID();
    for (const f of messagingCredentialFields[d.provider])
      if (f.required && !d.credentials[f.key])
        throw new HttpError(400, f.label + " is required");
    const [deployment] =
      await sql`SELECT d.id FROM deployments d JOIN agents a ON a.id=d.agent_id WHERE d.id=${d.deploymentId} AND d.workspace_id=${w.id} AND d.organization_id=${w.organization_id} AND d.enabled AND a.archived_at IS NULL`;
    if (!deployment)
      throw new HttpError(400, "Choose an enabled published deployment");
    const c = { ...d.credentials, webhookSecret: token() },
      context = credentialContext({
        id: channelId,
        workspace_id: w.id,
        organization_id: w.organization_id,
      });
    await sql.begin(async (tx) => {
      await tx`INSERT INTO messaging_channels(id,workspace_id,organization_id,deployment_id,name,provider,credentials,created_by) VALUES(${channelId},${w.id},${w.organization_id},${d.deploymentId},${d.name},${d.provider},${tx.json(encrypt(JSON.stringify(c), context))},${u.id})`;
      await audit(
        tx,
        r,
        u.id,
        "messaging.created",
        channelId,
        w.organization_id,
        w.id,
      );
    });
    return reply.code(201).send({
      id: channelId,
      callbackUrl: messagingCallback(channelId),
      verifyToken: d.provider === "messenger" ? c.webhookSecret : undefined,
    });
  });
  app.put(base + "/:channelId", async (r) => {
    const { u, w } = await owned(r, true),
      d = messagingInput.parse(r.body);
    const result = await sql.begin(async (tx) => {
      const [row] =
        await tx`SELECT *,updated_at::text AS update_stamp FROM messaging_channels WHERE id=${id(params(r).channelId)} AND workspace_id=${w.id} AND organization_id=${w.organization_id} FOR UPDATE`;
      if (!row) throw new HttpError(404, "Channel unavailable");
      if (d.provider !== row.provider || d.deploymentId !== row.deployment_id)
        throw new HttpError(
          400,
          "Create a new channel to change its provider or deployment",
        );
      const c = { ...channelCredentials(row), ...d.credentials };
      for (const f of messagingCredentialFields[d.provider])
        if (f.required && !c[f.key])
          throw new HttpError(400, f.label + " is required");
      await tx`UPDATE messaging_channels SET name=${d.name},credentials=${tx.json(encrypt(JSON.stringify(c), credentialContext({ id: row.id, workspace_id: row.workspace_id, organization_id: row.organization_id })))},enabled=false,connected_at=NULL,last_received_at=NULL,last_error=NULL,updated_at=now() WHERE id=${row.id}`;
      await audit(
        tx,
        r,
        u.id,
        "messaging.updated",
        row.id,
        w.organization_id,
        w.id,
      );
      return { ok: true };
    });
    return result;
  });
  app.post(base + "/:channelId/connect", async (r) => {
    const { u, w } = await owned(r, true);
    const [row] =
      await sql`SELECT *,updated_at::text AS update_stamp FROM messaging_channels WHERE id=${id(params(r).channelId)} AND workspace_id=${w.id} AND organization_id=${w.organization_id}`;
    if (!row) throw new HttpError(404, "Channel unavailable");
    const callback = messagingCallback(row.id);
    if (!callback)
      throw new HttpError(
        409,
        "Set MESSAGING_PUBLIC_URL to the public HTTPS API address, then restart the API",
      );
    const c = channelCredentials(row);
    try {
      const settings = await connectMessaging(row.provider, c, callback, http);
      await sql.begin(async (tx) => {
        const changed =
          await tx`UPDATE messaging_channels SET settings=${tx.json(settings)},enabled=true,connected_at=now(),last_error=NULL,updated_at=now() WHERE id=${row.id} AND updated_at::text=${row.update_stamp} RETURNING id`;
        if (!changed.length)
          throw new HttpError(
            409,
            "Channel changed during connection test; retry",
          );
        await audit(
          tx,
          r,
          u.id,
          "messaging.connected",
          row.id,
          w.organization_id,
          w.id,
        );
      });
      return {
        ...settings,
        callbackUrl: callback,
        verifyToken: row.provider === "messenger" ? c.webhookSecret : undefined,
      };
    } catch (e) {
      const code =
        e instanceof MessagingError ? e.code : "CHANNEL_CONNECTION_FAILED";
      await sql`UPDATE messaging_channels SET last_error=${code} WHERE id=${row.id}`;
      app.log.warn(
        { channelId: row.id, provider: row.provider, code },
        "Messaging connection failed",
      );
      throw e instanceof HttpError ? e : new HttpError(502, code);
    }
  });
  app.post(base + "/:channelId/disconnect", async (r) => {
    const { u, w } = await owned(r, true);
    const [row] =
      await sql`UPDATE messaging_channels SET enabled=false,updated_at=now() WHERE id=${id(params(r).channelId)} AND workspace_id=${w.id} AND organization_id=${w.organization_id} RETURNING id`;
    if (!row) throw new HttpError(404, "Channel unavailable");
    await sql.begin(async (tx) =>
      audit(
        tx,
        r,
        u.id,
        "messaging.disconnected",
        row.id,
        w.organization_id,
        w.id,
      ),
    );
    return { ok: true };
  });
  app.get(base + "/:channelId/delivery", async (r) => {
    const { w } = await owned(r);
    return sql`SELECT i.id,i.status,i.error_code,i.attempts,i.created_at FROM messaging_inbox i JOIN messaging_channels c ON c.id=i.channel_id WHERE c.id=${id(params(r).channelId)} AND c.workspace_id=${w.id} AND c.organization_id=${w.organization_id} ORDER BY i.created_at DESC LIMIT 50`;
  });
  app.get("/messaging/webhooks/:channelId", async (r, reply) => {
    const [row] =
      await sql`SELECT *,updated_at::text AS update_stamp FROM messaging_channels WHERE id=${id(params(r).channelId)} AND provider='messenger'`;
    const q = r.query as Record<string, string>;
    if (
      !row ||
      q["hub.mode"] !== "subscribe" ||
      !equalSecret(
        q["hub.verify_token"],
        channelCredentials(row).webhookSecret!,
      )
    )
      throw new HttpError(403, "Webhook verification failed");
    return reply
      .type("text/plain")
      .send(String(q["hub.challenge"] ?? "").slice(0, 200));
  });
  app.post(
    "/messaging/webhooks/:channelId",
    {
      bodyLimit: 256 * 1024,
      config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
    },
    async (r, reply) => {
      const [row] =
        await sql`SELECT *,updated_at::text AS update_stamp FROM messaging_channels WHERE id=${id(params(r).channelId)}`;
      if (!row) throw new HttpError(404, "Channel unavailable");
      const c = channelCredentials(row),
        provider = row.provider as MessagingProvider,
        raw = messagingRawBodies.get(r) ?? "";
      try {
        if (
          provider === "messenger" &&
          !validSignature(
            raw,
            c.appSecret!,
            r.headers["x-hub-signature-256"] as string | undefined,
            "sha256=",
          )
        )
          throw new MessagingError("CHANNEL_SIGNATURE_INVALID");
        if (
          provider === "viber" &&
          !validSignature(
            raw,
            c.token!,
            r.headers["x-viber-content-signature"] as string | undefined,
          )
        )
          throw new MessagingError("CHANNEL_SIGNATURE_INVALID");
        if (
          provider === "telegram" &&
          !equalSecret(
            r.headers["x-telegram-bot-api-secret-token"] as string | undefined,
            c.webhookSecret!,
          )
        )
          throw new MessagingError("CHANNEL_SIGNATURE_INVALID");
        if (provider === "teams")
          await verifyTeamsActivity(r.headers.authorization, c, r.body, http);
      } catch {
        throw new HttpError(401, "Webhook authentication failed");
      }
      if (!row.enabled) return reply.code(200).send({ ok: true });
      await sql`UPDATE messaging_channels SET last_received_at=now() WHERE id=${row.id}`;
      const events = incomingMessages(provider, r.body);
      for (const event of events) {
        if (
          provider === "messenger" &&
          event.address.pageId !== row.settings.pageId
        )
          continue;
        await sql`INSERT INTO messaging_inbox(id,channel_id,event_id,external_id,content,address) VALUES(${randomUUID()},${row.id},${event.eventId},${event.externalId},${event.text},${sql.json(event.address)}) ON CONFLICT(channel_id,event_id) DO NOTHING`;
      }
      return reply.code(200).send({ ok: true });
    },
  );
}
