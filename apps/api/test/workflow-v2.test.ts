import { workflowAction } from "@agentconnect/schemas/workflow-actions";
import { executeWorkflowAction } from "../src/workflow-action-runtime.js";
import { storedWorkflowGraph } from "../src/workflow-v2.js";
import "./tracing-fixture.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { digest } from "../src/security.js";
import { config } from "../src/config.js";
import {
  processWorkflowRun,
  workflowSaver,
  closeWorkflowSaver,
} from "../src/workflow-runtime.js";
import { processWorkflowSchedules } from "../src/workflow-triggers.js";
import {
  workflowDefinitionV2,
  type WorkflowDefinitionV2,
} from "@agentconnect/schemas/workflow-v2";
import type { ProviderFactory } from "@agentconnect/provider-sdk";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  workspace = randomUUID(),
  foreign = randomUUID(),
  owner = randomUUID(),
  viewer = randomUUID(),
  ownerToken = randomUUID(),
  viewerToken = randomUUID();
const app = await buildApp(),
  runs: string[] = [],
  originalPrivate = config.TOOL_PRIVATE_HOSTS;
let modelId = "",
  agentId = "",
  versionId = "",
  toolId = "",
  calls = 0,
  providerCalls = 0;
const persistedInvoices = new Map<string, unknown>();
const persistenceCalls: string[] = [];
const actionRequests: { method: string; key?: string; body: unknown }[] = [];
const actionInvoices = new Map<string, Record<string, unknown>>();
const actionKeys = new Set<string>();
let staleRead = false,
  mcpMetadataDrift = false;
const mcpInvoiceSchema = {
  type: "object",
  properties: {
    invoiceNumber: { type: "string" },
    supplier: { type: "string" },
    total: { type: "number" },
    requestId: { type: "string" },
  },
  required: ["invoiceNumber", "supplier", "total", "requestId"],
  additionalProperties: false,
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, "http://localhost");
  if (url.pathname === "/actions/mcp") {
    if (req.method === "DELETE") {
      res.writeHead(204);
      res.end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    if (!("id" in input)) {
      res.writeHead(202);
      res.end();
      return;
    }
    let result: unknown = {};
    if (input.method === "initialize")
      result = {
        protocolVersion: input.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "invoice-db", version: "1" },
      };
    if (input.method === "tools/list")
      result = {
        tools: [
          {
            name: "insert_invoice",
            inputSchema: mcpMetadataDrift
              ? { ...mcpInvoiceSchema, additionalProperties: true }
              : mcpInvoiceSchema,
            annotations: { readOnlyHint: false, destructiveHint: false },
          },
          {
            name: "read_invoice",
            inputSchema: {
              type: "object",
              properties: { invoiceNumber: { type: "string" } },
              required: ["invoiceNumber"],
              additionalProperties: false,
            },
            annotations: { readOnlyHint: true },
          },
        ],
      };
    if (input.method === "tools/call") {
      const args = input.params.arguments;
      let output: unknown;
      if (input.params.name === "insert_invoice") {
        if (!actionKeys.has(args.requestId)) {
          actionKeys.add(args.requestId);
          actionInvoices.set(args.invoiceNumber, {
            invoiceNumber: args.invoiceNumber,
            supplier: args.supplier,
            total: args.total,
          });
        }
        output = { persisted: true, invoiceNumber: args.invoiceNumber };
      } else {
        const record = actionInvoices.get(args.invoiceNumber);
        output = { ...record, total: staleRead ? -1 : record?.total };
      }
      result = {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
    return;
  }
  if (url.pathname.startsWith("/actions/")) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    actionRequests.push({
      method: req.method!,
      key: req.headers["idempotency-key"] as string | undefined,
      body: raw ? JSON.parse(raw) : null,
    });
    if (url.pathname === "/actions/slow") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      }, 1000).unref();
      return;
    }
    if (url.pathname === "/actions/drop") {
      req.socket.destroy();
      return;
    }
    if (url.pathname === "/actions/redirect") {
      res.writeHead(302, {
        location: "http://169.254.169.254/latest/meta-data",
      });
      res.end();
      return;
    }
    if (
      url.pathname === "/actions/retry" &&
      actionRequests.filter((r) => r.key === req.headers["idempotency-key"])
        .length === 1
    ) {
      res.writeHead(503);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        method: req.method,
        body: raw ? JSON.parse(raw) : null,
        query: url.searchParams.get("q"),
        echo: req.headers.authorization ?? "none",
      }),
    );
    return;
  }
  const query =
    new URL(req.url!, "http://localhost").searchParams.get("query") ?? "";
  if (query.startsWith("persist:")) {
    const record = JSON.parse(query.slice(8));
    persistenceCalls.push(record.invoiceNumber);
    if (record.invoiceNumber === "FAIL") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end('{"error":"mock persistence failure"}');
      return;
    }
    persistedInvoices.set(record.invoiceNumber, record);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        readKey: "read:" + record.invoiceNumber,
        persisted: true,
      }),
    );
    return;
  }
  if (query.startsWith("read:")) {
    const record = persistedInvoices.get(query.slice(5));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ valid: !!record, record }));
    return;
  }

  calls++;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      amount: 12,
      invoiceNumber: "INV-1",
      query: new URL(req.url!, "http://localhost").searchParams.get("query"),
    }),
  );
});
const reference = (path: string) => ({ type: "reference" as const, path });
const literal = (value: string | number) => ({
  type: "literal" as const,
  value,
});
const provider: ProviderFactory = () => ({
  async *stream(input) {
    providerCalls++;
    yield { type: "token", text: "Reply: " + input.messages.at(-1)!.content };
    yield { type: "usage", inputTokens: 4, outputTokens: 3 };
  },
});
async function call(
  method: string,
  url: string,
  body?: unknown,
  token = ownerToken,
) {
  return app.inject({
    method: method as "GET" | "POST" | "PUT",
    url,
    remoteAddress: "198.51.100." + (10 + runs.length),
    headers: { cookie: "session=" + token, origin: config.WEB_ORIGIN },
    payload: body as Record<string, unknown>,
  });
}
async function create(definition: WorkflowDefinitionV2, name = "V2 workflow") {
  const result = await call("POST", `/workspaces/${workspace}/workflows`, {
    name,
    graph: definition,
  });
  assert.equal(result.statusCode, 201, result.body);
  return result.json().id as string;
}
async function publish(id: string) {
  const result = await call("POST", `/workflows/${id}/publish`, {
    revision: 1,
  });
  assert.equal(result.statusCode, 201, result.body);
  return result.json().id as string;
}
async function run(id: string, input: unknown, versionId?: string) {
  const result = await call("POST", `/workflows/${id}/runs`, {
    input,
    ...(versionId ? { versionId } : { revision: 1 }),
  });
  assert.equal(result.statusCode, 202, result.body);
  runs.push(result.json().id);
  return result.json().id as string;
}
async function inspect(id: string) {
  const result = await call("GET", `/workflow-runs/${id}`);
  assert.equal(result.statusCode, 200, result.body);
  return result.json();
}
const simple = () =>
  workflowDefinitionV2.parse({
    schemaVersion: 2,
    execution: {
      nodes: [
        { id: "start", kind: "input", label: "Start", config: {} },
        {
          id: "end",
          kind: "output",
          label: "End",
          config: { input: reference("trigger.body.customer.email") },
        },
      ],
      edges: [{ id: "next", source: "start", target: "end" }],
    },
  });
const flow = () =>
  workflowDefinitionV2.parse({
    schemaVersion: 2,
    execution: {
      variables: { threshold: 10 },
      resources: {
        assistant: { kind: "agent", agentId, versionId },
        lookup: { kind: "tool", id: toolId },
        model: { kind: "model", id: modelId },
      },
      actions: [
        {
          id: "lookup",
          name: "Lookup invoice",
          connector: "agentconnect.tool",
          operation: "execute",
          toolId,
          staticInputs: { query: "default" },
          mappedInputs: { query: reference("input.customer.email") },
          inputSchema: {
            type: "object",
            required: ["query"],
            properties: { query: { type: "string" } },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            required: ["amount", "invoiceNumber"],
            properties: {
              amount: { type: "number" },
              invoiceNumber: { type: "string" },
            },
          },
          requiredPermissions: ["tool:execute"],
        },
      ],
      nodes: [
        { id: "start", kind: "input", label: "Start", config: {} },
        {
          id: "lookup",
          kind: "action",
          label: "Lookup",
          config: { actionId: "lookup" },
        },
        {
          id: "check",
          kind: "condition",
          label: "Check",
          config: {
            condition: {
              operator: "greater-than",
              left: reference("steps.lookup.output.amount"),
              right: reference("variables.threshold"),
            },
          },
        },
        {
          id: "respond",
          kind: "agent",
          label: "Respond",
          config: {
            resource: "assistant",
            input: reference("steps.lookup.output.invoiceNumber"),
          },
        },
        {
          id: "fallback",
          kind: "action",
          label: "Fallback",
          config: {
            actionId: "lookup",
            inputs: { query: literal("fallback") },
          },
        },
        { id: "join", kind: "merge", label: "Join", config: {} },
        {
          id: "review",
          kind: "approval",
          label: "Review",
          config: { prompt: "Approve invoice response" },
        },
        { id: "end", kind: "output", label: "End", config: {} },
      ],
      edges: [
        { id: "a", source: "start", target: "lookup" },
        { id: "b", source: "lookup", target: "check" },
        { id: "yes", source: "check", target: "respond", branch: "true" },
        { id: "no", source: "check", target: "fallback", branch: "false" },
        { id: "mergeYes", source: "respond", target: "join" },
        { id: "mergeNo", source: "fallback", target: "join" },
        { id: "approval", source: "join", target: "review" },
        { id: "finish", source: "review", target: "end" },
      ],
    },
    editor: { nodes: { lookup: { x: 200, y: 100 } } },
  });
