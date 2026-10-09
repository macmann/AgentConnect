import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp, initializeStorage } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { encrypt, decrypt, digest } from "../src/security.js";
import { permitted } from "@agentconnect/schemas/foundation";
if (config.NODE_ENV === "production")
  throw new Error("Integration tests refuse production mode");
process.env.NODE_ENV = "test";
const app = await buildApp();
const suffix = randomUUID();
const emails = [
  `owner-${suffix}@example.com`,
  `viewer-${suffix}@example.com`,
  `outsider-${suffix}@example.com`,
];
const password = "test-strong-password-123";
let owner = "",
  viewer = "",
  outsider = "",
  orgId = "",
  workspaceId = "";
async function call(
  method: "GET" | "POST" | "DELETE",
  url: string,
  body?: unknown,
  session = "",
) {
  return app.inject({
    method,
    url,
    headers: {
      origin: config.WEB_ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(session ? { cookie: session } : {}),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function deliveredLink(email: string, subject: string): Promise<URL> {
  const [mail] =
    await sql`SELECT id,encrypted_body FROM mail_outbox WHERE recipient=${email} AND subject=${subject} ORDER BY created_at DESC LIMIT 1`;
  if (mail?.encrypted_body.version)
    return new URL(decrypt(mail.encrypted_body, mail.id).split("Open ")[1]!);
  // A running development worker may already have delivered and erased the body.
  const inbox = (await (
    await fetch("http://localhost:8025/api/v1/messages")
  ).json()) as {
    messages: { ID: string; Subject: string; To: { Address: string }[] }[];
  };
  const item = inbox.messages.find(
    (m) => m.Subject === subject && m.To.some((t) => t.Address === email),
  );
  assert.ok(item, "Expected test email in local SMTP inbox");
  const message = (await (
    await fetch(`http://localhost:8025/api/v1/message/${item.ID}`)
  ).json()) as { Text: string };
  return new URL(message.Text.split("Open ")[1]!.trim());
}
async function signup(email: string) {
  const res = await call("POST", "/auth/register", {
    name: "Test member",
    email,
    password,
  });
  assert.equal(res.statusCode, 201);
  const session = String(res.headers["set-cookie"]).split(";")[0]!;
  const [u] = await sql`SELECT id FROM users WHERE email=${email}`;
  const url = await deliveredLink(email, "Verify your email");
  const verify = await call("POST", "/auth/verify", {
    token: new URLSearchParams(url.hash.slice(1) || url.search).get("token"),
  });
  assert.equal(verify.statusCode, 200);
  assert.ok(u);
  return session;
}
before(async () => {
  await initializeStorage();
  owner = await signup(emails[0]!);
  viewer = await signup(emails[1]!);
  outsider = await signup(emails[2]!);
});
after(async () => {
  await sql.begin(async (tx) => {
    const users = await tx`SELECT id FROM users WHERE email=ANY(${emails})`;
    const ids = users.map((u) => u.id);
    if (orgId) {
      await tx`DELETE FROM audit_events WHERE organization_id=${orgId}`;
      await tx`DELETE FROM secrets WHERE organization_id=${orgId}`;
      await tx`DELETE FROM invitations WHERE organization_id=${orgId}`;
      await tx`DELETE FROM memberships WHERE organization_id=${orgId}`;
      await tx`DELETE FROM workspaces WHERE organization_id=${orgId}`;
      await tx`DELETE FROM organizations WHERE id=${orgId}`;
    }
    await tx`DELETE FROM audit_events WHERE actor_id=ANY(${ids})`;
    await tx`DELETE FROM mail_outbox WHERE recipient=ANY(${emails})`;
    await tx`DELETE FROM users WHERE id=ANY(${ids})`;
  });
  await app.close();
  await sql.end();
});
test("real infrastructure readiness", async () => {
  const res = await call("GET", "/health/ready");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().services, [
    "postgres",
    "redis",
    "storage",
    "temporal",
  ]);
});
test("authentication rejects invalid password and missing session", async () => {
  assert.equal(
    (
      await call("POST", "/auth/login", {
        email: emails[0],
        password: "wrong-long-password",
      })
    ).statusCode,
    401,
  );
  assert.equal((await call("GET", "/organizations")).statusCode, 401);
});
test("writes require trusted origin", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/organizations",
    headers: { cookie: owner, origin: "https://evil.example" },
    payload: { name: "Bad" },
  });
  assert.equal(res.statusCode, 403);
});
test("owner creates persisted organization and workspace", async () => {
  const org = await call(
    "POST",
    "/organizations",
    { name: "Integration organization" },
    owner,
  );
  assert.equal(org.statusCode, 201);
  orgId = org.json().id;
  const w = await call(
    "POST",
    `/organizations/${orgId}/workspaces`,
    { name: "Integration workspace" },
    owner,
  );
  assert.equal(w.statusCode, 201);
  workspaceId = w.json().id;
  const list = await call(
    "GET",
    `/organizations/${orgId}/workspaces`,
    undefined,
    owner,
  );
  assert.equal(list.json()[0].id, workspaceId);
});
test("cross-tenant access denied at server boundary", async () => {
  assert.equal(
    (
      await call(
        "GET",
        `/workspaces/${workspaceId}/members`,
        undefined,
        outsider,
      )
    ).statusCode,
    403,
  );
  assert.deepEqual(
    (
      await call(
        "GET",
        `/organizations/${orgId}/workspaces`,
        undefined,
        outsider,
      )
    ).json(),
    [],
  );
  assert.equal(
    (
      await call(
        "POST",
        `/organizations/${orgId}/workspaces`,
        { name: "Injected" },
        outsider,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "GET",
        `/workspaces/${workspaceId}/secrets`,
        undefined,
        outsider,
      )
    ).statusCode,
    403,
  );
});
test("invitation is email-bound, one-time, and grants limited workspace membership", async () => {
  const inv = await call(
    "POST",
    `/organizations/${orgId}/invitations`,
    { email: emails[1], role: "viewer", workspaceId },
    owner,
  );
  assert.equal(inv.statusCode, 201);
  assert.equal(inv.json().token, undefined);
  const raw = new URLSearchParams(
    (await deliveredLink(emails[1]!, "Workspace invitation")).hash.slice(1),
  ).get("token");
  assert.equal(
    (await call("POST", "/invitations/accept", { token: raw }, outsider))
      .statusCode,
    400,
  );
  assert.equal(
    (await call("POST", "/invitations/accept", { token: raw }, viewer))
      .statusCode,
    200,
  );
  assert.equal(
    (await call("POST", "/invitations/accept", { token: raw }, viewer))
      .statusCode,
    400,
  );
  assert.equal(
    (await call("GET", `/workspaces/${workspaceId}/members`, undefined, viewer))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/workspaces/${workspaceId}/secrets`,
        { name: "NO_ACCESS", value: "blocked" },
        viewer,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/organizations/${orgId}/invitations`,
        { email: emails[2], role: "org_admin" },
        viewer,
      )
    ).statusCode,
    403,
  );
});
test("secrets are encrypted with tenant-bound context and never returned", async () => {
  const value = "integration-secret-plaintext";
  const res = await call(
    "POST",
    `/workspaces/${workspaceId}/secrets`,
    { name: "TEST_KEY", value },
    owner,
  );
  assert.equal(res.statusCode, 201);
  const [row] =
    await sql`SELECT * FROM secrets WHERE workspace_id=${workspaceId}`;
  assert.ok(row);
  assert.ok(!JSON.stringify(row.ciphertext).includes(value));
  assert.equal(
    decrypt(row.ciphertext, `${orgId}:${workspaceId}:TEST_KEY`),
    value,
  );
  assert.throws(() => decrypt(row.ciphertext, "another-tenant"));
  const list = await call(
    "GET",
    `/workspaces/${workspaceId}/secrets`,
    undefined,
    owner,
  );
  assert.ok(!list.body.includes(value));
  assert.equal(list.json()[0].ciphertext, undefined);
  assert.equal(
    (
      await call(
        "DELETE",
        `/workspaces/${workspaceId}/secrets/${row.id}`,
        undefined,
        outsider,
      )
    ).statusCode,
    403,
  );
});
test("audits record changes without plaintext secrets", async () => {
  const res = await call(
    "GET",
    `/workspaces/${workspaceId}/audit`,
    undefined,
    owner,
  );
  assert.equal(res.statusCode, 200);
  assert.ok(
    res.json().some((e: { action: string }) => e.action === "secret.saved"),
  );
  assert.ok(!res.body.includes("integration-secret-plaintext"));
});
test("envelope encryption authenticates data and capabilities deny by default", () => {
  const encrypted = encrypt("private", "tenant");
  assert.equal(decrypt(encrypted, "tenant"), "private");
  encrypted.value.data = "00";
  assert.throws(() => decrypt(encrypted, "tenant"));
  assert.equal(permitted("viewer", "secret:manage"), false);
  assert.equal(permitted("workspace_admin", "workspace:create"), false);
});
test("password reset is one-time and revokes existing sessions", async () => {
  await call("POST", "/auth/password-reset/request", { email: emails[2] });
  const raw = new URLSearchParams(
    (await deliveredLink(emails[2]!, "Reset your password")).hash.slice(1),
  ).get("token");
  const res = await call("POST", "/auth/password-reset/confirm", {
    token: raw,
    password: "replacement-strong-password",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(
    (await call("GET", "/auth/me", undefined, outsider)).statusCode,
    401,
  );
  assert.equal(
    (
      await call("POST", "/auth/password-reset/confirm", {
        token: raw,
        password,
      })
    ).statusCode,
    400,
  );
  const [s] =
    await sql`SELECT id_hash FROM sessions WHERE id_hash=${digest(outsider.replace("session=", ""))}`;
  assert.equal(s, undefined);
});
