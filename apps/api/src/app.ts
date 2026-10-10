import { registerSupportRoutes } from "./support/routes.js";
import { registerRetentionRoutes } from "./retention.js";
import { registerConnectorRoutes, connectorHttpError } from "./connectors.js";
import { registerQualityRoutes } from "./quality.js";
import {
  registerChannelRoutes,
  widgetDeploymentPath,
  widgetOriginAllowed,
  requireWidgetOrigin,
} from "./channels.js";
import { registerGenerativeRoutes } from "./generative.js";
import { registerOperationsRoutes } from "./operations.js";
import { apiKeyChatRequest, apiKeyActor } from "./api-key-auth.js";
import { registerWorkflowRoutes } from "./workflows.js";
import { WorkflowError } from "./workflow-runtime.js";
import { registerToolRoutes } from "./tools.js";
import { ToolError } from "./tool-runtime.js";
import { registerKnowledgeRoutes } from "./knowledge.js";
import { KnowledgeError } from "@agentconnect/rag/parsers";
import { ProviderError } from "@agentconnect/provider-sdk";
import { registerAgentRoutes } from "./agents.js";
import type { TransactionSql } from "postgres";
import Fastify, { LogController, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import { queueMail } from "./mail.js";
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
import { infrastructureReadiness } from "./readiness-infrastructure.js";
import {
  register,
  credentials,
  named,
  invitation,
  secretInput,
  tokenInput,
  resetInput,
  emailInput,
  permitted,
  type Role,
  type Capability,
} from "@agentconnect/schemas/foundation";
import { sql, db, closeDb } from "./db.js";
import { organizations } from "@agentconnect/db/schema";
import { eq } from "drizzle-orm";
import { config } from "./config.js";
import {
  token,
  digest,
  hashPassword,
  checkPassword,
  encrypt,
} from "./security.js";
import { HttpError } from "./http-error.js";
export { HttpError } from "./http-error.js";
const deny = () => {
  throw new HttpError(403, "Access denied");
};
export const id = (v: unknown) => z.uuid().parse(v);
export const params = (r: FastifyRequest) => r.params as Record<string, string>;
type Actor = {
  id: string;
  email: string;
  name: string;
  verified_at: Date | null;
};
export async function actor(r: FastifyRequest): Promise<Actor> {
  if (apiKeyChatRequest(r)) return apiKeyActor(r);
  const session = r.cookies.session;
  if (!session) throw new HttpError(401, "Sign in required");
  const [u] = await sql<
    Actor[]
  >`SELECT u.id,u.email,u.name,u.verified_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=${digest(session)} AND s.expires_at>now()`;
  if (!u) throw new HttpError(401, "Session expired");
  return u;
}
async function organizationRole(userId: string, orgId: string) {
  const [m] =
    await sql`SELECT role FROM memberships WHERE organization_id=${orgId} AND user_id=${userId} AND workspace_id IS NULL`;
  return m?.role as Role | undefined;
}
async function organizationAccess(
  userId: string,
  orgId: string,
  cap?: Capability,
) {
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org) throw new HttpError(404, "Organization not found");
  const role = await organizationRole(userId, orgId);
  if (!role || (cap && !permitted(role, cap))) deny();
  return org;
}
export async function workspaceAccess(
  userId: string,
  workspaceId: string,
  cap?: Capability,
) {
  const [w] = await sql<
    { id: string; name: string; organization_id: string }[]
  >`SELECT id,name,organization_id FROM workspaces WHERE id=${workspaceId}`;
  if (!w) throw new HttpError(404, "Workspace not found");
  const orgRole = await organizationRole(userId, w.organization_id);
  const [m] =
    await sql`SELECT role FROM memberships WHERE organization_id=${w.organization_id} AND workspace_id=${workspaceId} AND user_id=${userId}`;
  const role =
    orgRole === "owner" || orgRole === "org_admin"
      ? orgRole
      : (m?.role as Role | undefined);
  if (!role || (cap && !permitted(role, cap))) deny();
  return { ...w, role };
}
export async function audit(
  tx: TransactionSql,
  r: FastifyRequest,
  userId: string,
  action: string,
  entityId: string | null,
  orgId: string | null = null,
  workspaceId: string | null = null,
  metadata: Record<string, unknown> = {},
) {
  await tx`INSERT INTO audit_events(id,organization_id,workspace_id,actor_id,action,entity_id,metadata,ip,user_agent) VALUES (${randomUUID()},${orgId},${workspaceId},${userId},${action},${entityId},${tx.json(metadata as never)},${r.ip},${String(r.headers["user-agent"] ?? "").slice(0, 512)})`;
}
async function authToken(user: Actor, purpose: "verify" | "reset") {
  const raw = token();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO auth_tokens(token_hash,user_id,purpose,expires_at) VALUES (${digest(raw)},${user.id},${purpose},now()+interval '1 hour')`;
    await queueMail(
      tx,
      user.email,
      purpose === "verify" ? "Verify your email" : "Reset your password",
      `Open ${config.WEB_ORIGIN}/#action=${purpose}&token=${raw}`,
    );
  });
}
export async function buildApp(
  options: {
    providerFactory?: import("@agentconnect/provider-sdk").ProviderFactory;
    embeddingFactory?: import("@agentconnect/provider-sdk/embeddings").EmbeddingFactory;
    sharePointClientFactory?: import("./sharepoint.js").SharePointClientFactory;
  } = {},
) {
  class QuietLogs extends LogController {
    constructor() {
      super({ disableRequestLogging: true });
    }
  }
  const app = Fastify({
    logController: new QuietLogs(),
    logger: config.NODE_ENV !== "test",
    bodyLimit: 32 * 1024,
    ajv: { customOptions: { coerceTypes: false } },
    trustProxy: false,
  });
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 2 });
  await redis.ping();
  await app.register(cookie);
  await app.register(cors, {
    delegator: async (r: FastifyRequest) => {
      const widget = widgetDeploymentPath(r);
      return {
        origin: widget
          ? (await widgetOriginAllowed(widget, r.headers.origin))
            ? r.headers.origin!
            : false
          : config.WEB_ORIGIN,
        credentials: !widget,
        methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["content-type", "authorization"],
      };
    },
  });
  await app.register(helmet);
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute", redis });
  await app.register(swagger, {
    openapi: {
      info: { title: "AgentConnect Foundation API", version: "0.1.0" },
      servers: [{ url: "http://localhost:4000" }],
    },
  });

  const bodySchemas: Record<string, z.ZodType> = {
    "POST /auth/register": register,
    "POST /auth/login": credentials,
    "POST /auth/verify": tokenInput,
    "POST /auth/password-reset/request": emailInput,
    "POST /auth/password-reset/confirm": resetInput,
    "POST /organizations": named,
    "POST /organizations/:orgId/workspaces": named,
    "POST /organizations/:orgId/invitations": invitation,
    "POST /invitations/accept": tokenInput,
    "POST /workspaces/:workspaceId/secrets": secretInput,
    "PUT /workspaces/:workspaceId/secrets/:secretId": secretInput.pick({
      value: true,
    }),
  };
  app.addHook("onRoute", (route) => {
    const body = bodySchemas[`${route.method} ${route.url}`];
    const names = [...route.url.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);
    route.schema = {
      ...route.schema,
      tags: [route.url.split("/")[1] ?? "system"],
      ...(body
        ? { body: z.toJSONSchema(body, { io: "input", target: "draft-7" }) }
        : {}),
      ...(names.length
        ? {
            params: {
              type: "object",
              properties: Object.fromEntries(
                names.map((name) => [
                  name,
                  name === "blockId"
                    ? { type: "string", pattern: "^[a-z][a-z0-9_]{0,39}$" }
                    : { type: "string", format: "uuid" },
                ]),
              ),
              required: names,
            },
          }
        : {}),
    };
  });
  app.addHook("onRequest", async (r) => {
    if (apiKeyChatRequest(r)) {
      const bucket = `api-chat-ip:${digest(r.ip)}:${Math.floor(Date.now() / 60000)}`;
      const count = Number(
        await redis.eval(
          "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],75) end; return n",
          1,
          bucket,
        ),
      );
      if (count > 300)
        throw new HttpError(
          429,
          "API chat IP rate limit exceeded; retry next minute",
        );
    }
    if (
      !["GET", "HEAD", "OPTIONS"].includes(r.method) &&
      r.headers.origin !== config.WEB_ORIGIN &&
      !apiKeyChatRequest(r) &&
      !widgetDeploymentPath(r)
    )
      throw new HttpError(403, "Invalid request origin");
  });
  app.addHook("onRequest", async (r) => {
    if (widgetDeploymentPath(r) && r.method !== "OPTIONS")
      await requireWidgetOrigin(r);
  });
  app.setErrorHandler((error, _r, reply) => {
    if (error instanceof WorkflowError)
      return reply.code(400).send({ error: error.code });
    if (error instanceof ToolError)
      return reply.code(400).send({ error: error.code });
    if (error instanceof KnowledgeError)
      return reply
        .code(
          error.code === "KNOWLEDGE_NOT_PUBLIC"
            ? 403
            : error.code.includes("UNAVAILABLE")
              ? 404
              : 400,
        )
        .send({ error: error.code });
    const connectorError = connectorHttpError(error);
    if (connectorError)
      return reply
        .code(connectorError.statusCode)
        .send({ error: connectorError.message });
    if (error instanceof ProviderError)
      return reply
        .code(error.retryable ? 503 : 400)
        .send({ error: error.code });
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: "Invalid request",
        issues: error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
    const status =
      error instanceof HttpError
        ? error.statusCode
        : error instanceof Error &&
            "statusCode" in error &&
            typeof error.statusCode === "number"
          ? error.statusCode
          : 500;
    return reply.code(status).send({
      error:
        status >= 500 && !(error instanceof HttpError)
          ? "Internal server error"
          : error instanceof Error
            ? error.message
            : "Request failed",
    });
  });
  app.get("/health/live", { config: { rateLimit: false } }, async () => ({
    status: "ok",
  }));
  const readiness = infrastructureReadiness();
  app.get(
    "/health/ready",
    { config: { rateLimit: false } },
    async (_r, reply) => {
      const result = await readiness.probe();
      return reply.code(result.status === "ready" ? 200 : 503).send(result);
    },
  );
  app.get("/openapi.json", async () => app.swagger());
  const sessionCookie = {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  };
  app.post(
    "/auth/register",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (r, reply) => {
      const data = register.parse(r.body);
      const userId = randomUUID();
      const hash = await hashPassword(data.password);
      const raw = token();
      try {
        await sql.begin(async (tx) => {
          await tx`INSERT INTO users(id,email,name,password_hash) VALUES (${userId},${data.email},${data.name},${hash})`;
          await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(raw)},${userId},now()+interval '7 days')`;
          await audit(tx, r, userId, "user.registered", userId);
          const verification = token();
          await tx`INSERT INTO auth_tokens(token_hash,user_id,purpose,expires_at) VALUES (${digest(verification)},${userId},'verify',now()+interval '1 hour')`;
          await queueMail(
            tx,
            data.email,
            "Verify your email",
            `Open ${config.WEB_ORIGIN}/#action=verify&token=${verification}`,
          );
        });
      } catch (e) {
        if ((e as { code?: string }).code === "23505")
          throw new HttpError(409, "Account cannot be created");
        throw e;
      }
      reply.setCookie("session", raw, sessionCookie);
      return reply.code(201).send({
        id: userId,
        email: data.email,
        name: data.name,
        verified: false,
      });
    },
  );
  app.post(
    "/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (r, reply) => {
      const data = credentials.parse(r.body);
      const [u] =
        await sql`SELECT id,email,name,password_hash,verified_at FROM users WHERE email=${data.email}`;
      const valid = await checkPassword(
        data.password,
        u?.password_hash ??
          "00000000000000000000000000000000:" + "00".repeat(64),
      );
      if (!u || !valid) throw new HttpError(401, "Invalid email or password");
      const raw = token();
      await sql.begin(async (tx) => {
        await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(raw)},${u.id},now()+interval '7 days')`;
        await audit(tx, r, u.id, "user.login", u.id);
      });
      reply.setCookie("session", raw, sessionCookie);
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        verified: !!u.verified_at,
        verificationRequired: config.REQUIRE_EMAIL_VERIFICATION,
      };
    },
  );
  app.post("/auth/logout", async (r, reply) => {
    const u = await actor(r);
    await sql.begin(async (tx) => {
      await tx`DELETE FROM sessions WHERE id_hash=${digest(r.cookies.session!)}`;
      await audit(tx, r, u.id, "user.logout", u.id);
    });
    reply.clearCookie("session", { path: "/" });
    return { ok: true };
  });
  app.get("/auth/me", async (r) => {
    const u = await actor(r);
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      verified: !!u.verified_at,
      verificationRequired: config.REQUIRE_EMAIL_VERIFICATION,
    };
  });
  app.post("/auth/verification", async (r) => {
    const u = await actor(r);
    if (!u.verified_at) await authToken(u, "verify");
    return { ok: true };
  });
  app.post("/auth/verify", async (r) => {
    const { token: raw } = tokenInput.parse(r.body);
    await sql.begin(async (tx) => {
      const [t] =
        await tx`DELETE FROM auth_tokens WHERE token_hash=${digest(raw)} AND purpose='verify' AND expires_at>now() RETURNING user_id`;
      if (!t) throw new HttpError(400, "Token expired or invalid");
      await tx`UPDATE users SET verified_at=now() WHERE id=${t.user_id}`;
      await audit(tx, r, t.user_id, "user.verified", t.user_id);
    });
    return { ok: true };
  });
  app.post(
    "/auth/password-reset/request",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (r) => {
      const { email } = emailInput.parse(r.body);
      const [u] = await sql<
        Actor[]
      >`SELECT id,email,name,verified_at FROM users WHERE email=${email}`;
      if (u) await authToken(u, "reset");
      return { ok: true };
    },
  );
  app.post("/auth/password-reset/confirm", async (r) => {
    const data = resetInput.parse(r.body);
    const hash = await hashPassword(data.password);
    await sql.begin(async (tx) => {
      const [t] =
        await tx`DELETE FROM auth_tokens WHERE token_hash=${digest(data.token)} AND purpose='reset' AND expires_at>now() RETURNING user_id`;
      if (!t) throw new HttpError(400, "Token expired or invalid");
      await tx`UPDATE users SET password_hash=${hash} WHERE id=${t.user_id}`;
      await tx`DELETE FROM sessions WHERE user_id=${t.user_id}`;
      await tx`DELETE FROM auth_tokens WHERE user_id=${t.user_id} AND purpose='reset'`;
      await audit(tx, r, t.user_id, "user.password_reset", t.user_id);
    });
    return { ok: true };
  });
  app.get("/organizations", async (r) => {
    const u = await actor(r);
    return sql`SELECT DISTINCT o.id,o.name FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE m.user_id=${u.id} ORDER BY o.name`;
  });
  app.post("/organizations", async (r, reply) => {
    const u = await actor(r);
    if (config.REQUIRE_EMAIL_VERIFICATION && !u.verified_at)
      throw new HttpError(
        403,
        "Verify your email before creating an organization",
      );
    const data = named.parse(r.body);
    const orgId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO organizations(id,name) VALUES (${orgId},${data.name})`;
      await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${orgId},${u.id},'owner')`;
      await audit(tx, r, u.id, "organization.created", orgId, orgId);
    });
    return reply.code(201).send({ id: orgId, name: data.name });
  });
  app.get("/organizations/:orgId/workspaces", async (r) => {
    const u = await actor(r);
    const orgId = id(params(r).orgId);
    return sql`SELECT w.id,w.name,w.organization_id,COALESCE(om.role,wm.role) AS role FROM workspaces w LEFT JOIN memberships om ON om.organization_id=w.organization_id AND om.workspace_id IS NULL AND om.user_id=${u.id} LEFT JOIN memberships wm ON wm.workspace_id=w.id AND wm.user_id=${u.id} WHERE w.organization_id=${orgId} AND (om.role IN ('owner','org_admin') OR wm.id IS NOT NULL) ORDER BY w.name`;
  });
  app.post("/organizations/:orgId/workspaces", async (r, reply) => {
    const u = await actor(r);
    const orgId = id(params(r).orgId);
    await organizationAccess(u.id, orgId, "workspace:create");
    const data = named.parse(r.body);
    const workspaceId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspaceId},${orgId},${data.name})`;
      await audit(
        tx,
        r,
        u.id,
        "workspace.created",
        workspaceId,
        orgId,
        workspaceId,
      );
    });
    return reply
      .code(201)
      .send({ id: workspaceId, name: data.name, organization_id: orgId });
  });
  app.get("/workspaces/:workspaceId/members", async (r) => {
    const u = await actor(r);
    const w = await workspaceAccess(u.id, id(params(r).workspaceId));
    return sql`SELECT m.id,u.name,u.email,m.role,m.workspace_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=${w.organization_id} AND (m.workspace_id=${w.id} OR (m.workspace_id IS NULL AND m.role IN ('owner','org_admin'))) ORDER BY u.name`;
  });
  app.post("/organizations/:orgId/invitations", async (r, reply) => {
    const u = await actor(r);
    const orgId = id(params(r).orgId);
    const data = invitation.parse(r.body);
    const orgRole = await organizationRole(u.id, orgId);
    if (data.workspaceId) {
      const w = await workspaceAccess(u.id, data.workspaceId, "member:invite");
      if (w.organization_id !== orgId) deny();
      if (data.role === "org_admin") deny();
    } else {
      await organizationAccess(u.id, orgId, "member:invite");
      if (!["owner", "org_admin"].includes(orgRole ?? "")) deny();
      if (data.role !== "org_admin")
        throw new HttpError(400, "Choose a workspace for this role");
    }
    const inviteId = randomUUID();
    const raw = token();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO invitations(id,organization_id,workspace_id,email,role,token_hash,expires_at) VALUES (${inviteId},${orgId},${data.workspaceId ?? null},${data.email},${data.role},${digest(raw)},now()+interval '7 days')`;
      await queueMail(
        tx,
        data.email,
        "Workspace invitation",
        `Open ${config.WEB_ORIGIN}/#action=invite&token=${raw}`,
      );
      await audit(
        tx,
        r,
        u.id,
        "member.invited",
        inviteId,
        orgId,
        data.workspaceId ?? null,
      );
    });
    return reply.code(201).send({ id: inviteId, status: "queued" });
  });
  app.post("/invitations/accept", async (r) => {
    const u = await actor(r);
    if (config.REQUIRE_EMAIL_VERIFICATION && !u.verified_at)
      throw new HttpError(403, "Verify your email first");
    const data = tokenInput.parse(r.body);
    await sql.begin(async (tx) => {
      const [inv] =
        await tx`UPDATE invitations SET accepted_at=now() WHERE token_hash=${digest(data.token)} AND email=${u.email} AND accepted_at IS NULL AND expires_at>now() RETURNING *`;
      if (!inv) throw new HttpError(400, "Invitation invalid or expired");
      await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${inv.organization_id},${inv.workspace_id},${u.id},${inv.role}) ON CONFLICT DO NOTHING`;
      await audit(
        tx,
        r,
        u.id,
        "member.joined",
        inv.id,
        inv.organization_id,
        inv.workspace_id,
      );
    });
    return { ok: true };
  });
  app.get("/workspaces/:workspaceId/secrets", async (r) => {
    const u = await actor(r);
    const w = await workspaceAccess(
      u.id,
      id(params(r).workspaceId),
      "secret:manage",
    );
    return sql`SELECT id,name,created_at FROM secrets WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} ORDER BY name`;
  });
  app.post("/workspaces/:workspaceId/secrets", async (r, reply) => {
    const u = await actor(r);
    const w = await workspaceAccess(
      u.id,
      id(params(r).workspaceId),
      "secret:manage",
    );
    const data = secretInput.parse(r.body);
    const secretId = randomUUID();
    await sql.begin(async (tx) => {
      const [saved] =
        await tx`INSERT INTO secrets(id,organization_id,workspace_id,name,ciphertext,created_by) VALUES (${secretId},${w.organization_id},${w.id},${data.name},${tx.json(encrypt(data.value, `${w.organization_id}:${w.id}:${data.name}`))},${u.id}) ON CONFLICT(workspace_id,name) DO UPDATE SET ciphertext=EXCLUDED.ciphertext RETURNING id`;
      await audit(
        tx,
        r,
        u.id,
        "secret.saved",
        saved!.id,
        w.organization_id,
        w.id,
      );
    });
    return reply.code(201).send({ name: data.name });
  });
  app.put("/workspaces/:workspaceId/secrets/:secretId", async (r) => {
    const u = await actor(r);
    const w = await workspaceAccess(
      u.id,
      id(params(r).workspaceId),
      "secret:manage",
    );
    const secretId = id(params(r).secretId);
    const data = secretInput.pick({ value: true }).parse(r.body);
    await sql.begin(async (tx) => {
      const [secret] =
        await tx`SELECT name FROM secrets WHERE id=${secretId} AND workspace_id=${w.id} AND organization_id=${w.organization_id} FOR UPDATE`;
      if (!secret) throw new HttpError(404, "Secret not found");
      await tx`UPDATE secrets SET ciphertext=${tx.json(encrypt(data.value, `${w.organization_id}:${w.id}:${secret.name}`))} WHERE id=${secretId}`;
      await audit(
        tx,
        r,
        u.id,
        "secret.updated",
        secretId,
        w.organization_id,
        w.id,
      );
    });
    return { ok: true };
  });
  app.delete("/workspaces/:workspaceId/secrets/:secretId", async (r) => {
    const u = await actor(r);
    const w = await workspaceAccess(
      u.id,
      id(params(r).workspaceId),
      "secret:manage",
    );
    const secretId = id(params(r).secretId);
    try {
      await sql.begin(async (tx) => {
        const rows =
          await tx`DELETE FROM secrets WHERE id=${secretId} AND workspace_id=${w.id} AND organization_id=${w.organization_id} RETURNING id`;
        if (!rows.length) throw new HttpError(404, "Secret not found");
        await audit(
          tx,
          r,
          u.id,
          "secret.deleted",
          secretId,
          w.organization_id,
          w.id,
        );
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23503")
        throw new HttpError(
          409,
          "Secret is in use by a model, embedding provider, or connector. Change or remove its references before deleting, or edit the secret to replace its value.",
        );
      throw error;
    }
    return { ok: true };
  });
  app.get("/workspaces/:workspaceId/audit", async (r) => {
    const u = await actor(r);
    const w = await workspaceAccess(
      u.id,
      id(params(r).workspaceId),
      "audit:view",
    );
    const query = z
      .object({ before: z.iso.datetime().optional() })
      .parse(r.query);
    return sql`SELECT id,action,entity_id,created_at,actor_id FROM audit_events WHERE organization_id=${w.organization_id} AND workspace_id=${w.id} AND created_at<${query.before ?? new Date().toISOString()} ORDER BY created_at DESC,id DESC LIMIT 100`;
  });
  app.addHook("onClose", async () => {
    await readiness.close();
    await redis.quit();
    await closeDb();
  });
  await registerKnowledgeRoutes(app, options.embeddingFactory);
  await registerToolRoutes(app);
  await registerWorkflowRoutes(app);
  await registerOperationsRoutes(app);
  await registerGenerativeRoutes(app);
  await registerChannelRoutes(app);
  await registerSupportRoutes(
    app,
    {
      actor,
      audit,
      id,
      params,
      workspaceAccess,
    },
    options.providerFactory,
    options.embeddingFactory,
  );
  await registerQualityRoutes(app);
  await registerConnectorRoutes(app, options.sharePointClientFactory);
  await registerRetentionRoutes(app);
  await registerAgentRoutes(
    app,
    options.providerFactory,
    options.embeddingFactory,
  );
  await app.ready();
  return app;
}
export async function initializeStorage() {
  const s3 = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
    },
  });
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
  } catch (e) {
    if (
      (e as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode !== 404
    )
      throw e;
    await s3.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET }));
  } finally {
    s3.destroy();
  }
}
