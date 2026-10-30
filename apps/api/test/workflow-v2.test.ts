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
