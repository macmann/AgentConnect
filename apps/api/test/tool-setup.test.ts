import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { workflowAction } from "@agentconnect/schemas/workflow-actions";
import { validateWorkflowAction } from "../src/workflow-action-runtime.js";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest } from "../src/security.js";
import { importOpenApi } from "../src/tool-openapi.js";
import { executeTool, validateInputSchema } from "../src/tool-runtime.js";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  workspace = randomUUID(),
  owner = randomUUID(),
  builder = randomUUID(),
  outsider = randomUUID(),
  sessions: Record<string, string> = {};
const priorHosts = config.TOOL_PRIVATE_HOSTS,
  priorProfiles = config.TOOL_STDIO_PROFILES;
let base = "",
  lastRequest: unknown;
let mcpCredential = "";
const fixture = createServer(async (req, res) => {
  if (req.url?.startsWith("/v1/items/")) {
    let body = "";
    for await (const chunk of req) body += chunk;
    lastRequest = {
      url: req.url,
      method: req.method,
      auth: req.headers["x-test-key"],
      body: body ? JSON.parse(body) : undefined,
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, received: lastRequest }));
    return;
  }
  mcpCredential = String(req.headers["x-test-key"] ?? "");
  let raw = "";
  for await (const c of req) raw += c;
  const m = JSON.parse(raw);
  if (m.id === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }
  const result =
    m.method === "initialize"
      ? {
          protocolVersion: m.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        }
      : m.method === "tools/list"
        ? {
            tools: [
              {
                name: "read",
                description: "Read fixture",
                inputSchema: {
                  type: "object",
                  properties: { q: { type: "string" } },
                  additionalProperties: false,
                },
                annotations: { readOnlyHint: true },
              },
              {
                name: "run_code",
                description: "Run isolated fixture code",
                inputSchema: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
                annotations: { readOnlyHint: false },
              },
            ],
          }
        : m.method === "tools/call"
          ? { content: [{ type: "text", text: "fixture reply" }] }
          : {};
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
});
const profile = {
  command: process.execPath,
  args: [fileURLToPath(new URL("./fixtures/mcp-stdio.mjs", import.meta.url))],
  credentialEnv: "FIXTURE_API_KEY",
};
const app = await buildApp();
before(async () => {
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const port = (fixture.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  config.TOOL_PRIVATE_HOSTS = [priorHosts, `127.0.0.1:${port}`]
    .filter(Boolean)
    .join(",");
  config.TOOL_STDIO_PROFILES = JSON.stringify([profile]);
  await sql`INSERT INTO organizations(id,name) VALUES(${org},'Tool wizard fixture')`;
  await sql`INSERT INTO workspaces(id,organization_id,name) VALUES(${workspace},${org},'Tools')`;
  for (const [uid, role] of [
    [owner, "owner"],
    [builder, "builder"],
    [outsider, "outsider"],
  ]) {
    const token = randomUUID();
    sessions[role!] = token;
    await sql`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES(${uid!},${uid + "@example.invalid"},${role!},'unused',now())`;
    await sql`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(${digest(token)},${uid!},now()+interval '1 hour')`;
    if (role !== "outsider")
      await sql`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES(${randomUUID()},${org},${role === "owner" ? null : workspace},${uid!},${role!})`;
  }
});
after(async () => {
  fixture.closeAllConnections();
  await new Promise<void>((r) => fixture.close(() => r()));
  config.TOOL_PRIVATE_HOSTS = priorHosts;
  config.TOOL_STDIO_PROFILES = priorProfiles;
  for (const table of [
    "tool_executions",
    "tools",
    "workflow_mcp_action_grants",
    "mcp_connectors",
    "secrets",
    "audit_events",
    "memberships",
    "workspaces",
  ])
    await sql`DELETE FROM ${sql(table)} WHERE organization_id=${org}`;
  await sql`DELETE FROM organizations WHERE id=${org}`;
  await sql`DELETE FROM sessions WHERE user_id=ANY(${[owner, builder, outsider]})`;
  await sql`DELETE FROM users WHERE id=ANY(${[owner, builder, outsider]})`;
  await app.close();
});
function request(path: string, body?: unknown, role = "owner") {
  return app.inject({
    method: body ? "POST" : "GET",
    url: path,
    headers: {
      cookie: `session=${sessions[role]}`,
      origin: "http://localhost:3000",
    },
    ...(body ? { payload: body as never } : {}),
  });
}
const path = () => `/workspaces/${workspace}/tool-setup`;
function spec() {
  return {
    openapi: "3.1.0",
    info: { title: "Inventory", version: "1" },
    servers: [{ url: base + "/v1" }],
    components: {
      schemas: {
        Payload: {
          type: "object",
          properties: { quantity: { type: "integer", minimum: 1 } },
          required: ["quantity"],
          additionalProperties: false,
        },
      },
      securitySchemes: {
        key: { type: "apiKey", in: "header", name: "X-Test-Key" },
      },
    },
    security: [{ key: [] }],
    paths: {
      "/items/{id}": {
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        get: {
          operationId: "getItem",
          summary: "Get item",
          parameters: [
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1 },
            },
          ],
        },
        post: {
          operationId: "updateItem",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Payload" },
              },
            },
          },
        },
      },
      "/skip": {
        post: {
          requestBody: {
            content: { "multipart/form-data": { schema: { type: "object" } } },
          },
        },
      },
    },
  };
}
test("OpenAPI extracts typed path/query/body parameters and auth, rejects recursive or remote references and unsupported operations", () => {
  const result = importOpenApi(JSON.stringify(spec()));
  assert.equal(result.operations.length, 2);
  assert.equal(result.warnings.length, 1);
  const get = result.operations[0]!;
  const validate = validateInputSchema(get.config.inputSchema);
  assert.ok(validate({ path: { id: "abc" }, query: { limit: 2 } }));
  assert.ok(!validate({ path: { id: "abc" }, query: { limit: "bad" } }));
  assert.ok(!validate({ query: { limit: 2 } }));
  assert.equal(get.config.auth, "api-key");
  const post = result.operations[1]!;
  assert.ok(
    validateInputSchema(post.config.inputSchema)({
      path: { id: "a" },
      body: { quantity: 2 },
    }),
  );
  assert.ok(
    !validateInputSchema(post.config.inputSchema)({
      path: { id: "a" },
      body: { quantity: 0 },
    }),
  );
  assert.throws(() => importOpenApi("openapi: 2.0"));
  assert.throws(() => importOpenApi("openapi: 3.1.0\npaths: &x\n  /x: *x"));
  const doc = spec();
  doc.components.schemas.Payload = {
    $ref: "https://remote.invalid/schema",
  } as never;
  assert.equal(importOpenApi(JSON.stringify(doc)).operations.length, 1);
});
test("Setup requires administration; inspection persists nothing and final save atomically encrypts credentials and registers selected API tools", async () => {
  const body = {
    mode: "api",
    name: "Inventory",
    spec: JSON.stringify(spec()),
    credential: "private-test-key",
  };
  for (const role of ["builder", "outsider"]) {
    const r = await request(path() + "/inspect", body, role);
    assert.equal(r.statusCode, 403, r.body);
  }
  const r = await request(path() + "/inspect", body);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().operations.length, 2);
  assert.ok(!r.body.includes("private-test-key"));
  assert.equal(
    (
      await sql`SELECT count(*)::int AS n FROM secrets WHERE workspace_id=${workspace}`
    )[0]!.n,
    0,
  );
  const rejected = await request(path(), {
    ...body,
    reviewFingerprint: r.json().fingerprint,
    selected: ["getItem", "updateItem"],
    acknowledged: true,
  });
  assert.equal(rejected.statusCode, 400);
  assert.equal(
    (
      await sql`SELECT count(*)::int AS n FROM tools WHERE workspace_id=${workspace}`
    )[0]!.n,
    0,
  );
  const drifted = await request(path(), {
    ...body,
    serverUrl: base + "/different",
    reviewFingerprint: r.json().fingerprint,
    selected: ["getItem"],
    acknowledged: true,
  });
  assert.equal(drifted.statusCode, 400);
  assert.ok(drifted.body.includes("TOOL_REVIEW_CHANGED_VALIDATE_AGAIN"));
  const saved = await request(path(), {
    ...body,
    reviewFingerprint: r.json().fingerprint,
    selected: ["getItem", "updateItem"],
    acknowledged: true,
    allowMutations: true,
  });
  assert.equal(saved.statusCode, 201, saved.body);
  assert.equal(saved.json().tools.length, 2);
  assert.ok(!saved.body.includes("private-test-key"));
  await assert.rejects(
    () =>
      validateWorkflowAction(
        workflowAction.parse({
          id: "misclassified",
          name: "Wrong read classification",
          connector: "agentconnect.tool",
          toolId: saved.json().tools[1].id,
          operation: "execute",
        }),
        { workspaceId: workspace, organizationId: org, userId: owner },
      ),
    /ACTION_TOOL_SIDE_EFFECT_MISMATCH/,
  );
  const context = {
    workspaceId: workspace,
    organizationId: org,
    userId: owner,
  };
  const get = await executeTool(
    saved.json().tools[0].id,
    { path: { id: "a/b" }, query: { limit: 3 } },
    context,
    AbortSignal.timeout(5000),
  );
  assert.equal(get.status, "completed");
  assert.ok(!JSON.stringify(get).includes("private-test-key"));
  assert.match((lastRequest as { url: string }).url, /a%2Fb\?limit=3/);
  const post = await executeTool(
    saved.json().tools[1].id,
    { path: { id: "a" }, body: { quantity: 2 } },
    context,
    AbortSignal.timeout(5000),
  );
  assert.equal(post.status, "completed");
  assert.equal((lastRequest as { method: string }).method, "POST");
  await assert.rejects(
    () =>
      executeTool(
        saved.json().tools[1].id,
        { path: { id: "a" }, body: { quantity: 0 } },
        context,
        AbortSignal.timeout(5000),
      ),
    /TOOL_ARGUMENTS_INVALID/,
  );
});
test("MCP HTTP discovery and multi-tool save preserve explicit side effect selection", async () => {
  const body = {
    mode: "mcp",
    name: "Fixture MCP",
    connector: {
      name: "Fixture MCP",
      url: base + "/mcp",
      authHeader: "X-Test-Key",
    },
    credential: "private-test-key",
  };
  const inspect = await request(path() + "/inspect", body);
  assert.equal(inspect.statusCode, 200, inspect.body);
  assert.equal(mcpCredential, "private-test-key");
  assert.deepEqual(
    inspect.json().operations.map((o: { sideEffect: boolean }) => o.sideEffect),
    [false, true],
  );
  const saved = await request(path(), {
    ...body,
    reviewFingerprint: inspect.json().fingerprint,
    selected: ["read", "run_code"],
    acknowledged: true,
    allowMutations: true,
  });
  assert.equal(saved.statusCode, 201, saved.body);
  assert.equal(saved.json().tools.length, 2);
  const result = await executeTool(
    saved.json().tools[1].id,
    {},
    { workspaceId: workspace, organizationId: org, userId: owner },
    AbortSignal.timeout(5000),
  );
  assert.equal(result.status, "completed");
});
test("STDIO supports discovery and calls with an explicit encrypted environment credential, blocks arbitrary commands and inherited service secrets", async () => {
  const bad = await request(path() + "/inspect", {
    mode: "mcp",
    name: "Bad",
    connector: {
      name: "Bad",
      transport: "stdio",
      stdio: { command: "/bin/sh", args: ["-c", "echo no"] },
    },
  });
  assert.equal(bad.statusCode, 400);
  assert.ok(bad.body.includes("MCP_STDIO_COMMAND_NOT_APPROVED"));
  const body = {
    mode: "template",
    templateId: "code",
    name: "Sandbox",
    credential: "private-test-key",
    connector: { name: "Sandbox", transport: "stdio", stdio: profile },
  };
  const preview = await request(path() + "/inspect", body);
  assert.equal(preview.statusCode, 200, preview.body);
  const saved = await request(path(), {
    ...body,
    reviewFingerprint: preview.json().fingerprint,
    selected: ["inspect"],
    acknowledged: true,
  });
  assert.equal(saved.statusCode, 201, saved.body);
  const result = await executeTool(
    saved.json().tools[0].id,
    {},
    { workspaceId: workspace, organizationId: org, userId: owner },
    AbortSignal.timeout(5000),
  );
  assert.equal(result.status, "completed");
  assert.match(JSON.stringify(result), /noDatabase/);
  assert.match(JSON.stringify(result), /authenticated\\":true/);
  assert.ok(!JSON.stringify(result).includes("private-test-key"));
});
test("Built-in template needs only a name, registers a normal agent-attachable tool, and rejects forged selections without persisting anything", async () => {
  const body = {
    mode: "template",
    templateId: "financial",
    name: "Calculator",
  };
  const preview = await request(path() + "/inspect", body);
  assert.equal(preview.statusCode, 200, preview.body);
  const bad = await request(path(), {
    ...body,
    selected: ["forged"],
    acknowledged: true,
  });
  assert.equal(bad.statusCode, 400);
  const saved = await request(path(), {
    ...body,
    reviewFingerprint: preview.json().fingerprint,
    selected: ["financial"],
    acknowledged: true,
  });
  assert.equal(saved.statusCode, 201, saved.body);
  const registry = await request(
    `/workspaces/${workspace}/tools`,
    undefined,
    "builder",
  );
  assert.ok(
    registry
      .json()
      .some((t: { id: string }) => t.id === saved.json().tools[0].id),
  );
});