before(async () => {
  await new Promise<void>((resolve) =>
    server.listen(4549, "127.0.0.1", resolve),
  );
  config.TOOL_PRIVATE_HOSTS = [originalPrivate, "127.0.0.1:4549"]
    .filter(Boolean)
    .join(",");
  await sql.begin(async (tx) => {
    for (const [id, token] of [
      [owner, ownerToken],
      [viewer, viewerToken],
    ]) {
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${id!},${id + "@example.com"},'V2 fixture','unused-fixture',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(token!)},${id!},now()+interval '1 hour')`;
    }
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'V2 test')`;
    for (const id of [workspace, foreign])
      await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${id},${org},'V2 workspace')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${owner},'owner')`;
    await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${workspace},${viewer},'viewer')`;
  });
  const model = await call("POST", `/workspaces/${workspace}/models`, {
    name: "V2 model",
    provider: "openai-compatible",
    modelId: "fixture",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.equal(model.statusCode, 201, model.body);
  modelId = model.json().id;
  const agent = await call("POST", `/workspaces/${workspace}/agents`, {
    name: "Existing agent",
    config: { modelId },
  });
  assert.equal(agent.statusCode, 201, agent.body);
  agentId = agent.json().id;
  const version = await call("POST", `/agents/${agentId}/publish`, {
    revision: 1,
  });
  assert.equal(version.statusCode, 201, version.body);
  versionId = version.json().id;
  const tool = await call("POST", `/workspaces/${workspace}/tools`, {
    name: "Invoice lookup",
    description: "Fixture read",
    config: {
      kind: "http",
      url: "http://127.0.0.1:4549/lookup",
      queryParameters: ["query"],
    },
    readOnlyAcknowledged: true,
  });
  assert.equal(tool.statusCode, 201, tool.body);
  toolId = tool.json().id;
});
after(async () => {
  const saver = await workflowSaver();
  const allRuns =
    await sql`SELECT id FROM workflow_runs WHERE organization_id=${org}`;
  for (const { id } of allRuns) await saver.deleteThread(id);
  await closeWorkflowSaver();
  await sql.begin(async (tx) => {
    for (const table of [
      "tool_executions",
      "workflow_approvals",
      "workflow_node_runs",
      "workflow_runs",
      "workflow_schedules",
      "workflow_webhooks",
      "workflow_versions",
      "workflows",
      "agent_versions",
      "agents",
      "tools",
      "workflow_mcp_action_grants",
      "workflow_http_connections",
      "mcp_connectors",
      "enterprise_connectors",
      "knowledge_bases",
      "embedding_models",
      "model_configurations",
      "secrets",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    await tx`DELETE FROM users WHERE id=ANY(${[owner, viewer]})`;
  });
  await app.close();
  config.TOOL_PRIVATE_HOSTS = originalPrivate;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
test("V2 persists as V2, publishes immutably, projects into the canvas and guards V1 overwrite", async () => {
  const definition = simple(),
    id = await create(definition),
    version = await publish(id);
  const [stored] =
    await sql`SELECT graph FROM workflow_versions WHERE id=${version}`;
  assert.equal(stored!.graph.schemaVersion, 2);
  assert.ok(!stored!.graph.nodes);
  const response = await call("GET", `/workflows/${id}`);
  assert.equal(response.json().definitionVersion, 2);
  assert.equal(response.json().draft_graph.schemaVersion, 1);
  assert.equal(response.json().definition.schemaVersion, 2);
  const wrong = await call("PUT", `/workflows/${id}`, {
    name: "Downgrade",
    revision: 1,
    graph: response.json().draft_graph,
  });
  assert.equal(wrong.statusCode, 409, wrong.body);
  const source = await call("GET", `/workflows/${id}/definition`);
  assert.deepEqual(source.json().definition, definition);
  const update = await call("PUT", `/workflows/${id}`, {
    name: "Edited",
    revision: 1,
    graph: {
      ...definition,
      execution: { ...definition.execution, variables: { batchSize: 7 } },
    },
  });
  assert.equal(update.statusCode, 200, update.body);
  const [still] =
    await sql`SELECT graph FROM workflow_versions WHERE id=${version}`;
  assert.deepEqual(still!.graph, stored!.graph);
  const versions = await call("GET", `/workflows/${id}/versions`);
  assert.equal(versions.json()[0].definitionVersion, 2);
  const runId = await run(
    id,
    { customer: { email: "customer@example.com" } },
    version,
  );
  assert.equal(await processWorkflowRun({ providerFactory: provider }), true);
  assert.equal((await inspect(runId)).output, "customer@example.com");
});
test("V2 Action, typed condition, existing published agent and durable approval use the existing runner", async () => {
  const definition = flow(),
    id = await create(definition),
    version = await publish(id);
  assert.equal(JSON.stringify(definition).includes("127.0.0.1"), false);
  const startCalls = calls,
    startProviders = providerCalls;
  const runId = await run(
    id,
    { customer: { email: "customer@example.com" } },
    version,
  );
  assert.equal(await processWorkflowRun({ providerFactory: provider }), true);
  let record = await inspect(runId);
  assert.equal(record.status, "waiting", JSON.stringify(record));
  assert.equal(calls - startCalls, 1);
  assert.equal(providerCalls - startProviders, 1);
  assert.ok(
    !record.nodes.some((n: { node_id: string }) => n.node_id === "fallback"),
  );
  assert.equal(record.graph_snapshot.programV2.compilerVersion, 1);
  assert.throws(() =>
    storedWorkflowGraph({
      ...record.graph_snapshot,
      programV2: { ...record.graph_snapshot.programV2, compilerVersion: 2 },
    }),
  );
  assert.equal(record.tools[0].arguments.query, "customer@example.com");
  await closeWorkflowSaver();
  const approved = await call("POST", `/workflow-runs/${runId}/approval`, {
    decision: "approved",
    comment: "Reviewed",
  });
  assert.equal(approved.statusCode, 200, approved.body);
  await processWorkflowRun({ providerFactory: provider });
  record = await inspect(runId);
  assert.equal(record.status, "completed", JSON.stringify(record));
  assert.deepEqual(record.output, { respond: "Reply: INV-1" });
  assert.equal(calls - startCalls, 1);
  assert.equal(providerCalls - startProviders, 1);
});
test("typed false branches and reference failures are explicit in existing run traces", async () => {
  const definition = flow();
  definition.execution.variables.threshold = 99;
  definition.execution.nodes = definition.execution.nodes.filter(
    (n) => n.id !== "review",
  );
  definition.execution.edges = definition.execution.edges.filter(
    (e) => e.id !== "approval" && e.id !== "finish",
  );
  definition.execution.edges.push({
    id: "finish",
    source: "join",
    target: "end",
  });
  const id = await create(definition),
    runId = await run(id, { customer: { email: "test@example.com" } });
  await processWorkflowRun({ providerFactory: provider });
  const result = await inspect(runId);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.output.fallback.query, "fallback");
  const invalid = simple();
  invalid.execution.nodes[1]!.config = {
    input: reference("input.missing"),
    title: "",
    summary: "",
    format: "auto",
  };
  const missingId = await create(invalid),
    missingRun = await run(missingId, {
      customer: { email: "test@example.com" },
    });
  await processWorkflowRun({ providerFactory: provider });
  const missing = await inspect(missingRun);
  assert.equal(missing.status, "failed");
  assert.equal(missing.error_code, "WORKFLOW_REFERENCE_MISSING");
});
test("V2 resource validation enforces tenant, agent-version identity, connector binding and permissions", async () => {
  const definition = flow();
  definition.execution.resources.assistant = {
    kind: "agent",
    agentId: randomUUID(),
    versionId,
  };
  let result = await call(
    "POST",
    `/workspaces/${workspace}/workflows/compile`,
    { definition },
  );
  assert.equal(result.statusCode, 400, result.body);
  const foreignModel = await call("POST", `/workspaces/${foreign}/models`, {
    name: "Foreign",
    provider: "openai-compatible",
    modelId: "fixture",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.equal(foreignModel.statusCode, 201, foreignModel.body);
  for (const resource of [
    { kind: "model", id: foreignModel.json().id },
    { kind: "knowledge", id: randomUUID() },
    { kind: "secret", id: randomUUID() },
    { kind: "mcp", id: randomUUID() },
    { kind: "connection", id: randomUUID() },
  ]) {
    const definition = simple();
    definition.execution.resources = {
      unavailable:
        resource as WorkflowDefinitionV2["execution"]["resources"][string],
    };
    result = await call("POST", `/workspaces/${workspace}/workflows/compile`, {
      definition,
    });
    assert.equal(result.statusCode, 400, result.body);
  }
  const wrong = flow();
  wrong.execution.actions[0]!.connectionId = randomUUID();
  result = await call("POST", `/workspaces/${workspace}/workflows/compile`, {
    definition: wrong,
  });
  assert.equal(result.statusCode, 400, result.body);
  result = await call(
    "POST",
    `/workspaces/${workspace}/workflows/compile`,
    { definition: simple() },
    viewerToken,
  );
  assert.equal(result.statusCode, 403, result.body);
  const valid = await call(
    "POST",
    `/workspaces/${workspace}/workflows/compile`,
    { definition: flow() },
  );
  assert.equal(valid.statusCode, 200, valid.body);
});
test("V2 schedules retain the published definition and compile into ordinary queued runs", async () => {
  const definition = simple();
  definition.execution.nodes[1]!.config = {
    input: reference("trigger.type"),
    title: "",
    summary: "",
    format: "auto",
  };
  const id = await create(definition),
    version = await publish(id);
  const schedule = await call("POST", `/workflows/${id}/schedules`, {
    name: "V2 schedule",
    versionId: version,
    cron: "* * * * *",
    timezone: "UTC",
    input: { customer: { email: "scheduled@example.com" } },
  });
  assert.equal(schedule.statusCode, 201, schedule.body);
  await sql`UPDATE workflow_schedules SET next_run_at=now()-interval '1 second' WHERE id=${schedule.json().id}`;
  assert.equal(await processWorkflowSchedules(), true);
  const [queued] =
    await sql`SELECT id,graph_snapshot FROM workflow_runs WHERE schedule_id=${schedule.json().id}`;
  assert.ok(queued);
  runs.push(queued.id);
  assert.equal(queued.graph_snapshot.programV2.compilerVersion, 1);
  await processWorkflowRun({ providerFactory: provider });
  assert.equal((await inspect(queued.id)).output, "schedule");
});

test("V2 supports live KB, MCP, provider, encrypted-secret and saved-connection references without copying configuration", async () => {
  const secret = await call("POST", `/workspaces/${workspace}/secrets`, {
    name: "V2_RESOURCE_FIXTURE",
    value: "fixture-only-credential",
  });
  assert.equal(secret.statusCode, 201, secret.body);
  const secrets = await call("GET", `/workspaces/${workspace}/secrets`);
  const secretId = secrets
      .json()
      .find((s: { name: string }) => s.name === "V2_RESOURCE_FIXTURE").id,
    embedding = randomUUID(),
    kb = randomUUID(),
    mcp = randomUUID(),
    connection = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO embedding_models(id,organization_id,workspace_id,name,provider,model_id,base_url,dimensions) VALUES (${embedding},${org},${workspace},'V2 embeddings','openai-compatible','fixture','https://api.openai.com/v1',3)`;
    await tx`INSERT INTO knowledge_bases(id,organization_id,workspace_id,name,description,embedding_model_id,dimensions,chunk_size,chunk_overlap,chunk_strategy) VALUES (${kb},${org},${workspace},'V2 knowledge','fixture',${embedding},3,500,0,'recursive')`;
    await tx`INSERT INTO mcp_connectors(id,organization_id,workspace_id,name,url,secret_id) VALUES (${mcp},${org},${workspace},'V2 MCP','http://127.0.0.1:4549/mcp',${secretId})`;
    await tx`INSERT INTO enterprise_connectors(id,organization_id,workspace_id,name,kind,knowledge_base_id,secret_id,selection,created_by,updated_by) VALUES (${connection},${org},${workspace},'V2 saved connection','s3',${kb},${secretId},'{}',${owner},${owner})`;
  });
  const definition = simple();
  definition.execution.resources = {
    knowledge: { kind: "knowledge", id: kb },
    mcp: { kind: "mcp", id: mcp },
    provider: { kind: "model", id: modelId },
    credential: { kind: "secret", id: secretId },
    saved: { kind: "connection", id: connection },
  };
  const compiled = await call(
    "POST",
    `/workspaces/${workspace}/workflows/compile`,
    { definition },
  );
  assert.equal(compiled.statusCode, 200, compiled.body);
  assert.ok(!compiled.body.includes("fixture-only-credential"));
  assert.ok(!compiled.body.includes("127.0.0.1"));
  await sql`UPDATE mcp_connectors SET enabled=false WHERE id=${mcp}`;
  const revoked = await call(
    "POST",
    `/workspaces/${workspace}/workflows/compile`,
    { definition },
  );
  assert.equal(revoked.statusCode, 400, revoked.body);
});

const invoiceSchema = {
  type: "object",
  required: ["invoiceNumber", "total", "invoiceDate"],
  additionalProperties: false,
  properties: {
    invoiceNumber: { type: "string" },
    total: { type: "number" },
    invoiceDate: { type: "string", format: "date" },
  },
};
function reviewFlow() {
  return workflowDefinitionV2.parse({
    schemaVersion: 2,
    execution: {
      resources: { extraction: { kind: "model", id: modelId } },
      actions: [
        {
          id: "lookup",
          name: "Look up reviewed invoice",
          connector: "agentconnect.tool",
          operation: "execute",
          toolId,
          inputSchema: {
            type: "object",
            required: ["query"],
            properties: { query: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
      nodes: [
        { id: "start", kind: "input", label: "Input", config: {} },
        {
          id: "extract",
          kind: "structured-ai",
          label: "Extract invoice",
          config: {
            resource: "extraction",
            instruction: "Extract the invoice fields.",
            outputSchema: invoiceSchema,
          },
        },
        {
          id: "review",
          kind: "human-task",
          label: "Review invoice",
          config: {
            mode: "review-edit",
            prompt: "Correct invoice details",
            outputSchema: invoiceSchema,
            approveLabel: "Process",
          },
        },
        {
          id: "lookup",
          kind: "action",
          label: "Invoice lookup",
          config: {
            actionId: "lookup",
            inputs: { query: reference("steps.review.output.invoiceNumber") },
          },
        },
        {
          id: "check",
          kind: "condition",
          label: "Check total",
          config: {
            condition: {
              operator: "greater-than",
              left: reference("steps.review.output.total"),
              right: literal(10000),
            },
          },
        },
        {
          id: "high",
          kind: "transform",
          label: "Finance review",
          config: {
            fields: {
              route: literal("finance"),
              invoiceNumber: reference("steps.review.output.invoiceNumber"),
            },
          },
        },
        {
          id: "low",
          kind: "transform",
          label: "Automatic route",
          config: {
            fields: {
              route: literal("automatic"),
              invoiceNumber: reference("steps.review.output.invoiceNumber"),
            },
          },
        },
        { id: "join", kind: "merge", label: "Result", config: {} },
        {
          id: "confirm",
          kind: "human-task",
          label: "Final approval",
          config: {
            mode: "approve-reject",
            prompt: "Approve processing",
            outputSchema: { type: "object" },
          },
        },
        { id: "end", kind: "output", label: "Output", config: {} },
      ],
      edges: [
        ["start", "extract"],
        ["extract", "review"],
        ["review", "lookup"],
        ["lookup", "check"],
        ["check", "high", "true"],
        ["check", "low", "false"],
        ["high", "join"],
        ["low", "join"],
        ["join", "confirm"],
        ["confirm", "end"],
      ].map(([source, target, branch], i) => ({
        id: "edge_" + i,
        source,
        target,
        ...(branch ? { branch } : {}),
      })),
    },
  });
}
const extractedInvoice = {
  invoiceNumber: "ORIGINAL",
  total: 2,
  invoiceDate: "2026-10-30",
};
function extractionProvider(
  value: unknown,
  onCall = () => {},
): ProviderFactory {
  return () => ({
    async *stream() {
      onCall();
      yield {
        type: "token",
        text: typeof value === "string" ? value : JSON.stringify(value),
      };
      yield { type: "usage", inputTokens: 5, outputTokens: 5 };
    },
  });
}
test("acceptance: Structured AI → human edit → Action → typed condition → output, with two durable human tasks", async () => {
  const definition = reviewFlow(),
    id = await create(definition),
    published = await publish(id);
  const rid = await run(id, "invoice to extract", published);
  let extractions = 0;
  const factory = extractionProvider(extractedInvoice, () => extractions++);
  await processWorkflowRun({ providerFactory: factory });
  let result = await inspect(rid);
  assert.equal(result.status, "waiting");
  assert.equal(result.approvals[0].node_id, "review");
  assert.equal(
    result.nodes.find((n: { node_id: string }) => n.node_id === "extract")
      .input_tokens,
    5,
  );
  const invalid = await call("POST", `/workflow-runs/${rid}/approval`, {
    decision: "approved",
    nodeId: "review",
    editedInput: { ...extractedInvoice, total: "wrong" },
  });
  assert.equal(invalid.statusCode, 400, invalid.body);
  const invalidDate = await call("POST", `/workflow-runs/${rid}/approval`, {
    decision: "approved",
    editedInput: { ...extractedInvoice, invoiceDate: "2026-02-30" },
  });
  assert.equal(invalidDate.statusCode, 400, invalidDate.body);
  const wrongTask = await call("POST", `/workflow-runs/${rid}/approval`, {
    decision: "approved",
    nodeId: "confirm",
  });
  assert.equal(wrongTask.statusCode, 409, wrongTask.body);
  const approved = await call("POST", `/workflow-runs/${rid}/approval`, {
    decision: "approved",
    nodeId: "review",
    editedInput: {
      ...extractedInvoice,
      invoiceNumber: "EDITED-123",
      total: 12000,
    },
  });
  assert.equal(approved.statusCode, 200, approved.body);
  await processWorkflowRun({ providerFactory: factory });
  result = await inspect(rid);
  assert.equal(result.status, "waiting");
  assert.equal(
    result.approvals.filter(
      (a: { decision: string }) => a.decision === "pending",
    )[0].node_id,
    "confirm",
  );
  assert.equal(
    result.nodes.find((n: { node_id: string }) => n.node_id === "lookup").output
      .query,
    "EDITED-123",
  );
  assert.equal(
    result.nodes.find((n: { node_id: string }) => n.node_id === "review").output
      .total,
    12000,
  );
  assert.equal(extractions, 1, "upstream AI must not replay on approval");
  const cannotEdit = await call("POST", `/workflow-runs/${rid}/approval`, {
    decision: "approved",
    nodeId: "confirm",
    editedInput: {},
  });
  assert.equal(cannotEdit.statusCode, 400, cannotEdit.body);
  const confirmed = await call("POST", `/workflow-runs/${rid}/approval`, {
    decision: "approved",
    nodeId: "confirm",
  });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  await processWorkflowRun({ providerFactory: factory });
  result = await inspect(rid);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(result.output, {
    high: { route: "finance", invoiceNumber: "EDITED-123" },
  });
  assert.equal(extractions, 1);
});

test("Structured AI rejects malformed JSON, wrong types and dates without creating a human task", async () => {
  for (const value of [
    "not JSON",
    { ...extractedInvoice, total: "2" },
    { ...extractedInvoice, invoiceDate: "2026-02-30" },
  ]) {
    const id = await create(reviewFlow()),
      rid = await run(id, "invoice");
    await processWorkflowRun({ providerFactory: extractionProvider(value) });
    const result = await inspect(rid);
    assert.equal(result.status, "failed");
    assert.equal(result.error_code, "STRUCTURED_AI_OUTPUT_INVALID");
    assert.equal(result.approvals.length, 0);
  }
});

test("Set Variable is checkpointed and Switch selects a named case or default without executing other routes", async () => {
  for (const [priority, expected] of [
    ["high", "finance"],
    ["other", "fallback"],
  ]) {
    const definition = workflowDefinitionV2.parse({
      schemaVersion: 2,
      execution: {
        variables: { priority: "unset" },
        nodes: [
          { id: "start", kind: "input", label: "Input", config: {} },
          {
            id: "set",
            kind: "set-variable",
            label: "Set priority",
            config: { name: "priority", value: reference("input.priority") },
          },
          {
            id: "review",
            kind: "human-task",
            label: "Pause",
            config: {
              mode: "approve-reject",
              prompt: "Approve route",
              outputSchema: {},
            },
          },
          {
            id: "route",
            kind: "switch",
            label: "Switch",
            config: {
              value: reference("variables.priority"),
              cases: [
                { id: "high", label: "High", value: "high" },
                { id: "low", label: "Low", value: "low" },
              ],
            },
          },
          ...["finance", "automatic", "fallback"].map((id) => ({
            id,
            kind: "transform",
            label: id,
            config: {
              fields: {
                route: literal(id),
                priority: reference("variables.priority"),
              },
            },
          })),
          { id: "join", kind: "merge", label: "Join", config: {} },
          { id: "end", kind: "output", label: "Output", config: {} },
        ],
        edges: [
          ["start", "set"],
          ["set", "review"],
          ["review", "route"],
          ["route", "finance", "high"],
          ["route", "automatic", "low"],
          ["route", "fallback", "default"],
          ["finance", "join"],
          ["automatic", "join"],
          ["fallback", "join"],
          ["join", "end"],
        ].map(([source, target, branch], i) => ({
          id: "e_" + i,
          source,
          target,
          ...(branch ? { branch } : {}),
        })),
      },
    });
    const id = await create(definition),
      rid = await run(id, { priority });
    await processWorkflowRun();
    assert.equal((await inspect(rid)).status, "waiting");
    assert.equal(
      (
        await call("POST", `/workflow-runs/${rid}/approval`, {
          nodeId: "review",
          decision: "approved",
        })
      ).statusCode,
      200,
    );
    await processWorkflowRun();
    const result = await inspect(rid);
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.deepEqual(result.output, {
      [expected!]: { route: expected, priority },
    });
    assert.equal(
      result.nodes.filter((n: { node_id: string }) =>
        ["finance", "automatic", "fallback"].includes(n.node_id),
      ).length,
      1,
    );
  }
});

test("workflow resource catalog returns schemas and references without credentials", async () => {
  const response = await call(
    "GET",
    `/workspaces/${workspace}/workflow-catalog`,
  );
  assert.equal(response.statusCode, 200, response.body);
  const catalog = response.json();
  assert.ok(catalog.models.some((m: { id: string }) => m.id === modelId));
  assert.ok(
    catalog.agents.some((a: { agent_id: string }) => a.agent_id === agentId),
  );
  assert.equal(
    catalog.actions.find((a: { id: string }) => a.id === toolId).inputSchema
      .properties.query.type,
    "string",
  );
  assert.ok(!response.body.includes("ciphertext"));
  assert.ok(!response.body.includes("https://api.openai.com"));
});

test("more than three sequential human tasks resume independently without exhausting worker recovery", async () => {
  const definition = workflowDefinitionV2.parse({
    schemaVersion: 2,
    execution: {
      nodes: [
        { id: "start", kind: "input", label: "Input", config: {} },
        ...[0, 1, 2, 3].map((i) => ({
          id: "human_" + i,
          kind: "human-task",
          label: "Review " + i,
          config: {
            mode: "approve-reject",
            prompt: "Approve stage " + i,
            outputSchema: { type: "string" },
          },
        })),
        { id: "end", kind: "output", label: "Output", config: {} },
      ],
      edges: ["start", "human_0", "human_1", "human_2", "human_3", "end"]
        .slice(0, -1)
        .map((id, i, list) => ({
          id: "edge_" + i,
          source: id,
          target: list[i + 1] ?? "end",
        })),
    },
  });
  const id = await create(definition),
    rid = await run(id, "four reviews");
  for (let i = 0; i < 4; i++) {
    await processWorkflowRun();
    assert.equal((await inspect(rid)).status, "waiting");
    const approved = await call("POST", `/workflow-runs/${rid}/approval`, {
      nodeId: "human_" + i,
      decision: "approved",
    });
    assert.equal(approved.statusCode, 200, approved.body);
  }
  await processWorkflowRun();
  const result = await inspect(rid);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.output, "four reviews");
});

function chain(steps: unknown[], resources = {}) {
  return workflowDefinitionV2.parse({
    schemaVersion: 2,
    execution: {
      resources,
      nodes: [
        { id: "start", kind: "input", label: "Input", config: {} },
        ...steps,
        { id: "end", kind: "output", label: "Output", config: {} },
      ],
      edges: ["start", ...steps.map((s) => (s as { id: string }).id), "end"]
        .slice(0, -1)
        .map((id, i, ids) => ({
          id: "e_" + i,
          source: id,
          target: ids[i + 1] ?? "end",
        })),
    },
  });
}
async function pump(
  rid: string,
  overrides: Parameters<typeof processWorkflowRun>[0] = {},
  expected = "completed",
) {
  for (let i = 0; i < 100; i++) {
    const result = await inspect(rid);
    if ([expected, "failed", "cancelled", "rejected"].includes(result.status))
      return result;
    await processWorkflowRun(overrides);
  }
  assert.fail("Bounded fixture did not reach its expected state");
}
test("durable waits release the worker and survive saver restart; timestamps and long waits are bounded", async () => {
  const id = await create(
      chain([
        {
          id: "pause",
          kind: "wait",
          label: "Wait",
          config: { mode: "duration", seconds: 3600 },
        },
      ]),
    ),
    rid = await run(id, "restart-safe value");
  await processWorkflowRun();
  assert.equal((await inspect(rid)).status, "waiting");
  assert.equal(
    await processWorkflowRun(),
    false,
    "no worker sleeps or holds the waiting run",
  );
  const [s] =
    await sql`SELECT due_at FROM workflow_suspensions WHERE run_id=${rid}`;
  assert.ok(new Date(s!.due_at).getTime() > Date.now() + 3500000);
  await closeWorkflowSaver();
  await sql`UPDATE workflow_suspensions SET due_at=now()-interval '1 second' WHERE run_id=${rid}`;
  await processWorkflowRun();
  assert.equal((await inspect(rid)).output, "restart-safe value");
  const until = await create(
      chain([
        {
          id: "pause",
          kind: "wait",
          label: "Until",
          config: { mode: "until", until: literal("2000-01-01T00:00:00Z") },
        },
      ]),
    ),
    urid = await run(until, "past deadline");
  assert.equal((await pump(urid)).output, "past deadline");
  const invalid = await create(
      chain([
        {
          id: "pause",
          kind: "wait",
          label: "Until",
          config: { mode: "until", until: literal("2099-01-01T00:00:00Z") },
        },
      ]),
    ),
    invalidRun = await run(invalid, "too far");
  assert.equal((await pump(invalidRun)).error_code, "WAIT_LIMIT_EXCEEDED");
});

test("Wait for Event uses expiring, rotatable, scoped bearer tokens and validates callback data", async () => {
  const id = await create(
      chain([
        {
          id: "event",
          kind: "wait-for-event",
          label: "External callback",
          config: {
            eventName: "invoice.processed",
            outputSchema: {
              type: "object",
              properties: { reference: { type: "string" } },
              required: ["reference"],
              additionalProperties: false,
            },
          },
        },
      ]),
    ),
    rid = await run(id, "invoice");
  await processWorkflowRun();
  let result = await inspect(rid);
  assert.equal(result.status, "waiting");
  const issue = await call("POST", `/workflow-runs/${rid}/event-token`, {
    nodeId: "event",
  });
  assert.equal(issue.statusCode, 200, issue.body);
  const first = issue.json();
  assert.equal(
    (
      await call(
        "POST",
        `/workflow-runs/${rid}/event-token`,
        { nodeId: "event" },
        viewerToken,
      )
    ).statusCode,
    403,
  );
  const rotated = (
    await call("POST", `/workflow-runs/${rid}/event-token`, { nodeId: "event" })
  ).json();
  const callback = (
    token: string,
    data: unknown,
    eventName = "invoice.processed",
  ) =>
    app.inject({
      method: "POST",
      url: rotated.callbackPath,
      headers: { authorization: "Bearer " + token },
      payload: { eventName, data },
    });
  assert.equal(
    (await callback(first.token, { reference: "old" })).statusCode,
    401,
  );
  assert.equal((await callback("a".repeat(64), {})).statusCode, 401);
  assert.equal(
    (await callback(rotated.token, { reference: 4 })).statusCode,
    400,
  );
  assert.equal(
    (await callback(rotated.token, { reference: "ok" }, "wrong")).statusCode,
    400,
  );
  const accepted = await callback(rotated.token, { reference: "accepted" });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(
    (await callback(rotated.token, { reference: "duplicate" })).statusCode,
    409,
  );
  await closeWorkflowSaver();
  await processWorkflowRun();
  result = await inspect(rid);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.output, { reference: "accepted" });
  assert.ok(!JSON.stringify(result).includes(rotated.token));
  const timeoutId = await create(
      chain([
        {
          id: "event",
          kind: "wait-for-event",
          label: "Timeout",
          config: { eventName: "never", timeoutSeconds: 1 },
        },
      ]),
    ),
    timeoutRun = await run(timeoutId, "waiting");
  await processWorkflowRun();
  await sql`UPDATE workflow_suspensions SET due_at=now()-interval '1 second' WHERE run_id=${timeoutRun}`;
  await processWorkflowRun();
  assert.equal(
    (await inspect(timeoutRun)).error_code,
    "WORKFLOW_EVENT_TIMEOUT",
  );
});

test("For Each executes published child flows sequentially, preserves item/index scope and records per-item failure", async () => {
  const body = chain(
    [
      {
        id: "extract",
        kind: "structured-ai",
        label: "Extract item",
        config: {
          resource: "model",
          input: reference("item.name"),
          instruction: "Return structured text",
          outputSchema: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        },
      },
      {
        id: "project",
        kind: "transform",
        label: "Item result",
        config: {
          fields: {
            name: reference("steps.extract.output.name"),
            index: reference("iteration.index"),
          },
        },
      },
    ],
    { model: { kind: "model", id: modelId } },
  );
  const bodyId = await create(body),
    bodyVersion = await publish(bodyId);
  const definition = chain(
    [
      {
        id: "loop",
        kind: "for-each",
        label: "Documents",
        config: {
          resource: "body",
          collection: reference("input.files"),
          failurePolicy: "continue",
          maxItems: 3,
        },
      },
    ],
    { body: { kind: "workflow", workflowId: bodyId, versionId: bodyVersion } },
  );
  const id = await create(definition),
    rid = await run(id, {
      files: [{ name: "one" }, { name: "bad" }, { name: "three" }],
    });
  let calls = 0;
  const provider: ProviderFactory = () => ({
    async *stream(input) {
      calls++;
      const name = input.messages[0]!.content;
      yield {
        type: "token",
        text: name === "bad" ? "malformed" : JSON.stringify({ name }),
      };
    },
  });
  const result = await pump(rid, { providerFactory: provider });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(result.output, [
    { index: 0, status: "completed", output: { name: "one", index: 0 } },
    {
      status: "failed",
      error: { code: "STRUCTURED_AI_OUTPUT_INVALID", index: 1 },
    },
    { index: 2, status: "completed", output: { name: "three", index: 2 } },
  ]);
  assert.equal(calls, 3);
  assert.equal(result.children.length, 3);
  assert.ok(
    result.children.every(
      (c: { version_id: string }) => c.version_id === bodyVersion,
    ),
  );
  const tooMany = await run(id, { files: [{}, {}, {}, {}] });
  assert.equal((await pump(tooMany)).error_code, "FOR_EACH_LIMIT_EXCEEDED");
  const empty = await run(id, { files: [] });
  assert.deepEqual((await pump(empty)).output, []);
  definition.execution.nodes.find(
    (n) => n.kind === "for-each",
  )!.config.failurePolicy = "fail-workflow";
  const failingId = await create(definition),
    failingRun = await run(failingId, {
      files: [{ name: "bad" }, { name: "never" }],
    });
  assert.equal(
    (await pump(failingRun, { providerFactory: provider })).error_code,
    "SUBWORKFLOW_FAILED",
  );
  assert.equal((await inspect(failingRun)).children.length, 1);
});

test("Subworkflow pins a published version, maps results, and prevents recursive workflow ancestry", async () => {
  const bodyId = await create(
      chain([
        {
          id: "project",
          kind: "transform",
          label: "Child",
          config: { fields: { result: reference("input.value") } },
        },
      ]),
    ),
    version = await publish(bodyId);
  const parent = await create(
      chain(
        [
          {
            id: "child",
            kind: "subworkflow",
            label: "Child flow",
            config: { resource: "body", outputPath: "/result" },
          },
        ],
        { body: { kind: "workflow", workflowId: bodyId, versionId: version } },
      ),
    ),
    rid = await run(parent, { value: "mapped child result" });
  const result = await pump(rid);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.output, "mapped child result");
  assert.equal(result.children[0].version_id, version);
  const a = await create(chain([])),
    av = await publish(a);
  const b = await create(
      chain(
        [
          {
            id: "a",
            kind: "subworkflow",
            label: "A",
            config: { resource: "a" },
          },
        ],
        { a: { kind: "workflow", workflowId: a, versionId: av } },
      ),
    ),
    bv = await publish(b);
  const revision = await call("PUT", `/workflows/${a}`, {
    revision: 1,
    name: "Recursive A",
    graph: chain(
      [{ id: "b", kind: "subworkflow", label: "B", config: { resource: "b" } }],
      { b: { kind: "workflow", workflowId: b, versionId: bv } },
    ),
  });
  assert.equal(revision.statusCode, 200, revision.body);
  const a2 = await call("POST", `/workflows/${a}/publish`, { revision: 2 });
  assert.equal(a2.statusCode, 400, a2.body);
  assert.match(a2.body, /recursive subworkflow/);
  const [versions] =
    await sql`SELECT count(*)::int AS count FROM workflow_versions WHERE workflow_id=${a}`;
  assert.equal(versions!.count, 1);
});

test("node error routing reaches Human Task with sanitized error context and skips the success route", async () => {
  const definition = workflowDefinitionV2.parse({
    schemaVersion: 2,
    execution: {
      resources: { model: { kind: "model", id: modelId } },
      nodes: [
        { id: "start", kind: "input", label: "Input", config: {} },
        {
          id: "extract",
          kind: "structured-ai",
          label: "Failing extraction",
          onError: "review",
          config: {
            resource: "model",
            instruction: "Extract fields",
            outputSchema: {},
          },
        },
        {
          id: "success",
          kind: "transform",
          label: "Success",
          config: { fields: { status: literal("success") } },
        },
        {
          id: "review",
          kind: "human-task",
          label: "Error review",
          config: {
            mode: "approve-reject",
            prompt: "Review safe failure details",
            input: reference("error"),
            outputSchema: {
              type: "object",
              required: ["code", "message", "nodeId", "attempt"],
            },
          },
        },
        { id: "join", kind: "merge", label: "Join", config: {} },
        { id: "end", kind: "output", label: "Output", config: {} },
      ],
      edges: [
        ["start", "extract"],
        ["extract", "success"],
        ["success", "join"],
        ["review", "join"],
        ["join", "end"],
      ].map(([source, target], i) => ({ id: "edge_" + i, source, target })),
    },
  });
  const id = await create(definition),
    rid = await run(id, "invoice");
  const failingProvider: ProviderFactory = () => ({
    async *stream() {
      yield* [];
      throw new Error("postgres://user:password@secret-host");
    },
  });
  await processWorkflowRun({ providerFactory: failingProvider });
  const waiting = await inspect(rid);
  assert.equal(waiting.status, "waiting", JSON.stringify(waiting));
  assert.deepEqual(waiting.approvals[0].input, {
    code: "WORKFLOW_EXECUTION_FAILED",
    message: "This step could not be completed.",
    nodeId: "extract",
    attempt: 1,
  });
  assert.ok(!JSON.stringify(waiting).includes("password"));
  assert.equal(
    waiting.nodes.some((n: { node_id: string }) => n.node_id === "success"),
    false,
  );
  assert.equal(
    (
      await call("POST", `/workflow-runs/${rid}/approval`, {
        nodeId: "review",
        decision: "approved",
      })
    ).statusCode,
    200,
  );
  await processWorkflowRun({ providerFactory: failingProvider });
  assert.equal((await inspect(rid)).status, "completed");
});

test("V2 Parallel/Merge supports typed references and independent human gates across saver restart", async () => {
  const definition = workflowDefinitionV2.parse({
    schemaVersion: 2,
    execution: {
      nodes: [
        { id: "start", kind: "input", label: "Input", config: {} },
        { id: "fork", kind: "parallel", label: "Parallel", config: {} },
        {
          id: "left",
          kind: "transform",
          label: "Left data",
          config: {
            fields: {
              value: literal("left"),
              amount: reference("input.amount"),
            },
          },
        },
        {
          id: "right",
          kind: "transform",
          label: "Right data",
          config: {
            fields: {
              value: literal("right"),
              amount: reference("input.amount"),
            },
          },
        },
        ...["left", "right"].map((id) => ({
          id: "review_" + id,
          kind: "human-task",
          label: "Review " + id,
          config: {
            mode: "review-edit",
            prompt: "Approve " + id,
            outputSchema: { type: "object" },
          },
        })),
        { id: "join", kind: "merge", label: "Join", config: {} },
        {
          id: "project",
          kind: "transform",
          label: "Aggregate typed data",
          config: {
            fields: {
              left: reference("steps.review_left.output.value"),
              right: reference("steps.review_right.output.value"),
            },
          },
        },
        { id: "end", kind: "output", label: "Output", config: {} },
      ],
      edges: [
        ["start", "fork"],
        ["fork", "left"],
        ["fork", "right"],
        ["left", "review_left"],
        ["right", "review_right"],
        ["review_left", "join"],
        ["review_right", "join"],
        ["join", "project"],
        ["project", "end"],
      ].map(([source, target], i) => ({ id: "edge_" + i, source, target })),
    },
  });
  const id = await create(definition),
    rid = await run(id, { amount: 7 });
  await processWorkflowRun();
  assert.equal(
    (await inspect(rid)).approvals.filter(
      (a: { decision: string }) => a.decision === "pending",
    ).length,
    2,
  );
  assert.equal(
    (
      await call("POST", `/workflow-runs/${rid}/approval`, {
        decision: "approved",
      })
    ).statusCode,
    409,
    "ambiguous approvals must select a node",
  );
  assert.equal(
    (
      await call("POST", `/workflow-runs/${rid}/approval`, {
        nodeId: "review_left",
        decision: "approved",
        editedInput: { value: "left edited", amount: 7 },
      })
    ).statusCode,
    200,
  );
  await processWorkflowRun();
  assert.equal((await inspect(rid)).status, "waiting");
  await closeWorkflowSaver();
  assert.equal(
    (
      await call("POST", `/workflow-runs/${rid}/approval`, {
        nodeId: "review_right",
        decision: "approved",
      })
    ).statusCode,
    200,
  );
  await processWorkflowRun();
  const result = await inspect(rid);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(result.output, { left: "left edited", right: "right" });
});

test("multiple HITL sequence: extraction → review → Action → finance approval → Action → output", async () => {
  const definition = chain(
    [
      {
        id: "extract",
        kind: "structured-ai",
        label: "Extract",
        config: {
          resource: "model",
          instruction: "Extract invoice",
          outputSchema: invoiceSchema,
        },
      },
      {
        id: "review",
        kind: "human-task",
        label: "Human review",
        config: {
          mode: "review-edit",
          prompt: "Review invoice",
          outputSchema: invoiceSchema,
        },
      },
      {
        id: "first",
        kind: "action",
        label: "First Action",
        config: {
          actionId: "lookup",
          inputs: { query: reference("steps.review.output.invoiceNumber") },
        },
      },
      {
        id: "finance",
        kind: "human-task",
        label: "Finance approval",
        config: {
          mode: "approve-reject",
          prompt: "Finance approval",
          outputSchema: { type: "object" },
        },
      },
      {
        id: "second",
        kind: "action",
        label: "Second Action",
        config: {
          actionId: "lookup",
          inputs: { query: literal("finance-approved") },
        },
      },
    ],
    { model: { kind: "model", id: modelId } },
  );
  definition.execution.actions = flow().execution.actions;
  const id = await create(definition),
    rid = await run(id, "document");
  let aiCalls = 0;
  const factory = extractionProvider(extractedInvoice, () => aiCalls++),
    previousCalls = calls;
  await processWorkflowRun({ providerFactory: factory });
  assert.equal(
    (
      await call("POST", `/workflow-runs/${rid}/approval`, {
        nodeId: "review",
        decision: "approved",
        editedInput: { ...extractedInvoice, invoiceNumber: "REVIEWED" },
      })
    ).statusCode,
    200,
  );
  await processWorkflowRun({ providerFactory: factory });
  let result = await inspect(rid);
  assert.equal(result.status, "waiting");
  assert.equal(calls, previousCalls + 1);
  assert.equal(
    result.nodes.find((n: { node_id: string }) => n.node_id === "first").output
      .query,
    "REVIEWED",
  );
  assert.equal(
    (
      await call("POST", `/workflow-runs/${rid}/approval`, {
        nodeId: "finance",
        decision: "approved",
      })
    ).statusCode,
    200,
  );
  await closeWorkflowSaver();
  await processWorkflowRun({ providerFactory: factory });
  result = await inspect(rid);
  assert.equal(result.status, "completed");
  assert.equal(result.output.query, "finance-approved");
  assert.equal(calls, previousCalls + 2);
  assert.equal(aiCalls, 1);
});

test("document-processing acceptance: approved sample, durable per-document child flow, mock persistence/validation, aggregate and error review", async () => {
  // External persistence is intentionally a mock behind the registered Tool adapter.
  const body = chain(
    [
      {
        id: "extract",
        kind: "structured-ai",
        label: "Extract using approved sample",
        config: {
          resource: "model",
          input: reference("input"),
          instruction: "Extract remaining document using approved sample",
          outputSchema: {
            type: "object",
            required: ["invoiceNumber", "total", "command"],
            properties: {
              invoiceNumber: { type: "string" },
              total: { type: "number" },
              command: { type: "string" },
            },
          },
        },
      },
      {
        id: "persist",
        kind: "action",
        label: "Persist result (mock integration)",
        config: {
          actionId: "external",
          inputs: { query: reference("steps.extract.output.command") },
        },
      },
      {
        id: "read",
        kind: "action",
        label: "Read / validate persisted data",
        config: {
          actionId: "read_external",
          inputs: { query: reference("steps.persist.output.readKey") },
        },
      },
      {
        id: "result",
        kind: "transform",
        label: "Validated record",
        config: {
          fields: {
            invoiceNumber: reference("steps.extract.output.invoiceNumber"),
            total: reference("steps.extract.output.total"),
            stored: reference("steps.read.output.record"),
            valid: reference("steps.read.output.valid"),
          },
        },
      },
    ],
    { model: { kind: "model", id: modelId } },
  );
  body.execution.actions = flow().execution.actions.map((a) => ({
    ...a,
    id: "external",
    mappedInputs: {},
    staticInputs: {},
    outputSchema: {},
  }));
  body.execution.actions.push({
    ...body.execution.actions[0]!,
    id: "read_external",
    outputSchema: {
      type: "object",
      required: ["valid", "record"],
      properties: { valid: { const: true }, record: { type: "object" } },
    },
  });
  const bodyId = await create(body),
    bv = await publish(bodyId);
  const definition = workflowDefinitionV2.parse({
    schemaVersion: 2,
    execution: {
      resources: {
        model: { kind: "model", id: modelId },
        body: { kind: "workflow", workflowId: bodyId, versionId: bv },
      },
      nodes: [
        {
          id: "start",
          kind: "input",
          label: "OCR/PDF document input",
          config: {},
        },
        {
          id: "sample",
          kind: "structured-ai",
          label: "Extract sample",
          config: {
            resource: "model",
            input: reference("input.documents[0]"),
            instruction: "Extract sample invoice",
            outputSchema: invoiceSchema,
          },
        },
        {
          id: "review",
          kind: "human-task",
          label: "Human Review/Edit sample",
          config: {
            mode: "review-edit",
            prompt: "Approve sample for processing",
            approveLabel: "Process",
            outputSchema: invoiceSchema,
          },
        },
        {
          id: "loop",
          kind: "for-each",
          label: "Remaining documents",
          config: {
            resource: "body",
            collection: reference("input.documents"),
            startIndex: 1,
            maxItems: 4,
            failurePolicy: "continue",
            itemInputs: {
              document: reference("item"),
              approvedSample: reference("steps.review.output"),
              index: reference("iteration.index"),
            },
          },
        },
        {
          id: "aggregate",
          kind: "transform",
          label: "Aggregate",
          config: {
            fields: {
              sample: reference("steps.review.output"),
              results: reference("steps.loop.output"),
              failed: reference("steps.loop.summary.failed"),
            },
          },
        },
        {
          id: "check",
          kind: "condition",
          label: "Success / failure",
          config: {
            condition: {
              operator: "equals",
              left: reference("steps.loop.summary.failed"),
              right: literal(0),
            },
          },
        },
        {
          id: "complete",
          kind: "transform",
          label: "Complete",
          config: {
            fields: {
              status: literal("complete"),
              data: reference("steps.aggregate.output"),
            },
          },
        },
        {
          id: "error_review",
          kind: "human-task",
          label: "Human Error Review",
          config: {
            mode: "review-edit",
            prompt: "Review failed documents",
            input: reference("steps.aggregate.output"),
            outputSchema: {
              type: "object",
              required: ["sample", "results", "failed"],
            },
          },
        },
        { id: "join", kind: "merge", label: "Completion", config: {} },
        { id: "end", kind: "output", label: "Output", config: {} },
      ],
      edges: [
        ["start", "sample"],
        ["sample", "review"],
        ["review", "loop"],
        ["loop", "aggregate"],
        ["aggregate", "check"],
        ["check", "complete", "true"],
        ["check", "error_review", "false"],
        ["complete", "join"],
        ["error_review", "join"],
        ["join", "end"],
      ].map(([source, target, branch], i) => ({
        id: "e_" + i,
        source,
        target,
        ...(branch ? { branch } : {}),
      })),
    },
  });
  const id = await create(definition),
    published = await publish(id);
  for (const fail of [false, true]) {
    const documents = [
      {
        name: "sample.pdf",
        mimeType: "application/pdf",
        ocrText: "sample invoice",
      },
      {
        name: "scan.png",
        mimeType: "image/png",
        ocrText: "OCR invoice 2",
        invoiceNumber: "DOC-2",
        amount: 10,
      },
      {
        name: "invoice.pdf",
        mimeType: "application/pdf",
        ocrText: "PDF text invoice 3",
        invoiceNumber: fail ? "FAIL" : "DOC-3",
        amount: 20,
      },
    ];
    const rid = await run(id, { documents }, published),
      contexts: {
        approvedSample: { total: number };
        document: { invoiceNumber: string; amount: number };
        index: number;
      }[] = [];
    let sampleCalls = 0;
    const provider: ProviderFactory = () => ({
      async *stream(input) {
        let output: unknown;
        if (input.system.startsWith("Extract sample")) {
          sampleCalls++;
          output = extractedInvoice;
        } else {
          const value = JSON.parse(input.messages[0]!.content);
          contexts.push(value);
          const record = {
            invoiceNumber: value.document.invoiceNumber,
            total: value.approvedSample.total + value.document.amount,
          };
          output = { ...record, command: "persist:" + JSON.stringify(record) };
        }
        yield { type: "token", text: JSON.stringify(output) };
      },
    });
    await processWorkflowRun({ providerFactory: provider });
    assert.equal((await inspect(rid)).status, "waiting");
    assert.equal(
      (
        await call("POST", `/workflow-runs/${rid}/approval`, {
          nodeId: "review",
          decision: "approved",
          editedInput: {
            ...extractedInvoice,
            invoiceNumber: "SAMPLE-APPROVED",
            total: 123,
          },
        })
      ).statusCode,
      200,
    );
    await closeWorkflowSaver();
    let result = await pump(
      rid,
      { providerFactory: provider },
      fail ? "waiting" : "completed",
    );
    // pump must first execute the queued root segment before stopping at the later waiting gate.
    if (
      fail &&
      !result.approvals.some(
        (a: { node_id: string }) => a.node_id === "error_review",
      )
    ) {
      for (let i = 0; i < 40; i++) {
        await processWorkflowRun({ providerFactory: provider });
        result = await inspect(rid);
        if (
          result.approvals.some(
            (a: { node_id: string }) => a.node_id === "error_review",
          )
        )
          break;
      }
    }
    assert.equal(contexts.length, 2);
    assert.ok(contexts.every((c) => c.approvedSample.total === 123));
    assert.deepEqual(
      contexts.map((c) => c.index),
      [1, 2],
    );
    assert.equal(sampleCalls, 1);
    assert.equal(result.children.length, 2);
    if (fail) {
      assert.equal(result.status, "waiting", JSON.stringify(result));
      const errorReview = result.approvals.find(
        (a: { node_id: string }) => a.node_id === "error_review",
      );
      assert.equal(errorReview.input.failed, 1);
      assert.equal(
        (
          await call("POST", `/workflow-runs/${rid}/approval`, {
            nodeId: "error_review",
            decision: "approved",
          })
        ).statusCode,
        200,
      );
      result = await pump(rid, { providerFactory: provider });
    }
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(
      (persistedInvoices.get("DOC-2") as { total: number }).total,
      133,
    );
    if (!fail)
      assert.equal(
        result.output.complete.data.results.every(
          (r: { output: { valid: boolean } }) => r.output.valid,
        ),
        true,
      );
  }
});

test("latest-published is resolved once per invocation and remains pinned across waits and new publications", async () => {
  const body = chain([
    {
      id: "result",
      kind: "transform",
      label: "Version",
      config: { fields: { version: literal("one") } },
    },
  ]);
  const bodyId = await create(body),
    firstVersion = await publish(bodyId);
  const id = await create(
    chain(
      [
        {
          id: "child",
          kind: "subworkflow",
          label: "Latest published",
          config: { resource: "body", outputPath: "/version" },
        },
      ],
      {
        body: {
          kind: "workflow",
          workflowId: bodyId,
          versionBehavior: "latest-published",
        },
      },
    ),
  );
  const firstRun = await run(id, "version test");
  await processWorkflowRun();
  const [pin] =
    await sql`SELECT payload FROM workflow_suspensions WHERE run_id=${firstRun}`;
  assert.equal(pin!.payload.versionId, firstVersion);
  const updated = chain([
    {
      id: "result",
      kind: "transform",
      label: "Version",
      config: { fields: { version: literal("two") } },
    },
  ]);
  assert.equal(
    (
      await call("PUT", `/workflows/${bodyId}`, {
        revision: 1,
        name: "Body two",
        graph: updated,
      })
    ).statusCode,
    200,
  );
  const secondVersion = await call("POST", `/workflows/${bodyId}/publish`, {
    revision: 2,
  });
  assert.equal(secondVersion.statusCode, 201, secondVersion.body);
  await closeWorkflowSaver();
  assert.equal((await pump(firstRun)).output, "one");
  const secondRun = await run(id, "next invocation");
  const result = await pump(secondRun);
  assert.equal(result.output, "two");
  assert.equal(result.children[0].version_id, secondVersion.json().id);
});

test("parent cancellation stops parked child runs and concurrent suspension polls never duplicate children", async () => {
  const bodyId = await create(
      chain([
        {
          id: "wait",
          kind: "wait",
          label: "Parked child",
          config: { mode: "duration", seconds: 3600 },
        },
      ]),
    ),
    version = await publish(bodyId);
  const id = await create(
      chain(
        [
          {
            id: "child",
            kind: "subworkflow",
            label: "Child",
            config: { resource: "body" },
          },
        ],
        { body: { kind: "workflow", workflowId: bodyId, versionId: version } },
      ),
    ),
    rid = await run(id, "cancel tree");
  await processWorkflowRun();
  const { wakeWorkflowSuspensions } =
    await import("../src/workflow-control.js");
  await Promise.all([
    wakeWorkflowSuspensions(),
    wakeWorkflowSuspensions(),
    wakeWorkflowSuspensions(),
  ]);
  assert.equal((await inspect(rid)).children.length, 1);
  await processWorkflowRun();
  const [child] =
    await sql`SELECT id,status FROM workflow_runs WHERE parent_run_id=${rid}`;
  assert.equal(child!.status, "waiting");
  assert.equal(
    (await call("POST", `/workflow-runs/${rid}/cancel`)).statusCode,
    200,
  );
  await processWorkflowRun();
  const result = await inspect(child!.id);
  assert.equal(result.status, "cancelled");
  assert.equal(result.suspensions[0].status, "cancelled");
});

test("retention keeps completed child outputs while the parent is active and prunes finished trees leaf-first", async () => {
  const bodyId = await create(chain([])),
    version = await publish(bodyId);
  const definition = chain(
    [
      {
        id: "child",
        kind: "subworkflow",
        label: "Child",
        config: { resource: "body" },
      },
      {
        id: "hold",
        kind: "wait",
        label: "Long hold",
        config: { mode: "duration", seconds: 3600 },
      },
    ],
    { body: { kind: "workflow", workflowId: bodyId, versionId: version } },
  );
  const id = await create(definition),
    rid = await run(id, "retain child");
  for (let i = 0; i < 8; i++) await processWorkflowRun();
  const result = await inspect(rid);
  assert.equal(result.status, "waiting");
  const childId = result.children[0].id;
  await sql`UPDATE workflow_runs SET finished_at=now()-interval '40 days' WHERE id=${childId}`;
  const { retentionCandidates } = await import("../src/retention.js");
  const policy = {
    workspace_id: workspace,
    organization_id: org,
    revision: 1,
    enabled: true,
    conversation_days: null,
    run_days: 30,
    artifact_days: null,
    connector_days: null,
    updated_by: owner,
    next_run_at: null,
  };
  assert.equal(
    (await retentionCandidates(sql, policy, new Date())).workflowRuns.includes(
      childId,
    ),
    false,
  );
  await call("POST", `/workflow-runs/${rid}/cancel`);
  await processWorkflowRun();
  await sql`UPDATE workflow_runs SET finished_at=now()-interval '40 days' WHERE id=${rid}`;
  const candidates = await retentionCandidates(sql, policy, new Date());
  assert.ok(candidates.workflowRuns.includes(childId));
  assert.equal(candidates.workflowRuns.includes(rid), false);
});

test("child-run database identity rejects duplicate iterations and cross-tenant parent linkage", async () => {
  const [existing] =
    await sql`SELECT * FROM workflow_runs WHERE organization_id=${org} AND parent_run_id IS NOT NULL LIMIT 1`;
  assert.ok(existing);
  await assert.rejects(
    sql`INSERT INTO workflow_runs(id,workflow_id,version_id,workspace_id,organization_id,user_id,graph_snapshot,input,status,parent_run_id,parent_node_id,iteration_index) VALUES (${randomUUID()},${existing.workflow_id},${existing.version_id},${workspace},${org},${owner},${sql.json(existing.graph_snapshot)},'duplicate','completed',${existing.parent_run_id},${existing.parent_node_id},${existing.iteration_index})`,
    (e: unknown) => (e as { code: string }).code === "23505",
  );
  await assert.rejects(
    sql`INSERT INTO workflow_runs(id,workflow_id,version_id,workspace_id,organization_id,user_id,graph_snapshot,input,status,parent_run_id,parent_node_id,iteration_index) VALUES (${randomUUID()},${existing.workflow_id},${existing.version_id},${workspace},${org},${owner},${sql.json(existing.graph_snapshot)},'missing-index','completed',${existing.parent_run_id},'missing_index',NULL)`,
    (e: unknown) => (e as { code: string }).code === "23514",
  );
  const foreignWorkflow = await call(
    "POST",
    `/workspaces/${foreign}/workflows`,
    { name: "Foreign child target", graph: chain([]) },
  );
  assert.equal(foreignWorkflow.statusCode, 201, foreignWorkflow.body);
  await assert.rejects(
    sql`INSERT INTO workflow_runs(id,workflow_id,workspace_id,organization_id,user_id,graph_snapshot,input,status,parent_run_id,parent_node_id,iteration_index) VALUES (${randomUUID()},${foreignWorkflow.json().id},${foreign},${org},${owner},${sql.json(existing.graph_snapshot)},'foreign','completed',${existing.parent_run_id},'foreign',0)`,
    (e: unknown) =>
      (e as { constraint_name: string }).constraint_name ===
      "workflow_parent_tenant",
  );
});

test("For Each preserves typed primitive and array items in V2 child input and scope", async () => {
  const bodyId = await create(
      chain([
        {
          id: "value",
          kind: "transform",
          label: "Typed item",
          config: {
            fields: {
              input: reference("input"),
              item: reference("item"),
              index: reference("iteration.index"),
            },
          },
        },
      ]),
    ),
    version = await publish(bodyId);
  const id = await create(
    chain(
      [
        {
          id: "loop",
          kind: "for-each",
          label: "Values",
          config: { resource: "body", collection: reference("input.items") },
        },
      ],
      { body: { kind: "workflow", workflowId: bodyId, versionId: version } },
    ),
  );
  const values = [1, false, null, ["a", "b"], "", "123", "false", "null", "  "],
    rid = await run(id, { items: values }),
    result = await pump(rid);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(
    result.output,
    values.map((value, index) => ({
      index,
      status: "completed",
      output: { input: value, item: value, index },
    })),
  );
});

test("the root descendant budget blocks further scheduling across all child nodes", async () => {
  const body = chain([]),
    bodyId = await create(body),
    version = await publish(bodyId);
  const id = await create(
      chain(
        [
          {
            id: "loop",
            kind: "for-each",
            label: "Budgeted items",
            config: { resource: "body", collection: reference("input.items") },
          },
        ],
        { body: { kind: "workflow", workflowId: bodyId, versionId: version } },
      ),
    ),
    rid = await run(id, { items: ["one"] });
  await processWorkflowRun();
  const graph = storedWorkflowGraph(body);
  await sql`INSERT INTO workflow_runs(id,workflow_id,version_id,workspace_id,organization_id,user_id,graph_snapshot,input,status,parent_run_id,parent_node_id,iteration_index,finished_at) SELECT gen_random_uuid(),${bodyId},${version},${workspace},${org},${owner},${sql.json(graph)},'budget fixture','completed',${rid},'other_node',n,now() FROM generate_series(0,99) AS n`;
  await processWorkflowRun();
  const result = await inspect(rid);
  assert.equal(result.status, "failed");
  assert.equal(result.error_code, "WORKFLOW_CHILD_LIMIT");
  assert.equal(
    result.children.filter(
      (c: { parent_node_id: string }) => c.parent_node_id === "loop",
    ).length,
    0,
  );
});

const httpAction = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  connectionId?: string,
  path = "echo",
) =>
  workflowAction.parse({
    id: "request",
    name: "HTTP request",
    connector: "agentconnect.http",
    operation: method,
    connectionId,
    sideEffect:
      method === "GET" ? "read" : method === "DELETE" ? "delete" : "write",
    riskLevel: method === "GET" ? "low" : "high",
    allowSideEffects: method !== "GET",
    idempotency: method === "GET" ? "not-required" : "unsupported",
    http: {
      method,
      url: literal(`http://127.0.0.1:4549/actions/${path}`),
      query: { q: reference("arguments.value") },
      ...(method !== "GET" ? { body: reference("arguments") } : {}),
    },
    staticInputs: { value: "static" },
    mappedInputs: { value: reference("input.value") },
  });
async function actionFlow(
  action: ReturnType<typeof workflowAction.parse>,
  input: unknown = { value: "mapped" },
) {
  const definition = chain([
    {
      id: "request",
      kind: "action",
      label: "Request",
      config: { actionId: action.id },
    },
  ]);
  definition.execution.actions = [action];
  const id = await create(definition),
    rid = await run(id, input);
  return {
    id,
    rid,
    definition,
    ctx: {
      workspaceId: workspace,
      organizationId: org,
      userId: owner,
      workflowId: id,
      workflowRunId: rid,
      workflowNodeId: "request",
    },
  };
}
test("native HTTP Actions support five methods, saved encrypted auth, mapped/static inputs, and secret-safe audit", async () => {
  const secret = await call("POST", `/workspaces/${workspace}/secrets`, {
    name: "ACTION_AUTH",
    value: "fixture-action-credential",
  });
  assert.equal(secret.statusCode, 201, secret.body);
  const secrets = await call("GET", `/workspaces/${workspace}/secrets`);
  const secretId = secrets
    .json()
    .find((s: { name: string }) => s.name === "ACTION_AUTH").id;
  const connection = await call(
    "POST",
    `/workspaces/${workspace}/action-connections`,
    {
      name: "HTTP API",
      baseUrl: "http://127.0.0.1:4549/actions",
      auth: "bearer",
      secretId,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      idempotencySupported: true,
    },
  );
  assert.equal(connection.statusCode, 201, connection.body);
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
    const action = httpAction(method, connection.json().id);
    const { rid } = await actionFlow(action);
    await processWorkflowRun({ providerFactory: provider });
    const result = await inspect(rid);
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.output.method, method);
    assert.equal(result.output.query, "mapped");
    if (method !== "GET")
      assert.deepEqual(result.output.body, { value: "mapped" });
    assert.ok(!JSON.stringify(result).includes("fixture-action-credential"));
    assert.equal(result.actionExecutions.length, 1);
    assert.equal(result.actionExecutions[0].status, "completed");
    assert.equal(result.actionExecutions[0].attempts, 1);
  }
  const catalog = await call(
    "GET",
    `/workspaces/${workspace}/action-connections`,
  );
  assert.ok(!catalog.body.includes("fixture-action-credential"));
  const foreignAction = httpAction("GET", connection.json().id);
  await assert.rejects(() =>
    executeWorkflowAction(
      foreignAction,
      { value: "x" },
      { workspaceId: foreign, organizationId: org, userId: owner },
      AbortSignal.timeout(1000),
    ),
  );
});
test("native HTTP retries use stable idempotency and completed results survive replay; ambiguous writes are never repeated", async () => {
  const connection = await call(
    "POST",
    `/workspaces/${workspace}/action-connections`,
    {
      name: "Idempotent API",
      baseUrl: "http://127.0.0.1:4549/actions",
      methods: ["POST"],
      idempotencySupported: true,
    },
  );
  assert.equal(connection.statusCode, 201, connection.body);
  const action = workflowAction.parse({
    ...httpAction("POST", connection.json().id, "retry"),
    idempotency: "key",
    retry: { maxAttempts: 2, delayMs: 100 },
  });
  const { rid, ctx } = await actionFlow(action);
  const before = actionRequests.length;
  await processWorkflowRun({ providerFactory: provider });
  const result = await inspect(rid);
  assert.equal(result.status, "completed", JSON.stringify(result));
  const requests = actionRequests.slice(before);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.key, requests[1]!.key);
  assert.ok(requests[0]!.key);
  assert.equal(result.actionExecutions[0].attempts, 2);
  const cached = await executeWorkflowAction(
    action,
    { value: "mapped" },
    ctx,
    AbortSignal.timeout(1000),
  );
  assert.deepEqual(cached, result.output);
  assert.equal(actionRequests.length, before + 2);
  const unsafe = httpAction("POST", undefined, "drop"),
    fixture = await actionFlow(unsafe);
  const baseline = actionRequests.length;
  await processWorkflowRun({ providerFactory: provider });
  const failed = await inspect(fixture.rid);
  assert.equal(failed.status, "failed");
  assert.equal(failed.actionExecutions[0].status, "uncertain");
  await assert.rejects(
    () =>
      executeWorkflowAction(
        unsafe,
        { value: "mapped" },
        fixture.ctx,
        AbortSignal.timeout(1000),
      ),
    /ACTION_OUTCOME_UNKNOWN/,
  );
  assert.equal(actionRequests.length, baseline + 1);
});
test("HTTP Actions reject unsafe headers, credentials in JSON, saved-connection boundary escapes, redirects and invalid output", async () => {
  const conn = await call(
    "POST",
    `/workspaces/${workspace}/action-connections`,
    {
      name: "Restricted API",
      baseUrl: "http://127.0.0.1:4549/actions",
      methods: ["GET"],
    },
  );
  for (const action of [
    {
      ...httpAction("GET"),
      http: {
        method: "GET",
        url: literal("http://127.0.0.1:4549/actions/echo?api_key=embedded-key"),
      },
    },
    {
      ...httpAction("GET", conn.json().id),
      http: { method: "GET", url: literal("http://127.0.0.1:4549/outside") },
    },
    {
      ...httpAction("GET"),
      http: {
        method: "GET",
        url: literal("http://127.0.0.1:4549/actions/echo"),
        headers: { Authorization: literal("embedded-key") },
      },
    },
  ]) {
    const definition = chain([
      {
        id: "request",
        kind: "action",
        label: "Request",
        config: { actionId: "request" },
      },
    ]);
    definition.execution.actions = [workflowAction.parse(action)];
    const rejected = await call("POST", `/workspaces/${workspace}/workflows`, {
      name: "Unsafe",
      graph: definition,
    });
    assert.equal(rejected.statusCode, 201, rejected.body);
    const blocked = await call(
      "POST",
      `/workflows/${rejected.json().id}/publish`,
      { revision: 1 },
    );
    assert.equal(blocked.statusCode, 400, blocked.body);
  }
  for (const action of [
    httpAction("GET", undefined, "redirect"),
    workflowAction.parse({
      ...httpAction("GET"),
      outputSchema: { type: "object", required: ["missing"] },
    }),
  ]) {
    const { rid } = await actionFlow(action);
    await processWorkflowRun({ providerFactory: provider });
    const result = await inspect(rid);
    assert.equal(result.status, "failed");
    assert.equal(result.actionExecutions[0].status, "failed");
  }
});

test("MCP acceptance: structured extraction → durable edit → explicit DB write → read → business condition; Agent Tools remain read-only", async () => {
  const acceptanceSchema = {
    ...invoiceSchema,
    properties: { ...invoiceSchema.properties, supplier: { type: "string" } },
    required: [...invoiceSchema.required, "supplier"],
  };
  const extracted = { ...extractedInvoice, supplier: "Extracted supplier" };
  const connector = await call(
    "POST",
    `/workspaces/${workspace}/mcp-connectors`,
    { name: "Invoice database", url: "http://127.0.0.1:4549/actions/mcp" },
  );
  assert.equal(connector.statusCode, 201, connector.body);
  const connectorId = connector.json().id;
  const discovered = await call(
    "POST",
    `/mcp-connectors/${connectorId}/discover`,
  );
  assert.equal(discovered.statusCode, 200, discovered.body);
  const grant = await call(
    "POST",
    `/workspaces/${workspace}/mcp-action-grants`,
    {
      connectorId,
      operation: "insert_invoice",
      sideEffect: "write",
      riskLevel: "medium",
      allowWrites: true,
      idempotencyArgument: "requestId",
    },
  );
  assert.equal(grant.statusCode, 200, grant.body);
  const denied = await call("POST", `/workspaces/${workspace}/tools`, {
    name: "Not an Agent write Tool",
    description: "Must stay forbidden",
    config: { kind: "mcp", connectorId, remoteName: "insert_invoice" },
    readOnlyAcknowledged: true,
  });
  assert.equal(denied.statusCode, 400, denied.body);
  const write = workflowAction.parse({
    id: "persist",
    name: "Insert invoice",
    connector: "agentconnect.mcp-operation",
    connectionId: connectorId,
    operation: "insert_invoice",
    inputSchema: mcpInvoiceSchema,
    sideEffect: "write",
    riskLevel: "medium",
    allowSideEffects: true,
    idempotency: "key",
    idempotencyArgument: "requestId",
    retry: { maxAttempts: 2, delayMs: 100 },
    mappedInputs: {
      invoiceNumber: reference("steps.review.output.invoiceNumber"),
      supplier: reference("steps.review.output.supplier"),
      total: reference("steps.review.output.total"),
    },
  });
  const read = workflowAction.parse({
    id: "fetch",
    name: "Read persisted invoice",
    connector: "agentconnect.mcp-operation",
    connectionId: connectorId,
    operation: "read_invoice",
    inputSchema: {
      type: "object",
      properties: { invoiceNumber: { type: "string" } },
      required: ["invoiceNumber"],
    },
    mappedInputs: {
      invoiceNumber: reference("steps.review.output.invoiceNumber"),
    },
  });
  const definition = chain(
    [
      {
        id: "extract",
        kind: "structured-ai",
        label: "Extract invoice",
        config: {
          resource: "model",
          instruction: "Extract invoice",
          outputSchema: acceptanceSchema,
        },
      },
      {
        id: "review",
        kind: "human-task",
        label: "Review extracted invoice",
        config: {
          mode: "review-edit",
          prompt: "Correct extraction",
          outputSchema: acceptanceSchema,
        },
      },
      {
        id: "write",
        kind: "action",
        label: "Database write",
        config: { actionId: "persist" },
      },
      {
        id: "read",
        kind: "action",
        label: "Read persisted data",
        config: { actionId: "fetch" },
      },
      {
        id: "validate",
        kind: "condition",
        label: "Validate saved total",
        config: {
          condition: {
            operator: "equals",
            left: reference("steps.read.output.total"),
            right: reference("steps.review.output.total"),
          },
        },
      },
      {
        id: "failure",
        kind: "human-task",
        label: "Review incorrect persisted data",
        config: {
          mode: "approve-reject",
          prompt: "Database returned different total",
          outputSchema: { type: "object" },
        },
      },
      { id: "join", kind: "merge", label: "Join", config: {} },
    ],
    { model: { kind: "model", id: modelId } },
  );
  definition.execution.actions = [write, read];
  definition.execution.edges = definition.execution.edges.filter(
    (e) => !["validate", "failure"].includes(e.source),
  );
  definition.execution.edges.push(
    { id: "valid", source: "validate", target: "join", branch: "true" },
    { id: "invalid", source: "validate", target: "failure", branch: "false" },
    { id: "reviewed", source: "failure", target: "join" },
  );
  const id = await create(definition),
    version = await publish(id);
  try {
    for (const invalid of [false, true]) {
      staleRead = invalid;
      const rid = await run(id, { document: "OCR/PDF text" }, version);
      await processWorkflowRun({
        providerFactory: extractionProvider(extracted),
      });
      assert.equal((await inspect(rid)).status, "waiting");
      const invoice = {
        ...extractedInvoice,
        invoiceNumber: invalid ? "DB-INVALID" : "DB-VALID",
        supplier: "Reviewed supplier",
        total: 432,
      };
      const approval = await call("POST", `/workflow-runs/${rid}/approval`, {
        nodeId: "review",
        decision: "approved",
        editedInput: invoice,
      });
      assert.equal(approval.statusCode, 200, approval.body);
      await closeWorkflowSaver();
      await processWorkflowRun({
        providerFactory: extractionProvider(extracted),
      });
      let result = await inspect(rid);
      assert.equal(
        result.status,
        invalid ? "waiting" : "completed",
        JSON.stringify(result),
      );
      assert.equal(result.actionExecutions.length, 2);
      assert.ok(
        result.actionExecutions.every(
          (a: { status: string }) => a.status === "completed",
        ),
      );
      assert.deepEqual(actionInvoices.get(invoice.invoiceNumber), {
        invoiceNumber: invoice.invoiceNumber,
        supplier: invoice.supplier,
        total: 432,
      });
      if (invalid) {
        const resolved = await call("POST", `/workflow-runs/${rid}/approval`, {
          nodeId: "failure",
          decision: "approved",
        });
        assert.equal(resolved.statusCode, 200, resolved.body);
        await closeWorkflowSaver();
        await processWorkflowRun();
        result = await inspect(rid);
        assert.equal(result.status, "completed", JSON.stringify(result));
      }
    }
  } finally {
    staleRead = false;
  }
  const driftRun = await run(id, { document: "Drift check" }, version);
  await processWorkflowRun({ providerFactory: extractionProvider(extracted) });
  const approved = await call("POST", `/workflow-runs/${driftRun}/approval`, {
    nodeId: "review",
    decision: "approved",
    editedInput: { ...extracted, invoiceNumber: "DRIFT" },
  });
  assert.equal(approved.statusCode, 200, approved.body);
  mcpMetadataDrift = true;
  try {
    await processWorkflowRun();
    const drift = await inspect(driftRun);
    assert.equal(drift.status, "failed", JSON.stringify(drift));
    assert.equal(
      drift.actionExecutions[0].error_code,
      "ACTION_MCP_CAPABILITY_CHANGED",
    );
    assert.equal(actionInvoices.has("DRIFT"), false);
  } finally {
    mcpMetadataDrift = false;
  }
  await sql`UPDATE workflow_mcp_action_grants SET enabled=false WHERE connector_id=${connectorId}`;
  const rejected = await call("POST", `/workspaces/${workspace}/workflows`, {
    name: "Revoked MCP write",
    graph: definition,
  });
  assert.equal(rejected.statusCode, 201, rejected.body);
  const blocked = await call(
    "POST",
    `/workflows/${rejected.json().id}/publish`,
    { revision: 1 },
  );
  assert.equal(blocked.statusCode, 400, blocked.body);
});
test("webhooks authenticate independently, validate payloads, deduplicate, expose safe trigger context, rotate and revoke", async () => {
  const definition = simple();
  definition.execution.nodes.find((n) => n.id === "end")!.config = {
    input: reference("trigger"),
  };
  const id = await create(definition),
    versionId = await publish(id);
  const schema = {
    type: "object",
    properties: { customer: { type: "string" } },
    required: ["customer"],
    additionalProperties: false,
  };
  const created = await call("POST", `/workflows/${id}/webhooks`, {
    name: "Customer callback",
    versionId,
    inputSchema: schema,
    sample: { customer: "sample" },
  });
  assert.equal(created.statusCode, 201, created.body);
  const hook = created.json(),
    url = hook.endpoint + "?source=customer";
  assert.equal(
    (await call("POST", hook.endpoint, { customer: "cookie only" })).statusCode,
    401,
  );
  const send = (payload: unknown, token = hook.token, key = "request-1") =>
    app.inject({
      method: "POST",
      url,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": key,
        "x-secret": "must-not-persist",
      },
      payload: payload as Record<string, unknown>,
    });
  assert.equal((await send({ wrong: true })).statusCode, 400);
  const queued = await send({ customer: "Ada" });
  assert.equal(queued.statusCode, 202, queued.body);
  const rid = queued.json().id;
  runs.push(rid);
  const duplicate = await send({ customer: "Ada" });
  assert.equal(duplicate.statusCode, 202);
  assert.equal(duplicate.json().id, rid);
  assert.equal(duplicate.json().reused, true);
  assert.equal((await send({ customer: "Grace" })).statusCode, 409);
  await processWorkflowRun();
  const result = await inspect(rid);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.output.body.customer, "Ada");
  assert.equal(result.output.query.source, "customer");
  assert.deepEqual(result.output.headers, {
    "content-type": "application/json",
  });
  assert.ok(!JSON.stringify(result).includes(hook.token));
  assert.ok(!JSON.stringify(result).includes("must-not-persist"));
  const listing = await call("GET", `/workflows/${id}/webhooks`);
  assert.ok(!listing.body.includes(hook.token));
  assert.ok(!listing.body.includes("token_hash"));
  const rotated = await call(
    "POST",
    `/workflows/${id}/webhooks/${hook.id}/rotate`,
  );
  assert.equal(rotated.statusCode, 200, rotated.body);
  assert.equal((await send({ customer: "Ada" })).statusCode, 401);
  const fresh = await send(
    { customer: "Grace" },
    rotated.json().token,
    "request-2",
  );
  assert.equal(fresh.statusCode, 202, fresh.body);
  runs.push(fresh.json().id);
  await sql`UPDATE workflow_webhooks SET enabled=false WHERE id=${hook.id}`;
  assert.equal(
    (await send({ customer: "Grace" }, rotated.json().token)).statusCode,
    401,
  );
  await processWorkflowRun();
  assert.equal((await inspect(fresh.json().id)).status, "failed");
  const testRun = await call(
    "POST",
    `/workflows/${id}/webhooks/${hook.id}/test`,
  );
  assert.equal(testRun.statusCode, 202, testRun.body);
  runs.push(testRun.json().id);
  await processWorkflowRun();
  const testResult = await inspect(testRun.json().id);
  assert.equal(testResult.status, "completed", JSON.stringify(testResult));
  assert.equal(testResult.output.test, true);
  assert.equal(testResult.output.body.customer, "sample");
});

