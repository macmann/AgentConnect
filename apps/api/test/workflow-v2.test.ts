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
const server = createServer((req, res) => {
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
  for (const id of runs) await saver.deleteThread(id);
  await closeWorkflowSaver();
  await sql.begin(async (tx) => {
    for (const table of [
      "tool_executions",
      "workflow_approvals",
      "workflow_node_runs",
      "workflow_runs",
      "workflow_schedules",
      "workflow_versions",
      "workflows",
      "agent_versions",
      "agents",
      "tools",
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
