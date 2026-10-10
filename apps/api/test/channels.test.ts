import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { digest } from "../src/security.js";
import { config } from "../src/config.js";
import { widgetSettings } from "@agentconnect/schemas/channels";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  workspace = randomUUID();
const sessions: Record<string, string> = {},
  users: Record<string, string> = {};
let agent = "",
  deployment = "",
  conversation = "",
  token = "",
  privateConversation = "";
const allowed = "https://customer.example.com",
  second = "https://second.example.com";
const app = await buildApp({
  providerFactory: () => ({
    async *stream() {
      yield { type: "token", text: "Channel fixture" };
      yield { type: "usage", inputTokens: 10, outputTokens: 3 };
    },
  }),
});
async function call(
  method: "GET" | "POST" | "PUT" | "OPTIONS",
  url: string,
  body?: unknown,
  role = "owner",
  origin: string | undefined = config.WEB_ORIGIN,
  bearer?: string,
) {
  return app.inject({
    method,
    url,
    headers: {
      ...(origin ? { origin } : {}),
      ...(role ? { cookie: sessions[role] } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...(bearer ? { authorization: "Bearer " + bearer } : {}),
      ...(method === "OPTIONS"
        ? {
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type,authorization",
          }
        : {}),
    },
    payload: body ? JSON.stringify(body) : undefined,
  });
}
function meta(body: string) {
  return JSON.parse(
    body
      .split("\n\n")
      .find((s) => s.startsWith("event: meta"))!
      .split("\ndata: ")[1]!,
  );
}
before(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Channel fixtures')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Channel workspace')`;
    await tx`INSERT INTO support_policies(id,organization_id,workspace_id,scope,target_id,policy) VALUES (${randomUUID()},${org},${workspace},'workspace',${workspace},${tx.json({ humanEntryMode: "always_available", aiTriageEnabled: false, generateHandoffSummary: false })})`;
    for (const role of ["owner", "operator", "analyst", "outsider"]) {
      const u = randomUUID(),
        raw = randomUUID();
      users[role] = u;
      sessions[role] = "session=" + raw;
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${u},${u + "@example.com"},${role},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(raw)},${u},now()+interval '1 hour')`;
      if (role !== "outsider")
        await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${role === "owner" ? null : workspace},${u},${role})`;
    }
  });
  const m = await call("POST", `/workspaces/${workspace}/models`, {
    name: "Channel fixture",
    provider: "openai-compatible",
    modelId: "fixture",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.equal(m.statusCode, 201, m.body);
  const a = await call("POST", `/workspaces/${workspace}/agents`, {
    name: "Channel agent",
    config: { modelId: m.json().id },
  });
  assert.equal(a.statusCode, 201);
  agent = a.json().id;
  const v = await call("POST", `/agents/${agent}/publish`, { revision: 1 });
  assert.equal(v.statusCode, 201);
  const d = await call("POST", `/agents/${agent}/deployments`, {
    name: "Channel deployment",
    versionId: v.json().id,
  });
  assert.equal(d.statusCode, 201);
  deployment = d.json().id;
});
after(async () => {
  await sql.begin(async (tx) => {
    for (const table of [
      "handoff_events",
      "messages",
      "agent_runs",
      "conversations",
      "deployments",
      "agent_versions",
      "agents",
      "model_configurations",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    for (const u of Object.values(users))
      await tx`DELETE FROM users WHERE id=${u}`;
  });
  await app.close();
});
test("Widget settings reject unsafe origins and default to disabled restricted access", () => {
  assert.equal(widgetSettings.parse({}).enabled, false);
  for (const origins of [
    ["https://example.com/path"],
    ["null"],
    ["https://*.example.com"],
    ["http://example.com"],
  ])
    assert.equal(
      widgetSettings.safeParse({ enabled: true, allowedOrigins: origins })
        .success,
      false,
    );
  assert.equal(widgetSettings.safeParse({ enabled: true }).success, false);
  assert.equal(
    widgetSettings.safeParse({
      enabled: true,
      allowedOrigins: ["http://localhost:4500"],
    }).success,
    true,
  );
});
test("Widget configuration is tenant/admin scoped and cannot broaden private API CORS", async () => {
  const path = `/workspaces/${workspace}/channels/${deployment}`,
    body = { enabled: true, allowedOrigins: [allowed, second] };
  assert.equal(
    (await call("GET", `/public/widgets/${deployment}`, undefined, "", allowed))
      .statusCode,
    403,
  );
  assert.equal((await call("PUT", path, body, "operator")).statusCode, 403);
  assert.equal((await call("PUT", path, body, "outsider")).statusCode, 403);
  assert.equal((await call("PUT", path, body)).statusCode, 200);
  const metadata = await call(
    "GET",
    `/public/widgets/${deployment}`,
    undefined,
    "",
    allowed,
  );
  assert.equal(metadata.statusCode, 200);
  assert.equal(metadata.headers["access-control-allow-origin"], allowed);
  assert.equal(metadata.headers["access-control-allow-credentials"], undefined);
  assert.equal(metadata.json().config, undefined);
  const preflight = await call(
    "OPTIONS",
    `/public/widgets/${deployment}/chat`,
    undefined,
    "",
    allowed,
  );
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], allowed);
  for (const origin of [
    "https://evil.example.com",
    "null",
    "https://customer.example.com.evil.com",
  ]) {
    const denied = await call(
      "POST",
      `/public/widgets/${deployment}/chat`,
      { message: "Hi" },
      "",
      origin,
    );
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.headers["access-control-allow-origin"], undefined);
  }
  assert.equal(
    (await app.inject({ method: "GET", url: `/public/widgets/${deployment}` }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/agents/${agent}/chat`,
        { message: "Hi" },
        "owner",
        allowed,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "GET",
        `/public/widgets/${"-".repeat(36)}`,
        undefined,
        "",
        allowed,
      )
    ).statusCode,
    403,
  );
});
test("Widget conversations bind guest token, deployment, channel and exact origin", async () => {
  const chat = await call(
    "POST",
    `/public/widgets/${deployment}/chat`,
    { message: "Hi" },
    "",
    allowed,
  );
  assert.equal(chat.statusCode, 200);
  const d = meta(chat.body);
  conversation = d.conversationId;
  token = d.guestToken;
  const [c] =
    await sql`SELECT channel,widget_origin FROM conversations WHERE id=${conversation}`;
  assert.equal(c!.channel, "widget");
  assert.equal(c!.widget_origin, allowed);
  assert.equal(
    (
      await call(
        "POST",
        `/public/widgets/${deployment}/chat`,
        { message: "Continue", conversationId: conversation },
        "",
        allowed,
        token,
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/public/widgets/${deployment}/chat`,
        { message: "Wrong token", conversationId: conversation },
        "",
        allowed,
        "wrong",
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/public/widgets/${deployment}/chat`,
        { message: "Wrong origin", conversationId: conversation },
        "",
        second,
        token,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/public/deployments/${deployment}/chat`,
        { message: "Wrong channel", conversationId: conversation },
        "",
        config.WEB_ORIGIN,
        token,
      )
    ).statusCode,
    403,
  );
});
test("Human handoff pauses the agent, enforces operator access and returns control after resolution", async () => {
  const path = `/public/widgets/${deployment}/conversations/${conversation}/handoff`,
    privatePath = `/conversations/${conversation}/handoff`;
  assert.equal(
    (await call("POST", path, { action: "request" }, "", allowed, "wrong"))
      .statusCode,
    404,
  );
  assert.equal(
    (await call("POST", path, { action: "request" }, "", allowed, token))
      .statusCode,
    201,
  );
  assert.equal(
    (await call("POST", path, { action: "request" }, "", allowed, token))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/public/widgets/${deployment}/chat`,
        { message: "No automated reply", conversationId: conversation },
        "",
        allowed,
        token,
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (await call("POST", path, { action: "claim" }, "", allowed, token))
      .statusCode,
    403,
  );
  assert.equal(
    (await call("POST", privatePath, { action: "claim" }, "analyst"))
      .statusCode,
    403,
  );
  assert.equal(
    (await call("GET", privatePath, undefined, "outsider")).statusCode,
    403,
  );
  assert.equal(
    (await call("POST", privatePath, { action: "claim" }, "operator"))
      .statusCode,
    201,
  );
  assert.equal(
    (await call("POST", privatePath, { action: "claim" }, "operator"))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await call(
        "POST",
        path,
        { action: "message", content: "Please help" },
        "",
        allowed,
        token,
      )
    ).statusCode,
    201,
  );
  assert.equal(
    (
      await call(
        "POST",
        privatePath,
        { action: "reply", content: "We can help" },
        "operator",
      )
    ).statusCode,
    201,
  );
  const view = await call("GET", path, undefined, "", allowed, token);
  assert.equal(view.json().status, "active");
  assert.deepEqual(
    view
      .json()
      .events.filter((e: { content: string }) => e.content)
      .map((e: { content: string }) => e.content),
    ["Please help", "We can help"],
  );
  assert.equal(
    (
      await call(
        "GET",
        `/workspaces/${workspace}/handoffs`,
        undefined,
        "operator",
      )
    ).json().length,
    1,
  );
  assert.equal(
    (await call("POST", privatePath, { action: "resolve" }, "operator"))
      .statusCode,
    201,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/public/widgets/${deployment}/chat`,
        { message: "Agent again", conversationId: conversation },
        "",
        allowed,
        token,
      )
    ).statusCode,
    200,
  );
});
test("Playground handoff ownership, in-flight guard, disabled deployment and public origin policy", async () => {
  const chat = await call("POST", `/agents/${agent}/chat`, {
    message: "Private",
  });
  privateConversation = meta(chat.body).conversationId;
  const path = `/conversations/${privateConversation}/handoff`;
  assert.equal(
    (await call("POST", path, { action: "request" }, "operator")).statusCode,
    403,
  );
  const run = randomUUID();
  await sql`INSERT INTO agent_runs(id,conversation_id,organization_id,workspace_id,status,trace_id) VALUES (${run},${privateConversation},${org},${workspace},'running','fixture')`;
  assert.equal(
    (await call("POST", path, { action: "request" })).statusCode,
    409,
  );
  await sql`DELETE FROM agent_runs WHERE id=${run}`;
  assert.equal(
    (await call("POST", path, { action: "request" })).statusCode,
    201,
  );
  assert.equal(
    (
      await call("POST", `/agents/${agent}/chat`, {
        message: "Blocked",
        conversationId: privateConversation,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await call("PUT", `/workspaces/${workspace}/channels/${deployment}`, {
        enabled: true,
        access: "public",
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "GET",
        `/public/widgets/${deployment}`,
        undefined,
        "",
        "https://public.example.com",
      )
    ).statusCode,
    200,
  );
  await sql`UPDATE deployments SET enabled=false WHERE id=${deployment}`;
  assert.equal(
    (await call("GET", `/public/widgets/${deployment}`, undefined, "", allowed))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "GET",
        `/public/deployments/${deployment}/conversations/${conversation}/handoff`,
        undefined,
        "",
        config.WEB_ORIGIN,
        token,
      )
    ).statusCode,
    404,
  );
});