test("native HTTP timeout and input validation persist sanitized Action failures", async () => {
  for (const action of [
    workflowAction.parse({
      ...httpAction("GET", undefined, "slow"),
      timeoutMs: 100,
    }),
    workflowAction.parse({
      ...httpAction("GET"),
      inputSchema: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
    }),
  ]) {
    const { rid } = await actionFlow(action);
    await processWorkflowRun();
    const result = await inspect(rid);
    assert.equal(result.status, "failed", JSON.stringify(result));
    assert.equal(result.actionExecutions[0].status, "failed");
    assert.ok(
      ["ACTION_TIMEOUT", "ACTION_INPUT_INVALID"].includes(
        result.actionExecutions[0].error_code,
      ),
      JSON.stringify(result.actionExecutions),
    );
  }
});

test("workspace Human Tasks inbox completes review/edit and resumes durable work; Runs remains tenant scoped and redacted", async () => {
  const definition = chain([
    {
      id: "human",
      kind: "human-task",
      label: "Review record",
      config: {
        mode: "review-edit",
        prompt: "Check the record",
        approveLabel: "Process",
        outputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
    },
  ]);
  const id = await create(definition),
    rid = await run(id, { value: "sample" });
  await processWorkflowRun();
  const tasks = await call(
    "GET",
    `/workspaces/${workspace}/workflow-operations?view=tasks`,
  );
  assert.equal(tasks.statusCode, 200, tasks.body);
  const task = tasks.json().find((t: { run_id: string }) => t.run_id === rid);
  assert.ok(task);
  assert.equal(task.task, "Review record");
  assert.equal(task.config.approveLabel, "Process");
  assert.equal(task.graph_snapshot, undefined);
  const forbidden = await call(
    "GET",
    `/workspaces/${workspace}/workflow-operations?view=tasks`,
    undefined,
    viewerToken,
  );
  assert.equal(forbidden.statusCode, 403);
  const foreignTasks = await call(
    "GET",
    `/workspaces/${foreign}/workflow-operations?view=tasks`,
  );
  assert.ok(!foreignTasks.body.includes(rid));
  const decision = await call("POST", `/workflow-runs/${rid}/approval`, {
    nodeId: "human",
    decision: "approved",
    editedInput: { value: "corrected" },
  });
  assert.equal(decision.statusCode, 200, decision.body);
  await closeWorkflowSaver();
  await processWorkflowRun();
  assert.equal((await inspect(rid)).status, "completed");
  assert.ok(
    !(
      await call(
        "GET",
        `/workspaces/${workspace}/workflow-operations?view=tasks`,
      )
    ).body.includes(rid),
  );
  const listed = await call(
    "GET",
    `/workspaces/${workspace}/workflow-operations?view=runs`,
  );
  assert.ok(listed.json().some((r: { id: string }) => r.id === rid));
  await sql`UPDATE workflow_runs SET input=${JSON.stringify({ password: "fixture-inbox-secret" })},output=${sql.json({ authorization: "fixture-inbox-secret" })} WHERE id=${rid}`;
  assert.ok(!(await inspect(rid)).input.includes("fixture-inbox-secret"));
  assert.ok(
    !JSON.stringify(await inspect(rid)).includes("fixture-inbox-secret"),
  );
});
test("document uploads reuse bounded native parsers and reject unsupported or oversized input", async () => {
  const payload = {
    files: [
      {
        name: "record.txt",
        data: Buffer.from("A purchase order with an address").toString(
          "base64",
        ),
      },
    ],
  };
  const result = await call(
    "POST",
    `/workspaces/${workspace}/workflow-documents/parse`,
    payload,
  );
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(
    result.json().documents[0].text,
    "A purchase order with an address",
  );
  assert.equal(
    (
      await call("POST", `/workspaces/${workspace}/workflow-documents/parse`, {
        files: [{ name: "script.exe", data: "AAAA" }],
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/workspaces/${workspace}/workflow-documents/parse`,
        payload,
        viewerToken,
      )
    ).statusCode,
    403,
  );
});
test("deployment workflow ceilings can be lowered without rewriting published versions", async () => {
  const original = config.WORKFLOW_MAX_NODES;
  const definition = chain([
    {
      id: "wait",
      kind: "wait",
      label: "Wait",
      config: { mode: "duration", seconds: 1 },
    },
  ]);
  const id = await create(definition),
    version = await publish(id);
  try {
    config.WORKFLOW_MAX_NODES = 2;
    const blocked = await call("POST", `/workflows/${id}/runs`, {
      input: "bounded",
      versionId: version,
    });
    assert.equal(blocked.statusCode, 400, blocked.body);
    assert.match(blocked.body, /WORKFLOW_NODE_LIMIT/);
    const [persisted] =
      await sql`SELECT graph FROM workflow_versions WHERE id=${version}`;
    assert.equal(persisted!.graph.execution.nodes.length, 3);
  } finally {
    config.WORKFLOW_MAX_NODES = original;
  }
});
test("Document → Structured Database template is generic, schema driven and preserves published Agent references", async () => {
  const { documentDatabaseTemplate } =
    await import("@agentconnect/schemas/workflow-document-template");
  const schema = {
    type: "object",
    properties: {
      purchaseOrderNumber: { type: "string" },
      supplierEmail: { type: "string" },
    },
    required: ["purchaseOrderNumber", "supplierEmail"],
    additionalProperties: false,
  };
  const write = workflowAction.parse({
    ...httpAction("POST"),
    id: "write",
    mappedInputs: {},
    http: {
      method: "POST",
      url: literal("http://127.0.0.1:4549/actions/echo"),
    },
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, email: { type: "string" } },
      required: ["key", "email"],
    },
  });
  const read = workflowAction.parse({
    ...httpAction("GET"),
    id: "read",
    mappedInputs: {},
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  });
  for (const useAgent of [false, true]) {
    const template = documentDatabaseTemplate({
      name: "Purchase order records",
      modelId: useAgent ? undefined : modelId,
      agent: useAgent ? { agentId, versionId } : undefined,
      outputSchema: schema,
      instruction: "Extract purchase orders",
      write,
      read,
      writeMappings: { key: "purchaseOrderNumber", email: "supplierEmail" },
      readMappings: { key: "purchaseOrderNumber" },
      validationFields: ["purchaseOrderNumber", "supplierEmail"],
      maxItems: 5,
    });
    const child = await create(template.body);
    const version = await publish(child);
    const parent = template.parent(child, version);
    const root = await create(parent);
    await publish(root);
    assert.ok(
      parent.execution.nodes.some(
        (n) => n.kind === "for-each" && n.config.maxItems === 5,
      ),
    );
    assert.equal(
      template.body.execution.nodes.filter((n) => n.kind === "condition")
        .length,
      2,
    );
    assert.ok(!JSON.stringify(parent).includes("currency"));
    if (useAgent)
      assert.equal(parent.execution.resources.extractor!.kind, "agent");
  }
});

test("operations pagination keeps every run when timestamps are identical down to microseconds", async () => {
  const definition = chain([]),
    workflow = await create(definition),
    snapshot = storedWorkflowGraph(definition);
  await sql`INSERT INTO workflow_runs(id,workflow_id,workspace_id,organization_id,user_id,graph_snapshot,input,status,created_at,finished_at) SELECT gen_random_uuid(),${workflow},${workspace},${org},${owner},${sql.json(snapshot)},'input','completed','2030-01-01T00:00:00.123456Z'::timestamptz,now() FROM generate_series(1,105)`;
  const first = await call(
    "GET",
    `/workspaces/${workspace}/workflow-operations?view=runs`,
  );
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().length, 100);
  const cursor = first.json().at(-1);
  assert.equal(cursor.cursor_time, "2030-01-01T00:00:00.123456Z");
  const query = new URLSearchParams({
    view: "runs",
    before: cursor.cursor_time,
    beforeId: cursor.id,
  });
  const second = await call(
    "GET",
    `/workspaces/${workspace}/workflow-operations?${query}`,
  );
  assert.equal(second.statusCode, 200, second.body);
  const remaining = second
    .json()
    .filter((r: { workflow_id: string }) => r.workflow_id === workflow);
  assert.equal(remaining.length, 5);
  const seen = new Set(first.json().map((r: { id: string }) => r.id));
  assert.ok(remaining.every((r: { id: string }) => !seen.has(r.id)));
});

test("generated document template executes multiple read-back rules and routes failed validation through item and batch review", async () => {
  const { documentDatabaseTemplate } =
    await import("@agentconnect/schemas/workflow-document-template");
  const created = await call(
    "POST",
    `/workspaces/${workspace}/mcp-connectors`,
    {
      name: "Template record database",
      url: "http://127.0.0.1:4549/actions/mcp",
    },
  );
  assert.equal(created.statusCode, 201, created.body);
  const connectorId = created.json().id;
  assert.equal(
    (await call("POST", `/mcp-connectors/${connectorId}/discover`)).statusCode,
    200,
  );
  const grant = await call(
    "POST",
    `/workspaces/${workspace}/mcp-action-grants`,
    {
      connectorId,
      operation: "insert_invoice",
      sideEffect: "write",
      riskLevel: "medium",
      allowWrites: true,
      idempotencyArgument: "requestId",
    },
  );
  assert.equal(grant.statusCode, 200, grant.body);
  const schema = {
    type: "object",
    properties: {
      invoiceNumber: { type: "string" },
      supplier: { type: "string" },
      total: { type: "number" },
    },
    required: ["invoiceNumber", "supplier", "total"],
    additionalProperties: false,
  };
  const write = workflowAction.parse({
    id: "write",
    name: "Write configured record",
    connector: "agentconnect.mcp-operation",
    operation: "insert_invoice",
    connectionId: connectorId,
    inputSchema: mcpInvoiceSchema,
    allowSideEffects: true,
    sideEffect: "write",
    riskLevel: "medium",
    idempotency: "key",
    idempotencyArgument: "requestId",
  });
  const read = workflowAction.parse({
    id: "read",
    name: "Read configured record",
    connector: "agentconnect.mcp-operation",
    operation: "read_invoice",
    connectionId: connectorId,
    inputSchema: {
      type: "object",
      properties: { invoiceNumber: { type: "string" } },
      required: ["invoiceNumber"],
    },
    outputSchema: schema,
  });
  const template = documentDatabaseTemplate({
    name: "Configured records",
    modelId,
    outputSchema: schema,
    instruction: "Extract records using the reviewed example",
    write,
    read,
    writeMappings: {
      invoiceNumber: "invoiceNumber",
      supplier: "supplier",
      total: "total",
    },
    readMappings: { invoiceNumber: "invoiceNumber" },
    validationFields: ["total", "invoiceNumber", "supplier"],
    maxItems: 10,
  });
  const body = await create(template.body),
    bodyVersion = await publish(body),
    parent = await create(template.parent(body, bodyVersion)),
    version = await publish(parent);
  try {
    for (const invalid of [false, true]) {
      staleRead = invalid;
      const record = {
        invoiceNumber: invalid ? "TEMPLATE-FAIL" : "TEMPLATE-OK",
        supplier: "Example supplier",
        total: 27,
      };
      const factory = extractionProvider(record);
      const rid = await run(
        parent,
        { documents: ["sample OCR", "remaining OCR"] },
        version,
      );
      await processWorkflowRun({ providerFactory: factory });
      assert.equal((await inspect(rid)).status, "waiting");
      const approval = await call("POST", `/workflow-runs/${rid}/approval`, {
        nodeId: "review",
        decision: "approved",
        editedInput: { ...record, total: 31 },
      });
      assert.equal(approval.statusCode, 200, approval.body);
      if (!invalid) {
        const result = await pump(rid, { providerFactory: factory });
        assert.equal(result.status, "completed", JSON.stringify(result));
        assert.equal(result.children.length, 1);
        assert.equal(result.children[0].status, "completed");
      } else {
        let childId = "";
        for (let i = 0; i < 30; i++) {
          await processWorkflowRun({ providerFactory: factory });
          const parentRun = await inspect(rid);
          childId = parentRun.children[0]?.id ?? "";
          if (
            childId &&
            (await inspect(childId)).approvals.some(
              (a: { node_id: string; decision: string }) =>
                a.node_id === "error" && a.decision === "pending",
            )
          )
            break;
        }
        assert.ok(childId);
        const child = await inspect(childId);
        assert.equal(child.status, "waiting", JSON.stringify(child));
        assert.ok(
          child.approvals.some(
            (a: { node_id: string }) => a.node_id === "error",
          ),
        );
        assert.equal(
          (
            await call("POST", `/workflow-runs/${childId}/approval`, {
              nodeId: "error",
              decision: "rejected",
            })
          ).statusCode,
          200,
        );
        let batch = await inspect(rid);
        for (let i = 0; i < 30; i++) {
          await processWorkflowRun({ providerFactory: factory });
          batch = await inspect(rid);
          if (
            batch.approvals.some(
              (a: { node_id: string; decision: string }) =>
                a.node_id === "error" && a.decision === "pending",
            )
          )
            break;
        }
        assert.equal(batch.status, "waiting", JSON.stringify(batch));
        assert.ok(
          batch.approvals.some(
            (a: { node_id: string }) => a.node_id === "error",
          ),
        );
        assert.equal(
          (
            await call("POST", `/workflow-runs/${rid}/approval`, {
              nodeId: "error",
              decision: "rejected",
            })
          ).statusCode,
          200,
        );
      }
    }
  } finally {
    staleRead = false;
  }
});

test("document validation mappings support a database read returning a root array", async () => {
  const { documentDatabaseTemplate } =
    await import("@agentconnect/schemas/workflow-document-template");
  const schema = {
    type: "object",
    properties: { recordId: { type: "string" } },
    required: ["recordId"],
  };
  const template = documentDatabaseTemplate({
    name: "Array records",
    modelId,
    outputSchema: schema,
    instruction: "Extract record IDs",
    write: workflowAction.parse({ ...httpAction("POST"), mappedInputs: {} }),
    read: workflowAction.parse({
      ...httpAction("GET"),
      mappedInputs: {},
      outputSchema: { type: "array", items: schema },
    }),
    writeMappings: {},
    readMappings: {},
    validationFields: ["recordId"],
    validationMappings: { recordId: "[0].recordId" },
    maxItems: 2,
  });
  const check = template.body.execution.nodes.find(
    (n) => n.kind === "condition",
  );
  assert.equal(check!.kind, "condition");
  if (check!.kind === "condition")
    assert.deepEqual(
      check!.config.condition.left,
      reference("steps.read.output[0].recordId"),
    );
});
