import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest, decrypt } from "../src/security.js";
import {
  resolveOAuthCredential,
  type OAuthHttp,
} from "../src/connector-oauth.js";
import { connectorCredentials } from "../src/connector-adapters.js";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  workspace = randomUUID(),
  owner = randomUUID(),
  outsider = randomUUID(),
  raw = randomUUID(),
  outside = randomUUID();
const saved = { ...config };
Object.assign(config, {
  CONNECTOR_OAUTH_API_ORIGIN: "http://localhost:4000",
  GOOGLE_CONNECTOR_CLIENT_ID: "fixture-google",
  GOOGLE_CONNECTOR_CLIENT_SECRET: "fixture-private",
  MICROSOFT_CONNECTOR_CLIENT_ID: randomUUID(),
  MICROSOFT_CONNECTOR_CLIENT_SECRET: "fixture-private",
  SLACK_CONNECTOR_CLIENT_ID: "fixture-slack",
  SLACK_CONNECTOR_CLIENT_SECRET: "fixture-private",
  CONNECTOR_ALLOWED_HOSTS:
    "oauth2.googleapis.com,login.microsoftonline.com,slack.com,www.googleapis.com,graph.microsoft.com",
});
let exchanges = 0,
  refreshes = 0,
  lastBody = new URLSearchParams();
const http: OAuthHttp = async (url, _headers, body) => {
  if (url.startsWith("https://www.googleapis.com/drive/v3/files"))
    return {
      status: 200,
      headers: {},
      body: (async function* () {
        yield Buffer.from(
          JSON.stringify({
            files: [{ id: "folder-fixture", name: "Product policies" }],
          }),
        );
      })(),
      close: async () => {},
    };
  assert.match(
    url,
    /^https:\/\/(oauth2.googleapis.com|login.microsoftonline.com|slack.com)\//,
  );
  lastBody = new URLSearchParams(typeof body === "string" ? body : "");
  exchanges++;
  if (lastBody.get("grant_type") === "refresh_token") refreshes++;
  const token = {
    access_token: "xoxp-fixture-access",
    refresh_token: "fixture-rotated-refresh",
    expires_in: 3600,
  };
  const data =
    url.includes("slack.com") && lastBody.get("grant_type") !== "refresh_token"
      ? { ok: true, authed_user: token }
      : token;
  return {
    status: 200,
    headers: {},
    body: (async function* () {
      yield Buffer.from(JSON.stringify(data));
    })(),
    close: async () => {},
  };
};
const app = await buildApp({ connectorOAuthHttp: http }),
  base = `/workspaces/${workspace}/connectors/oauth`;
