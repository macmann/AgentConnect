import { randomUUID, randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { safeHttpTransport } from "@agentconnect/provider-sdk";
import {
  oauthProvider,
  oauthAccessCredential,
} from "@agentconnect/schemas/connectors";
import { actor, workspaceAccess, params, id, audit } from "./app.js";
import { config } from "./config.js";
import { sql } from "./db.js";
import { digest, encrypt, decrypt } from "./security.js";
import { HttpError } from "./http-error.js";
import {
  ConnectorError,
  validateConnectorEndpoint,
} from "./connector-adapters.js";
import { hosts } from "./knowledge-core.js";
type Provider = z.infer<typeof oauthProvider>;
export type OAuthHttp = ReturnType<typeof safeHttpTransport>;
const envelope = z.object({
  auth: z.literal("oauth"),
  provider: oauthProvider,
  accessToken: z.string().min(1).max(30000),
  refreshToken: z.string().max(30000),
  expiresAt: z.number(),
  tenantId: z.string(),
});
export function oauthSettings(provider: Provider) {
  const google = provider === "google-drive",
    slack = provider === "slack";
  const origin = config.CONNECTOR_OAUTH_API_ORIGIN;
  if (!origin)
    throw new HttpError(
      409,
      "Administrator setup required: configure CONNECTOR_OAUTH_API_ORIGIN and the provider OAuth app credentials.",
    );
  const u = new URL(origin);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/" ||
    (u.protocol !== "https:" &&
      !(
        config.NODE_ENV !== "production" &&
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(u.hostname)
      ))
  )
    throw new HttpError(
      409,
      "OAuth API origin must use HTTPS (localhost HTTP is permitted in development).",
    );
  const clientId = google
    ? config.GOOGLE_CONNECTOR_CLIENT_ID
    : slack
      ? config.SLACK_CONNECTOR_CLIENT_ID
      : config.MICROSOFT_CONNECTOR_CLIENT_ID;
  const clientSecret = google
    ? config.GOOGLE_CONNECTOR_CLIENT_SECRET
    : slack
      ? config.SLACK_CONNECTOR_CLIENT_SECRET
      : config.MICROSOFT_CONNECTOR_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw new HttpError(
      409,
      "Administrator setup required: configure this provider's connector OAuth client ID and secret.",
    );
  const tenant = config.MICROSOFT_CONNECTOR_TENANT;
  return {
    clientId,
    clientSecret,
    redirectUri: u.origin + "/connectors/oauth/callback/" + provider,
    authorization: google
      ? "https://accounts.google.com/o/oauth2/v2/auth"
      : slack
        ? "https://slack.com/oauth/v2/authorize"
        : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    token: google
      ? "https://oauth2.googleapis.com/token"
      : slack
        ? "https://slack.com/api/oauth.v2.access"
        : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    scope: google
      ? "https://www.googleapis.com/auth/drive.readonly"
      : slack
        ? "channels:read,channels:history,groups:read,groups:history"
        : provider === "teams"
          ? "offline_access User.Read Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Read.All"
          : "offline_access Files.Read.All Sites.Read.All",
  };
}
function transport(): OAuthHttp {
  return safeHttpTransport(
    hosts(config.CONNECTOR_ALLOWED_HOSTS),
    hosts(config.CONNECTOR_PRIVATE_HOSTS),
  );
}
async function tokenRequest(
  provider: Provider,
  body: Record<string, string>,
  http: OAuthHttp,
) {
  const settings = oauthSettings(provider);
  validateConnectorEndpoint(settings.token);
  const response = await http(
    settings.token,
    { "content-type": "application/x-www-form-urlencoded" },
    new URLSearchParams({
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      ...body,
    }).toString(),
    AbortSignal.timeout(30000),
    "POST",
  );
  try {
    let size = 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 100000)
        throw new ConnectorError("CONNECTOR_OAUTH_RESPONSE_INVALID");
      chunks.push(chunk);
    }
    if (response.status !== 200)
      throw new ConnectorError("CONNECTOR_RECONNECT_REQUIRED");
    const result = JSON.parse(Buffer.concat(chunks).toString()) as Record<
      string,
      unknown
    >;
    if (result.error || result.ok === false)
      throw new ConnectorError("CONNECTOR_RECONNECT_REQUIRED");
    const data =
      provider === "slack" && body.grant_type !== "refresh_token"
        ? result.authed_user
        : result;
    const parsed = z
      .object({
        access_token: z.string().min(1).max(30000),
        refresh_token: z.string().max(30000).optional(),
        expires_in: z.number().int().min(1).max(31536000).optional(),
      })
      .parse(data);
    if (provider !== "slack" && !parsed.expires_in)
      throw new ConnectorError("CONNECTOR_OAUTH_RESPONSE_INVALID");
    if (
      provider !== "slack" &&
      !parsed.refresh_token &&
      body.grant_type !== "refresh_token"
    )
      throw new ConnectorError("CONNECTOR_OFFLINE_ACCESS_REQUIRED");
    return parsed;
  } catch (e) {
    if (e instanceof ConnectorError) throw e;
    throw new ConnectorError("CONNECTOR_OAUTH_RESPONSE_INVALID");
  } finally {
    await response.close();
  }
}
export async function resolveOAuthCredential(
  secret: { id: string; name: string; ciphertext: ReturnType<typeof encrypt> },
  context: string,
  kind: string,
  http: OAuthHttp = transport(),
) {
  const original = envelope.parse(
    JSON.parse(decrypt(secret.ciphertext, context)),
  );
  if (original.provider !== kind)
    throw new ConnectorError("CONNECTOR_CREDENTIAL_INVALID");
  // Lock serializes refresh-token rotation across API and worker processes.
  return sql.begin(async (tx) => {
    const [row] =
      await tx`SELECT ciphertext FROM secrets WHERE id=${secret.id} FOR UPDATE`;
    if (!row) throw new ConnectorError("CONNECTOR_CREDENTIAL_UNAVAILABLE");
    const credential = envelope.parse(
      JSON.parse(decrypt(row.ciphertext, context)),
    );
    if (credential.provider !== kind)
      throw new ConnectorError("CONNECTOR_CREDENTIAL_INVALID");
    if (credential.expiresAt && credential.expiresAt < Date.now() + 60000) {
      if (!credential.refreshToken)
        throw new ConnectorError("CONNECTOR_RECONNECT_REQUIRED");
      const result = await tokenRequest(
        credential.provider,
        { grant_type: "refresh_token", refresh_token: credential.refreshToken },
        http,
      );
      credential.accessToken = result.access_token;
      credential.refreshToken = result.refresh_token ?? credential.refreshToken;
      credential.expiresAt = Date.now() + (result.expires_in ?? 3600) * 1000;
      await tx`UPDATE secrets SET ciphertext=${tx.json(encrypt(JSON.stringify(credential), context))} WHERE id=${secret.id}`;
    }
    return oauthAccessCredential.parse(credential);
  });
}
export async function registerConnectorOAuth(
  app: FastifyInstance,
  http: OAuthHttp = transport(),
) {
  const base = "/workspaces/:workspaceId/connectors/oauth";
  app.get(base + "/providers", async (r) => {
    const u = await actor(r);
    await workspaceAccess(u.id, id(params(r).workspaceId), "connector:manage");
    return oauthProvider.options.map((provider) => {
      try {
        const settings = oauthSettings(provider);
        return { provider, ready: true, redirectUri: settings.redirectUri };
      } catch {
        return { provider, ready: false };
      }
    });
  });
  app.post(
    base + "/start",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (r) => {
      const u = await actor(r),
        w = await workspaceAccess(
          u.id,
          id(params(r).workspaceId),
          "connector:manage",
        );
      const { provider, secretId } = z
        .object({ provider: oauthProvider, secretId: z.uuid().optional() })
        .strict()
        .parse(r.body);
      const settings = oauthSettings(provider);
      validateConnectorEndpoint(settings.token);
      if (secretId) {
        const [s] =
          await sql`SELECT id,name,ciphertext FROM secrets WHERE id=${secretId} AND workspace_id=${w.id} AND organization_id=${w.organization_id}`;
        if (!s) throw new HttpError(404, "Credential unavailable");
        const saved = envelope.safeParse(
          JSON.parse(
            decrypt(s.ciphertext, `${w.organization_id}:${w.id}:${s.name}`),
          ),
        );
        if (!saved.success || saved.data.provider !== provider)
          throw new HttpError(
            409,
            "Select an OAuth credential for this provider to reconnect. Legacy credentials can be replaced by editing the connector after signing in.",
          );
      }
      const attemptId = randomUUID(),
        state = randomBytes(32).toString("base64url"),
        verifier = randomBytes(32).toString("base64url");
      await sql`DELETE FROM connector_oauth_attempts WHERE expires_at<now()-interval '1 day'`;
      await sql`INSERT INTO connector_oauth_attempts(id,workspace_id,organization_id,user_id,provider,state_hash,verifier,secret_id,expires_at) VALUES(${attemptId},${w.id},${w.organization_id},${u.id},${provider},${digest(state)},${sql.json(encrypt(verifier, attemptId))},${secretId ?? null},now()+interval '10 minutes')`;
      const query = new URLSearchParams({
        client_id: settings.clientId,
        redirect_uri: settings.redirectUri,
        response_type: "code",
        state,
      });
      if (provider === "slack") query.set("user_scope", settings.scope);
      else {
        query.set("scope", settings.scope);
        query.set(
          "code_challenge",
          createHash("sha256").update(verifier).digest("base64url"),
        );
        query.set("code_challenge_method", "S256");
      }
      if (provider === "google-drive") {
        query.set("access_type", "offline");
        query.set("prompt", "consent");
      }
      return { id: attemptId, url: settings.authorization + "?" + query };
    },
  );
  app.get(base + "/:attemptId", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "connector:manage",
      );
    const [attempt] =
      await sql`SELECT status,secret_id,error_code,expires_at FROM connector_oauth_attempts WHERE id=${id(params(r).attemptId)} AND workspace_id=${w.id} AND user_id=${u.id}`;
    if (!attempt) throw new HttpError(404, "Sign-in unavailable");
    return {
      ...attempt,
      status:
        new Date(attempt.expires_at).getTime() < Date.now() &&
        attempt.status !== "connected"
          ? "expired"
          : attempt.status,
    };
  });
  app.get("/connectors/oauth/callback/:provider", async (r, reply) => {
    reply
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .header(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      );
    const provider = oauthProvider.parse(params(r).provider),
      query = z
        .object({
          state: z.string().min(1).max(200),
          code: z.string().max(10000).optional(),
          error: z.string().max(200).optional(),
        })
        .parse(r.query);
    const u = await actor(r);
    const [found] =
      await sql`SELECT * FROM connector_oauth_attempts WHERE state_hash=${digest(query.state)} AND provider=${provider} AND user_id=${u.id} AND status='pending' AND expires_at>now()`;
    if (!found)
      throw new HttpError(400, "Sign-in expired or already used. Start again.");
    await workspaceAccess(u.id, found.workspace_id, "connector:manage");
    const [attempt] =
      await sql`UPDATE connector_oauth_attempts SET status='exchanging' WHERE id=${found.id} AND status='pending' AND expires_at>now() RETURNING *`;
    if (!attempt)
      throw new HttpError(400, "Sign-in already used. Start again.");
    try {
      if (query.error || !query.code)
        throw new ConnectorError("CONNECTOR_CONSENT_DENIED");
      const settings = oauthSettings(provider),
        result = await tokenRequest(
          provider,
          {
            code: query.code,
            redirect_uri: settings.redirectUri,
            grant_type: "authorization_code",
            ...(provider === "slack"
              ? {}
              : { code_verifier: decrypt(attempt.verifier, attempt.id) }),
          },
          http,
        );
      await sql.begin(async (tx) => {
        await workspaceAccess(u.id, attempt.workspace_id, "connector:manage");
        const secretId = attempt.secret_id ?? randomUUID();
        const [existing] = attempt.secret_id
          ? await tx`SELECT name FROM secrets WHERE id=${secretId} AND workspace_id=${attempt.workspace_id} AND organization_id=${attempt.organization_id} FOR UPDATE`
          : [];
        if (attempt.secret_id && !existing)
          throw new ConnectorError("CONNECTOR_CREDENTIAL_UNAVAILABLE");
        const name =
          existing?.name ??
          `OAUTH_${provider.replaceAll("-", "_").toUpperCase()}_${secretId.slice(0, 8).toUpperCase()}`;
        const value = envelope.parse({
          auth: "oauth",
          provider,
          accessToken: result.access_token,
          refreshToken: result.refresh_token ?? "",
          expiresAt: result.expires_in
            ? Date.now() + result.expires_in * 1000
            : 0,
          tenantId: config.MICROSOFT_CONNECTOR_TENANT,
        });
        const cipher = encrypt(
          JSON.stringify(value),
          `${attempt.organization_id}:${attempt.workspace_id}:${name}`,
        );
        if (existing)
          await tx`UPDATE secrets SET ciphertext=${tx.json(cipher)} WHERE id=${secretId}`;
        else
          await tx`INSERT INTO secrets(id,organization_id,workspace_id,name,ciphertext,created_by) VALUES(${secretId},${attempt.organization_id},${attempt.workspace_id},${name},${tx.json(cipher)},${u.id})`;
        await tx`UPDATE connector_oauth_attempts SET status='connected',secret_id=${secretId} WHERE id=${attempt.id}`;
        await audit(
          tx,
          r,
          u.id,
          "connector.oauth_connected",
          secretId,
          attempt.organization_id,
          attempt.workspace_id,
        );
      });
      return reply
        .type("text/html")
        .send(
          "<!doctype html><title>Source connected</title><main><h1>Source connected</h1><p>Return to Agent Connex to select the folder or channel to synchronize. You can close this window.</p></main>",
        );
    } catch (error) {
      const code =
        error instanceof ConnectorError ? error.code : "CONNECTOR_OAUTH_FAILED";
      await sql`UPDATE connector_oauth_attempts SET status='failed',error_code=${code} WHERE id=${attempt.id}`;
      r.log.warn({ provider, code }, "Knowledge connector sign-in failed");
      return reply
        .code(400)
        .type("text/html")
        .send(
          "<!doctype html><title>Sign-in failed</title><main><h1>Unable to connect</h1><p>Return to Agent Connex for details and try signing in again.</p></main>",
        );
    }
  });
}
