import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { digest } from "../src/security.js";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const app = await buildApp(),
  user = randomUUID(),
  raw = randomUUID(),
  invitedOrg = randomUUID(),
  invitation = randomUUID();
const organizations = [invitedOrg],
  original = config.REQUIRE_EMAIL_VERIFICATION;
async function call(method: "GET" | "POST", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: {
      cookie: "session=" + raw,
      origin: config.WEB_ORIGIN,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
}
after(async () => {
  config.REQUIRE_EMAIL_VERIFICATION = original;
  await sql.begin(async (tx) => {
    await tx`DELETE FROM audit_events WHERE actor_id=${user}`;
    await tx`DELETE FROM invitations WHERE organization_id=ANY(${organizations})`;
    await tx`DELETE FROM memberships WHERE user_id=${user}`;
    await tx`DELETE FROM organizations WHERE id=ANY(${organizations})`;
    await tx`DELETE FROM users WHERE id=${user}`;
  });
  await app.close();
});
test("Development verification bypass unblocks existing accounts without marking email verified", async () => {
  await sql`INSERT INTO users(id,email,name,password_hash) VALUES (${user},${user + "@example.com"},'Unverified fixture','unused-fixture')`;
  await sql`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(raw)},${user},now()+interval '1 hour')`;
  await sql`INSERT INTO organizations(id,name) VALUES (${invitedOrg},'Verification fixture')`;
  await sql`INSERT INTO invitations(id,organization_id,email,role,token_hash,expires_at) VALUES (${randomUUID()},${invitedOrg},${user + "@example.com"},'viewer',${digest(invitation)},now()+interval '1 hour')`;
  config.REQUIRE_EMAIL_VERIFICATION = true;
  assert.equal(
    (await call("POST", "/organizations", { name: "Blocked" })).statusCode,
    403,
  );
  assert.equal(
    (await call("POST", "/invitations/accept", { token: invitation }))
      .statusCode,
    403,
  );
  assert.equal(
    (await call("GET", "/auth/me")).json().verificationRequired,
    true,
  );
  config.REQUIRE_EMAIL_VERIFICATION = false;
  const me = (await call("GET", "/auth/me")).json();
  assert.equal(me.verificationRequired, false);
  assert.equal(me.verified, false);
  const created = await call("POST", "/organizations", {
    name: "Development allowed",
  });
  assert.equal(created.statusCode, 201, created.body);
  organizations.push(created.json().id);
  assert.equal(
    (await call("POST", "/invitations/accept", { token: invitation }))
      .statusCode,
    200,
  );
  const [row] = await sql`SELECT verified_at FROM users WHERE id=${user}`;
  assert.equal(row!.verified_at, null);
  config.REQUIRE_EMAIL_VERIFICATION = true;
  assert.equal(
    (await call("POST", "/organizations", { name: "Blocked again" }))
      .statusCode,
    403,
  );
});
test("Production rejects a disabled verification requirement", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/config.ts"],
    {
      env: {
        ...process.env,
        NODE_ENV: "production",
        WEB_ORIGIN: "https://example.com",
        REQUIRE_EMAIL_VERIFICATION: "false",
      },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Production requires email verification/);
});
