import { createBraveSearchAdapter } from "../src/web-search.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest, hashPassword } from "../src/security.js";
import { agentConfig } from "@agentconnect/schemas/agents";
import {
  runAgentTools,
  validateInputSchema,
  redact,
  executeTool,
} from "../src/tool-runtime.js";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  workspace = randomUUID(),
  owner = randomUUID(),
  builder = randomUUID(),
  viewer = randomUUID(),
  outsider = randomUUID();
const sessions: Record<string, string> = {};
let httpTool = "",
  credential = "",
  model = "",
  agent = "",
  connector = "",
  mcpTool = "";
let invalidPlan = false,
  overBudget = false,
  mcpReadOnly = true,
  gotGrounding = false;
let terminatedSessions = 0;
const originalPrivate = config.TOOL_PRIVATE_HOSTS,
  originalDb = config.TOOL_DATABASE_HOSTS;
const dbRole = "tool_fixture_" + randomUUID().replaceAll("-", "");
const table = "tool_fixture_" + randomUUID().replaceAll("-", "");
const dbPassword = randomUUID();
const mcpSchema = {
  type: "object",
  properties: { city: { type: "string", maxLength: 100 } },
  required: ["city"],
  additionalProperties: false,
};
const server = createServer(async (req, res) => {
  const u = new URL(req.url!, "http://localhost");
  if (u.pathname === "/redirect") {
    res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
    res.end();
    return;
  }
  if (u.pathname === "/slow") {
    setTimeout(() => res.end('{"ok":true}'), 1000).unref();
    return;
  }
  if (u.pathname === "/large") {
    res.end("a".repeat(300000));
    return;
  }
  if (u.pathname === "/mcp") {
    if (req.method === "DELETE") {
      terminatedSessions++;
      res.writeHead(204);
      res.end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    if (!("id" in input)) {
      res.writeHead(202);
      res.end();
      return;
    }
    const result =
      input.method === "initialize"
        ? {
            protocolVersion: input.params.protocolVersion,
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : input.method === "tools/list"
          ? {
              tools: [
                {
                  name: "weather",
                  description: "Get weather",
                  inputSchema: mcpSchema,
                  annotations: { readOnlyHint: mcpReadOnly },
                },
                {
                  name: "delete",
                  inputSchema: { type: "object" },
                  annotations: { readOnlyHint: false },
                },
              ],
            }
          : input.method === "resources/list"
            ? { resources: [{ uri: "fixture://guide", name: "Guide" }] }
            : input.method === "prompts/list"
              ? { prompts: [{ name: "guide" }] }
              : input.method === "tools/call"
                ? {
                    content: [
                      {
                        type: "text",
                        text: "Sunny in " + input.params.arguments.city,
                      },
                    ],
                  }
                : {};
    res.writeHead(200, {
      "Content-Type": "application/json",
      ...(input.method === "initialize"
        ? { "mcp-session-id": randomUUID() }
        : {}),
    });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      city: u.searchParams.get("city"),
      forecast: "sunny",
      authorization: req.headers.authorization,
      echo: "fixture-tool-secret",
    }),
  );
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const endpoint = `http://127.0.0.1:${port}`;
config.TOOL_PRIVATE_HOSTS = `127.0.0.1:${port}`;
const app = await buildApp({
  providerFactory: () => ({
    async *stream(input) {
      if (input.system.startsWith("Choose useful read-only tools")) {
        yield {
          type: "token",
          text: invalidPlan
            ? "not json"
            : JSON.stringify({
                calls: Array.from({ length: overBudget ? 4 : 1 }, () => ({
                  toolId: httpTool,
                  arguments: { city: "Yangon" },
                })),
              }),
        };
        yield { type: "usage", inputTokens: 4, outputTokens: 3 };
      } else {
        gotGrounding =
          input.system.includes("<tool_results>") &&
          input.system.includes("sunny");
        yield { type: "token", text: "The weather is sunny." };
        yield { type: "usage", inputTokens: 8, outputTokens: 5 };
      }
    },
  }),
});
async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
  session = sessions.owner,
) {
  return app.inject({
    method,
    url,
    headers: {
      origin: config.WEB_ORIGIN,
      cookie: session ?? "",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    payload: body ? JSON.stringify(body) : undefined,
  });
}
const input = (url = endpoint + "/weather") => ({
  name: "Weather",
  description: "Read weather for a city",
  config: {
    kind: "http",
    url,
    queryParameters: ["city"],
    secretId: credential,
    auth: "bearer",
  },
  readOnlyAcknowledged: true,
});
before(async () => {
  await sql.begin(async (tx) => {
    for (const [name, user] of Object.entries({
      owner,
      builder,
      viewer,
      outsider,
    })) {
      const raw = randomUUID();
      sessions[name] = "session=" + raw;
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${user},${user + "@example.com"},${name},${await hashPassword("fixture-only-password")},now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(raw)},${user},now()+interval '1 hour')`;
    }
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Tools fixtures')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Tools fixtures')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${owner},'owner')`;
    for (const [role, user] of [
      ["builder", builder],
      ["viewer", viewer],
    ])
      await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${workspace},${user!},${role!})`;
  });
  const r = await call("POST", `/workspaces/${workspace}/secrets`, {
    name: "TOOL_KEY",
    value: "fixture-tool-secret",
  });
  assert.equal(r.statusCode, 201);
  credential = (
    await sql`SELECT id FROM secrets WHERE workspace_id=${workspace} AND name='TOOL_KEY'`
  )[0]!.id;
});
after(async () => {
  await sql.begin(async (tx) => {
    for (const t of [
      "tool_executions",
      "messages",
      "agent_runs",
      "conversations",
      "deployments",
      "agent_versions",
      "agents",
      "tools",
      "mcp_connectors",
      "model_configurations",
      "secrets",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(t)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    await tx`DELETE FROM users WHERE id=ANY(${[owner, builder, viewer, outsider]})`;
  });
  await sql.unsafe(`DROP TABLE IF EXISTS "${table}"`);
  await sql.unsafe(`DROP ROLE IF EXISTS "${dbRole}"`);
  config.TOOL_PRIVATE_HOSTS = originalPrivate;
  config.TOOL_DATABASE_HOSTS = originalDb;
  await app.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
test("Registry requires administrator policy acknowledgement, approved endpoints and tenant credentials", async () => {
  assert.equal(
    (
      await call(
        "POST",
        `/workspaces/${workspace}/tools`,
        input(),
        sessions.builder,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "GET",
        `/workspaces/${workspace}/tools`,
        undefined,
        sessions.viewer,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call("POST", `/workspaces/${workspace}/tools`, {
        ...input(),
        readOnlyAcknowledged: false,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/workspaces/${workspace}/tools`,
        input("http://169.254.169.254/latest/meta-data"),
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call("POST", `/workspaces/${workspace}/tools`, {
        ...input(),
        config: { ...input().config, secretId: randomUUID() },
      })
    ).statusCode,
    400,
  );
  const r = await call("POST", `/workspaces/${workspace}/tools`, input());
  assert.equal(r.statusCode, 201, r.body);
  httpTool = r.json().id;
  const list = await call(
    "GET",
    `/workspaces/${workspace}/tools`,
    undefined,
    sessions.builder,
  );
  assert.equal(list.statusCode, 200);
  assert.equal(list.json()[0].config, undefined);
  assert.equal(
    (await call("GET", `/tools/${httpTool}`, undefined, sessions.outsider))
      .statusCode,
    403,
  );
});
test("HTTP tools validate arguments, redact credentials and persist test traces", async () => {
  assert.equal(
    (
      await call("POST", `/tools/${httpTool}/test`, {
        arguments: { url: "http://evil" },
      })
    ).statusCode,
    400,
  );
  const r = await call(
    "POST",
    `/tools/${httpTool}/test`,
    { arguments: { city: "Yangon" } },
    sessions.builder,
  );
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().result.city, "Yangon");
  assert.equal(r.json().result.echo, "[REDACTED]");
  assert.equal(r.json().result.authorization, "[REDACTED]");
  const [trace] =
    await sql`SELECT * FROM tool_executions WHERE id=${r.json().executionId}`;
  assert.equal(trace?.status, "completed");
  assert(!JSON.stringify(trace).includes("fixture-tool-secret"));
});
test("Redirects, oversized responses and deadlines fail with sanitized persisted codes", async () => {
  for (const [path, code, timeoutMs] of [
    ["redirect", "TOOL_REDIRECT_BLOCKED", 5000],
    ["large", "TOOL_RESPONSE_LIMIT", 5000],
    ["slow", "TOOL_TIMEOUT", 500],
  ] as const) {
    const r = await call("POST", `/workspaces/${workspace}/tools`, {
      ...input(endpoint + "/" + path),
      timeoutMs,
    });
    assert.equal(r.statusCode, 201, r.body);
    const t = await call("POST", `/tools/${r.json().id}/test`, {
      arguments: {},
    });
    assert.equal(t.statusCode, 400);
    assert.equal(t.json().error, code);
    const [trace] =
      await sql`SELECT status,error_code FROM tool_executions WHERE tool_id=${r.json().id}`;
    assert.equal(trace?.status, "failed");
    assert.equal(trace?.error_code, code);
  }
});
test("MCP discovers tools/resources/prompts and executes only explicitly registered unchanged read-only capabilities", async () => {
  const r = await call("POST", `/workspaces/${workspace}/mcp-connectors`, {
    name: "Fixture MCP",
    url: endpoint + "/mcp",
  });
  assert.equal(r.statusCode, 201, r.body);
  connector = r.json().id;
  const discovery = await call("POST", `/mcp-connectors/${connector}/discover`);
  assert.equal(discovery.statusCode, 200, discovery.body);
  assert.equal(discovery.json().tools.length, 2);
  assert.equal(discovery.json().resources.length, 1);
  assert.equal(discovery.json().prompts.length, 1);
  assert(terminatedSessions > 0);
  const data = {
    name: "MCP weather",
    description: "Weather from MCP",
    config: { kind: "mcp", connectorId: connector, remoteName: "weather" },
    readOnlyAcknowledged: true,
  };
  assert.equal(
    (
      await call("POST", `/workspaces/${workspace}/tools`, {
        ...data,
        config: { ...data.config, remoteName: "delete" },
      })
    ).statusCode,
    400,
  );
  const tool = await call("POST", `/workspaces/${workspace}/tools`, data);
  assert.equal(tool.statusCode, 201, tool.body);
  mcpTool = tool.json().id;
  const result = await call("POST", `/tools/${mcpTool}/test`, {
    arguments: { city: "Yangon" },
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().result.content[0].text, "Sunny in Yangon");
  mcpReadOnly = false;
  const changed = await call("POST", `/tools/${mcpTool}/test`, {
    arguments: { city: "Yangon" },
  });
  assert.equal(changed.statusCode, 400);
  assert.equal(changed.json().error, "MCP_CAPABILITY_CHANGED");
  mcpReadOnly = true;
});
test("PostgreSQL tool constructs bounded parameterized reads using a least-privilege connection", async () => {
  await sql.unsafe(`CREATE ROLE "${dbRole}" LOGIN PASSWORD '${dbPassword}'`);
  await sql.unsafe(`CREATE TABLE "${table}" (city text,forecast text)`);
  await sql.unsafe(
    `INSERT INTO "${table}" VALUES ('Yangon','sunny'),('Mandalay','cloudy')`,
  );
  await sql.unsafe(`GRANT SELECT ON "${table}" TO "${dbRole}"`);
  const conn = new URL(config.DATABASE_URL);
  conn.username = dbRole;
  conn.password = dbPassword;
  config.TOOL_DATABASE_HOSTS = `${conn.hostname}:${conn.port || 5432}`;
  const secret = await call("POST", `/workspaces/${workspace}/secrets`, {
    name: "TOOL_DATABASE",
    value: conn.href,
  });
  assert.equal(secret.statusCode, 201, secret.body);
  const data = {
    name: "Forecast DB",
    description: "Read forecasts",
    config: {
      kind: "database",
      secretId: (
        await sql`SELECT id FROM secrets WHERE workspace_id=${workspace} AND name='TOOL_DATABASE'`
      )[0]!.id,
      table,
      columns: ["city", "forecast"],
      filterColumns: ["city"],
      rowLimit: 1,
    },
    readOnlyAcknowledged: true,
  };
  const t = await call("POST", `/workspaces/${workspace}/tools`, data);
  assert.equal(t.statusCode, 201, t.body);
  const r = await call("POST", `/tools/${t.json().id}/test`, {
    arguments: { city: "Yangon" },
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().result.rows.length, 1);
  assert.equal(r.json().result.rows[0].forecast, "sunny");
  assert(r.json().result.query.includes("$1"));
  const injected = await call("POST", `/tools/${t.json().id}/test`, {
    arguments: { city: "' OR 1=1 --" },
  });
  assert.equal(injected.statusCode, 200, injected.body);
  assert.deepEqual(injected.json().result.rows, []);
  assert.equal(
    (
      await call("POST", `/tools/${t.json().id}/test`, {
        arguments: { sql: "DELETE FROM users" },
      })
    ).statusCode,
    400,
  );
});
test("Agent tool planning is bounded, grounded and traced with combined provider usage; public access is explicit", async () => {
  const m = await call("POST", `/workspaces/${workspace}/models`, {
    name: "Fixture",
    provider: "openai-compatible",
    modelId: "fixture",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.equal(m.statusCode, 201, m.body);
  model = m.json().id;
  const configDraft = agentConfig.parse({
    modelId: model,
    tools: { toolIds: [httpTool], maxCalls: 3 },
  });
  const r = await call("POST", `/workspaces/${workspace}/agents`, {
    name: "Weather Agent",
    config: configDraft,
  });
  assert.equal(r.statusCode, 201, r.body);
  agent = r.json().id;
  const result = await call("POST", `/agents/${agent}/chat`, {
    message: "What's the weather in Yangon?",
  });
  assert.equal(result.statusCode, 200, result.body);
  assert(result.body.includes("event: tool"));
  assert(result.body.includes("event: done"));
  assert(gotGrounding);
  const [run] =
    await sql`SELECT * FROM agent_runs WHERE conversation_id IN (SELECT id FROM conversations WHERE agent_id=${agent}) ORDER BY started_at DESC LIMIT 1`;
  assert.equal(run?.input_tokens, 12);
  assert.equal(run?.output_tokens, 8);
  const [trace] =
    await sql`SELECT * FROM tool_executions WHERE run_id=${run!.id}`;
  assert.equal(trace?.status, "completed");
  const published = await call("POST", `/agents/${agent}/publish`, {
    revision: 1,
  });
  assert.equal(published.statusCode, 201, published.body);
  const deploy = await call("POST", `/agents/${agent}/deployments`, {
    versionId: published.json().id,
    name: "Hosted",
  });
  assert.equal(deploy.statusCode, 400);
  assert.equal(deploy.json().error, "TOOL_NOT_PUBLIC");
  invalidPlan = true;
  const bad = await call("POST", `/agents/${agent}/chat`, {
    message: "Weather?",
  });
  assert(bad.body.includes("TOOL_PLAN_INVALID"));
  invalidPlan = false;
  overBudget = true;
  const many = await call("POST", `/agents/${agent}/chat`, {
    message: "Weather?",
  });
  assert(many.body.includes("TOOL_PLAN_INVALID"));
  overBudget = false;
});
test("Tool usage policies skip planning, permit no calls, require a call, and pass agent instructions", async () => {
  const c = agentConfig.parse({
    modelId: model,
    prompt: { instructions: "Use tools only for weather" },
    tools: { toolIds: [httpTool], usageInstructions: "Skip greetings" },
  });
  let plans = 0;
  const provider = {
    async *stream(request: import("@agentconnect/provider-sdk").ChatRequest) {
      plans++;
      assert(request.system.includes("Use tools only for weather"));
      assert(request.system.includes("Skip greetings"));
      yield { type: "token" as const, text: '{"calls":[]}' };
      yield { type: "usage" as const, inputTokens: 2, outputTokens: 1 };
    },
  };
  const ctx = { workspaceId: workspace, organizationId: org };
  const signal = new AbortController().signal;
  c.tools.usageMode = "disabled";
  assert.deepEqual(
    await runAgentTools(c, provider, "hi", ctx, signal, () => {}),
    { grounding: "", inputTokens: 0, outputTokens: 0 },
  );
  assert.equal(plans, 0);
  c.tools.usageMode = "automatic";
  assert.equal(
    (await runAgentTools(c, provider, "hi", ctx, signal, () => {})).grounding,
    "",
  );
  assert.equal(plans, 1);
  const caller = {
    async *stream() {
      yield {
        type: "token" as const,
        text: JSON.stringify({
          calls: [{ toolId: httpTool, arguments: { city: "Yangon" } }],
        }),
      };
      yield { type: "usage" as const, inputTokens: 2, outputTokens: 1 };
    },
  };
  c.tools.usageMode = "always";
  const required = await runAgentTools(
    c,
    caller,
    "weather",
    ctx,
    signal,
    () => {},
  );
  assert(required.grounding.includes("sunny"));
  await assert.rejects(
    runAgentTools(c, provider, "hi", ctx, signal, () => {}),
    { code: "TOOL_REQUIRED" },
  );
});
test("Optimistic updates, tool revocation and connector disabling prevent subsequent execution", async () => {
  const update = { ...input(), revision: 1, enabled: false };
  assert.equal(
    (await call("PUT", `/tools/${httpTool}`, update)).statusCode,
    200,
  );
  assert.equal(
    (await call("PUT", `/tools/${httpTool}`, update)).statusCode,
    409,
  );
  await assert.rejects(
    executeTool(
      httpTool,
      {},
      { workspaceId: workspace, organizationId: org },
      new AbortController().signal,
    ),
    /TOOL_UNAVAILABLE/,
  );
  const r = await call("POST", `/agents/${agent}/chat`, {
    message: "Weather?",
  });
  assert(r.body.includes("TOOL_UNAVAILABLE"));
  assert.equal(
    (
      await call("PUT", `/mcp-connectors/${connector}`, {
        name: "Fixture MCP",
        url: endpoint + "/mcp",
        enabled: false,
        revision: 1,
      })
    ).statusCode,
    200,
  );
  await assert.rejects(
    executeTool(
      mcpTool,
      { city: "Yangon" },
      { workspaceId: workspace, organizationId: org },
      new AbortController().signal,
    ),
    /MCP_CONNECTOR_UNAVAILABLE/,
  );
});
test("Remote schemas and sensitive trace properties are constrained", () => {
  assert.throws(() =>
    validateInputSchema({
      type: "object",
      properties: { x: { $ref: "https://evil/schema" } },
    }),
  );
  assert.throws(() =>
    validateInputSchema({
      type: "object",
      properties: { x: { type: "string", pattern: "(a+)+$" } },
    }),
  );
  assert.deepEqual(
    redact({ nested: { apiKey: "never print", text: "a secret" } }, ["secret"]),
    { nested: { apiKey: "[REDACTED]", text: "a [REDACTED]" } },
  );
});

test("Search adapter sends strict safe-search and applies exact domain policies to bounded results", async () => {
  const adapter = createBraveSearchAdapter(async (url, headers) => {
    const u = new URL(url);
    assert.equal(u.origin, "https://api.search.brave.com");
    assert.equal(u.searchParams.get("q"), "weather");
    assert.equal(u.searchParams.get("safesearch"), "strict");
    assert.equal(headers["X-Subscription-Token"], "fixture-search-key");
    return {
      status: 200,
      text: JSON.stringify({
        web: {
          results: [
            {
              url: "https://allowed.example/weather",
              title: "Weather",
              description: "Sunny",
            },
            {
              url: "https://denied.example/weather",
              title: "Denied",
              description: "No",
            },
            { url: "javascript:alert(1)", title: "Unsafe", description: "No" },
          ],
        },
      }),
    };
  });
  assert.deepEqual(
    await adapter.search(
      "weather",
      "fixture-search-key",
      {
        resultCount: 5,
        allowedDomains: ["allowed.example"],
        deniedDomains: ["denied.example"],
      },
      new AbortController().signal,
    ),
    [
      {
        url: "https://allowed.example/weather",
        title: "Weather",
        description: "Sunny",
      },
    ],
  );
  const failed = createBraveSearchAdapter(async () => ({
    status: 429,
    text: "sensitive provider body",
  }));
  await assert.rejects(
    failed.search(
      "x",
      "key",
      { resultCount: 1, allowedDomains: [], deniedDomains: [] },
      new AbortController().signal,
    ),
    /SEARCH_PROVIDER_ERROR/,
  );
});