let requestSequence = 0;
const call = (
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  foreign = false,
) =>
  app.inject({
    method,
    url,
    remoteAddress: `127.${Math.floor(Math.random() * 200) + 1}.0.${++requestSequence}`,
    headers: {
      cookie: "session=" + (foreign ? outside : raw),
      origin: config.WEB_ORIGIN,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    payload: body ? JSON.stringify(body) : undefined,
  });
before(async () => {
  await sql`INSERT INTO organizations(id,name) VALUES(${org},'OAuth test')`;
  await sql`INSERT INTO workspaces(id,organization_id,name) VALUES(${workspace},${org},'OAuth source test')`;
  for (const [uid, token] of [
    [owner, raw],
    [outsider, outside],
  ]) {
    await sql`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES(${uid!},${uid + "@example.com"},'OAuth fixture','unused',now())`;
    await sql`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(${digest(token!)},${uid!},now()+interval '1 hour')`;
  }
  await sql`INSERT INTO memberships(id,organization_id,user_id,role) VALUES(${randomUUID()},${org},${owner},'owner')`;
});
after(async () => {
  await sql`DELETE FROM connector_oauth_attempts WHERE workspace_id=${workspace}`;
  await sql`DELETE FROM audit_events WHERE workspace_id=${workspace}`;
  await sql`DELETE FROM secrets WHERE workspace_id=${workspace}`;
  await sql`DELETE FROM memberships WHERE organization_id=${org}`;
  await sql`DELETE FROM workspaces WHERE id=${workspace}`;
  await sql`DELETE FROM organizations WHERE id=${org}`;
  await sql`DELETE FROM sessions WHERE user_id IN (${owner},${outsider})`;
  await sql`DELETE FROM users WHERE id IN (${owner},${outsider})`;
  Object.assign(config, saved);
  await app.close();
  await sql.end();
});
async function start(provider = "google-drive", secretId?: string) {
  const r = await call("POST", base + "/start", {
    provider,
    ...(secretId ? { secretId } : {}),
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json() as { id: string; url: string };
}
function callback(provider: string, url: string, extra = "code=fixture-code") {
  return `/connectors/oauth/callback/${provider}?state=${new URL(url).searchParams.get("state")}&${extra}`;
}
test("Guided OAuth is tenant-bound, uses PKCE and rejects replay; encrypted credentials work with adapters", async () => {
  assert.equal(
    (await call("POST", base + "/start", { provider: "google-drive" }, true))
      .statusCode,
    403,
  );
  const attempt = await start();
  const url = new URL(attempt.url);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.ok(!attempt.url.includes("fixture-private"));
  assert.equal(
    (await call("GET", callback("google-drive", attempt.url), undefined, true))
      .statusCode,
    400,
  );
  const done = await call("GET", callback("google-drive", attempt.url));
  assert.equal(done.statusCode, 200, done.body);
  assert.ok(lastBody.has("code_verifier"));
  assert.equal(done.headers["cache-control"], "no-store");
  const status = await call("GET", base + "/" + attempt.id);
  assert.equal(status.json().status, "connected");
  assert.ok(!status.body.includes("fixture-access"));
  assert.equal(
    (await call("GET", callback("google-drive", attempt.url))).statusCode,
    400,
  );
  const credential = await connectorCredentials(
    {
      secret_id: status.json().secret_id,
      workspace_id: workspace,
      organization_id: org,
    },
    "google-drive",
  );
  assert.ok("auth" in credential && credential.auth === "oauth");
  const [s] =
    await sql`SELECT * FROM secrets WHERE id=${status.json().secret_id}`;
  assert.ok(!JSON.stringify(s!.ciphertext).includes("fixture-access"));
});
test("Consent denial, expiration and provider mismatch expose safe failures without exchanging codes", async () => {
  const attempt = await start(),
    count = exchanges;
  assert.equal(
    (
      await call(
        "GET",
        callback("google-drive", attempt.url, "error=access_denied"),
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (await call("GET", base + "/" + attempt.id)).json().error_code,
    "CONNECTOR_CONSENT_DENIED",
  );
  assert.equal(exchanges, count);
  const expired = await start();
  await sql`UPDATE connector_oauth_attempts SET expires_at=now()-interval '1 minute' WHERE id=${expired.id}`;
  assert.equal(
    (await call("GET", callback("google-drive", expired.url))).statusCode,
    400,
  );
  assert.equal(
    (await call("GET", base + "/" + expired.id)).json().status,
    "expired",
  );
  const mismatch = await start();
  assert.equal(
    (await call("GET", callback("slack", mismatch.url))).statusCode,
    400,
  );
});
test("Refresh rotation is serialized and reconnect preserves the selected secret identity", async () => {
  const attempt = await start();
  await call("GET", callback("google-drive", attempt.url));
  const result = (await call("GET", base + "/" + attempt.id)).json(),
    secretId = result.secret_id;
  const [{ encrypt }] = await Promise.all([import("../src/security.js")]);
  const [s] = await sql`SELECT * FROM secrets WHERE id=${secretId}`;
  const context = `${org}:${workspace}:${s!.name}`;
  const value = JSON.parse(decrypt(s!.ciphertext, context));
  value.expiresAt = Date.now() - 1000;
  await sql`UPDATE secrets SET ciphertext=${sql.json(encrypt(JSON.stringify(value), context))} WHERE id=${secretId}`;
  const [stale] =
    await sql`SELECT id,name,ciphertext FROM secrets WHERE id=${secretId}`;
  const before = refreshes;
  await Promise.all([
    resolveOAuthCredential(
      stale as Parameters<typeof resolveOAuthCredential>[0],
      context,
      "google-drive",
      http,
    ),
    resolveOAuthCredential(
      stale as Parameters<typeof resolveOAuthCredential>[0],
      context,
      "google-drive",
      http,
    ),
  ]);
  assert.equal(refreshes, before + 1);
  await assert.rejects(() =>
    resolveOAuthCredential(
      stale as Parameters<typeof resolveOAuthCredential>[0],
      context,
      "teams",
      http,
    ),
  );
  const reconnect = await start("google-drive", secretId);
  await call("GET", callback("google-drive", reconnect.url));
  assert.equal(
    (await call("GET", base + "/" + reconnect.id)).json().secret_id,
    secretId,
  );
});
test("Microsoft delegated and Slack user authorization use matching endpoints and return reusable credentials", async () => {
  for (const provider of ["onedrive", "sharepoint", "teams", "slack"]) {
    const attempt = await start(provider),
      url = new URL(attempt.url);
    assert.ok(
      provider === "slack"
        ? url.searchParams.has("user_scope")
        : url.searchParams.get("scope")?.includes("offline_access"),
    );
    assert.equal(
      (await call("GET", callback(provider, attempt.url))).statusCode,
      200,
    );
    const status = (await call("GET", base + "/" + attempt.id)).json();
    const credential = await connectorCredentials(
      {
        secret_id: status.secret_id,
        workspace_id: workspace,
        organization_id: org,
      },
      provider,
    );
    assert.equal(
      provider === "slack" && "token" in credential
        ? credential.token
        : "auth" in credential
          ? credential.auth
          : undefined,
      provider === "slack" ? "xoxp-fixture-access" : "oauth",
    );
  }
});

test("Source discovery lists folder names without leaking tokens and enforces source-account access", async () => {
  const attempt = await start();
  await call("GET", callback("google-drive", attempt.url));
  const status = (await call("GET", base + "/" + attempt.id)).json();
  const response = await call(
    "POST",
    `/workspaces/${workspace}/connectors/browse`,
    { provider: "google-drive", secretId: status.secret_id },
  );
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().items[0].name, "Product policies");
  assert.ok(!response.body.includes("fixture-access"));
  assert.equal(
    (
      await call(
        "POST",
        `/workspaces/${workspace}/connectors/browse`,
        { provider: "google-drive", secretId: status.secret_id },
        true,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call("POST", `/workspaces/${workspace}/connectors/browse`, {
        provider: "google-drive",
        secretId: status.secret_id,
        folderId: "bad' or 1=1",
      })
    ).statusCode,
    400,
  );
});

test("Delegated adapter authentication uses the OAuth access token rather than application/service credentials", async () => {
  const { createMicrosoftGraphClient } =
    await import("../src/microsoft-graph-client.js");
  const { createGoogleDriveAdapter } =
    await import("../src/google-drive-adapter.js");
  let requests = 0;
  const protocol: OAuthHttp = async (url, headers, _body, _signal, method) => {
    assert.equal(method, "GET");
    assert.equal(headers.authorization, "Bearer delegated-fixture");
    requests++;
    const data = url.includes("/files/folder")
      ? {
          id: "folder",
          name: "Policies",
          mimeType: "application/vnd.google-apps.folder",
          version: "1",
          modifiedTime: "2026-10-01T00:00:00Z",
          parents: [],
          trashed: false,
        }
      : url.includes("/files?")
        ? { files: [] }
        : { id: "business-drive" };
    return {
      status: 200,
      headers: {},
      body: (async function* () {
        yield Buffer.from(JSON.stringify(data));
      })(),
      close: async () => {},
    };
  };
  const credential = {
    auth: "oauth" as const,
    provider: "onedrive" as const,
    accessToken: "delegated-fixture",
    tenantId: "organizations",
  };
  const graph = createMicrosoftGraphClient(credential, protocol);
  assert.deepEqual(
    await graph.json(
      "https://graph.microsoft.com/v1.0/me/drive",
      AbortSignal.timeout(1000),
    ),
    { id: "business-drive" },
  );
  graph.close();
  const drive = createGoogleDriveAdapter(
    { folderId: "folder", recursive: true, maxObjects: 100 },
    { ...credential, provider: "google-drive" },
    protocol,
  );
  assert.deepEqual(await drive.list(AbortSignal.timeout(1000)), []);
  drive.close();
  assert.equal(requests, 4);
});
