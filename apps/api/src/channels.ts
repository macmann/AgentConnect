import {
  customerHandoffState,
  confirmHandoff,
  dismissHandoff,
} from "./support/policy.js";
import { legacyHandoff } from "./support/cases.js";
import { permitted } from "@agentconnect/schemas/foundation";
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { widgetSettings, webOrigin } from "@agentconnect/schemas/channels";
import { actor, audit, id, params, workspaceAccess } from "./app.js";
import { sql } from "./db.js";
import { digest } from "./security.js";
import { HttpError } from "./http-error.js";
import { widgetBundle } from "./widget-bundle.js";
export function widgetDeploymentPath(r: FastifyRequest) {
  return /^\/public\/widgets\/([0-9a-f-]{36})(?:\/(?:chat|conversations\/[0-9a-f-]{36}\/handoff))?$/.exec(
    r.url.split("?")[0]!,
  )?.[1];
}
export async function widgetOriginAllowed(
  deploymentId: string,
  origin?: string,
) {
  if (
    !z.uuid().safeParse(deploymentId).success ||
    !webOrigin.safeParse(origin).success
  )
    return false;
  const [d] =
    await sql`SELECT d.widget_settings FROM deployments d JOIN agents a ON a.id=d.agent_id WHERE d.id=${deploymentId} AND d.enabled AND a.archived_at IS NULL`;
  if (!d) return false;
  const settings = widgetSettings.parse(d.widget_settings);
  return (
    settings.enabled &&
    (settings.access === "public" || settings.allowedOrigins.includes(origin!))
  );
}
export async function requireWidgetOrigin(r: FastifyRequest) {
  const deploymentId = widgetDeploymentPath(r);
  if (
    !deploymentId ||
    !(await widgetOriginAllowed(deploymentId, r.headers.origin))
  )
    throw new HttpError(403, "Widget disabled or origin not allowed");
}
async function conversationAccess(r: FastifyRequest, publicRoute: boolean) {
  const [c] =
    await sql`SELECT * FROM conversations WHERE id=${id(params(r).conversationId)}`;
  if (!c) throw new HttpError(404, "Conversation not found");
  if (publicRoute) {
    const [d] =
      await sql`SELECT d.id FROM deployments d JOIN agents a ON a.id=d.agent_id WHERE d.id=${id(params(r).deploymentId)} AND d.enabled AND a.archived_at IS NULL`;
    const raw = r.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (
      !d ||
      c.deployment_id !== d.id ||
      !c.guest_token_hash ||
      raw.length > 128 ||
      !timingSafeEqual(
        Buffer.from(digest(raw)),
        Buffer.from(c.guest_token_hash),
      )
    )
      throw new HttpError(404, "Conversation not found");
    if (c.channel === "widget") {
      await requireWidgetOrigin(r);
      if (c.widget_origin !== r.headers.origin)
        throw new HttpError(403, "Conversation origin does not match");
    } else if (widgetDeploymentPath(r))
      throw new HttpError(403, "Conversation channel does not match");
    return { c, userId: null };
  }
  const u = await actor(r);
  await workspaceAccess(u.id, c.workspace_id, "conversation:view");
  return { c, userId: u.id };
}
export async function registerChannelRoutes(app: FastifyInstance) {
  app.get("/widget.js", async (_r, reply) =>
    reply
      .type("application/javascript")
      .header("cross-origin-resource-policy", "cross-origin")
      .header("cache-control", "public, max-age=300")
      .send(widgetBundle),
  );
  app.get("/workspaces/:workspaceId/channels", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "operations:view",
      );
    return sql`SELECT d.id,d.name,d.enabled,d.widget_settings,a.name AS agent_name FROM deployments d JOIN agents a ON a.id=d.agent_id WHERE d.workspace_id=${w.id} AND d.organization_id=${w.organization_id} ORDER BY d.created_at DESC LIMIT 100`;
  });
  app.put("/workspaces/:workspaceId/channels/:deploymentId", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "operations:manage",
      ),
      s = widgetSettings.parse(r.body);
    await sql.begin(async (tx) => {
      const [d] =
        await tx`UPDATE deployments SET widget_settings=${tx.json(s)} WHERE id=${id(params(r).deploymentId)} AND workspace_id=${w.id} AND organization_id=${w.organization_id} RETURNING id`;
      if (!d) throw new HttpError(404, "Deployment not found");
      await audit(
        tx,
        r,
        u.id,
        "deployment.widget_updated",
        d.id,
        w.organization_id,
        w.id,
      );
    });
    return { ok: true };
  });
  app.get("/workspaces/:workspaceId/handoffs", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "conversation:view",
      );
    return sql`SELECT c.id,c.handoff_status,c.channel,c.created_at,a.name FROM conversations c JOIN agents a ON a.id=c.agent_id WHERE c.workspace_id=${w.id} AND c.organization_id=${w.organization_id} AND c.handoff_status IN ('pending','active') ORDER BY c.created_at LIMIT 100`;
  });
  for (const prefix of [
    "/conversations/:conversationId/handoff",
    "/public/deployments/:deploymentId/conversations/:conversationId/handoff",
    "/public/widgets/:deploymentId/conversations/:conversationId/handoff",
  ]) {
    const publicRoute = prefix.startsWith("/public");
    app.get(prefix, async (r) => {
      const { c } = await conversationAccess(r, publicRoute);
      return {
        status: c.handoff_status,
        access: await sql.begin((tx) => customerHandoffState(tx, c as never)),
        events: (
          await sql`SELECT id,kind,content,created_at FROM handoff_events WHERE conversation_id=${c.id} ORDER BY created_at DESC,id DESC LIMIT 500`
        ).reverse(),
      };
    });
    app.post(
      prefix,
      { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
      async (r, reply) => {
        const { c, userId } = await conversationAccess(r, publicRoute);
        const d = z
          .object({
            action: z.enum([
              "request",
              "dismiss",
              "claim",
              "message",
              "reply",
              "resolve",
            ]),
            content: z.string().trim().max(4000).default(""),
          })
          .strict()
          .parse(r.body);
        const operatorAction =
          d.action === "reply" ||
          d.action === "claim" ||
          d.action === "resolve" ||
          (d.action === "message" && c.user_id !== userId && userId !== null);
        let supervise = false;
        if (operatorAction) {
          if (!userId) throw new HttpError(403, "Operator access required");
          const access = await workspaceAccess(
            userId,
            c.workspace_id,
            "handoff:manage",
          );
          supervise = permitted(access.role!, "support:supervise");
        } else if (userId && c.user_id !== userId)
          throw new HttpError(403, "Conversation owner required");
        await sql.begin(async (tx) => {
          if (["message", "reply"].includes(d.action) && !d.content)
            throw new HttpError(400, "Message content required");
          if (d.action === "request")
            await confirmHandoff(tx, c as never, userId);
          else if (d.action === "dismiss") await dismissHandoff(tx, c as never);
          else
            await legacyHandoff(tx, c.id, c.workspace_id, d.action, d.content, {
              id: userId ?? null,
              type: operatorAction
                ? supervise
                  ? "supervisor"
                  : "operator"
                : "customer",
              supervise,
            });
          if (userId)
            await audit(
              tx,
              r,
              userId,
              "handoff." +
                {
                  request: "requested",
                  dismiss: "dismissed",
                  claim: "claimed",
                  resolve: "resolved",
                  reply: "operator_message",
                  message: operatorAction ? "operator_message" : "user_message",
                }[d.action],
              c.id,
              c.organization_id,
              c.workspace_id,
            );
        });
        return reply.code(201).send({ ok: true });
      },
    );
  }
}
