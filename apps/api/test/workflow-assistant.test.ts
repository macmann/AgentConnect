import "./tracing-fixture.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { digest } from "../src/security.js";
import { config } from "../src/config.js";
import {
  workflowDefinitionV2,
  compileWorkflowDefinition,
} from "@agentconnect/schemas/workflow-v2";
import {
  applyWorkflowMutations,
  workflowMutation,
} from "@agentconnect/schemas/workflow-assistant";
import {
  assistantMappingWarnings,
  workflowRiskWarnings,
} from "../src/workflow-assistant.js";
import {
  ProviderError,
  type ProviderFactory,
} from "@agentconnect/provider-sdk";
const org = randomUUID(),
  workspace = randomUUID(),
  foreign = randomUUID(),
  owner = randomUUID(),
  viewer = randomUUID(),
  model = randomUUID(),
  ownerToken = randomUUID(),
  viewerToken = randomUUID();
let output: unknown,
  calls = 0,
  broken = false;
const requests: { system: string; content: string }[] = [];
const factory: ProviderFactory = () => ({
  async *stream(input) {
    calls++;
    requests.push({
      system: input.system,
      content: input.messages[0]!.content,
    });
    if (broken) throw new ProviderError("AUTHENTICATION_FAILED");
    yield {
      type: "token",
      text: typeof output === "string" ? output : JSON.stringify(output),
    };
  },
});
const app = await buildApp({ providerFactory: factory });
const originalAllowed = config.TOOL_ALLOWED_HOSTS;
const literal = (value: string | number | boolean | null) => ({
  type: "literal" as const,
  value,
});
const reference = (path: string) => ({ type: "reference" as const, path });
const simple = () =>
  workflowDefinitionV2.parse({
    schemaVersion: 2,
    execution: {
      nodes: [
        { id: "start", kind: "input", label: "Input", config: {} },
        { id: "end", kind: "output", label: "Complete", config: {} },
      ],
      edges: [{ id: "next", source: "start", target: "end" }],
    },
    editor: {
      nodes: { start: { x: 25, y: 110 }, end: { x: 700, y: 110 } },
      edges: {},
      viewport: { x: 0, y: 0, zoom: 0.75 },
    },
  });
let address = 1;
async function call(path: string, body?: unknown, token = ownerToken) {
  return app.inject({
    method: body ? "POST" : "GET",
    url: path,
    headers: { cookie: `session=${token}`, origin: config.WEB_ORIGIN },
    remoteAddress: `198.18.2.${address++}`,
    payload: body as Record<string, unknown>,
  });
}
const endpoint = `/workspaces/${workspace}/workflow-assistant`;
const request = (mode = "create", definition = simple()) => ({
  mode,
  prompt: "Create a practical workflow",
  definition,
});
const insertWait = () => ({
  kind: "mutations",
  message: "Wait for one day before completing",
  operations: [
    { op: "disconnect", edgeId: "next" },
    {
      op: "addNode",
      nearNodeId: "start",
      node: {
        id: "wait",
        kind: "wait",
        label: "Wait 24 hours",
        config: { mode: "duration", seconds: 86400 },
      },
    },
    { op: "connect", edge: { id: "before", source: "start", target: "wait" } },
    { op: "connect", edge: { id: "after", source: "wait", target: "end" } },
  ],
});
before(async () => {
  if (config.NODE_ENV === "production")
    throw new Error("Tests refuse production");
  config.TOOL_ALLOWED_HOSTS = [originalAllowed, "api.openai.com"]
    .filter(Boolean)
    .join(",");
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Workflow AI test')`;
    for (const w of [workspace, foreign])
      await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${w},${org},'Workflow AI')`;
    for (const [u, t, role] of [
      [owner, ownerToken, "owner"],
      [viewer, viewerToken, "viewer"],
    ]) {
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${u!},${u + "@example.com"},'Fixture','unused-fixture',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(t!)},${u!},now()+interval '1 hour')`;
      await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${role === "owner" ? null : workspace},${u!},${role!})`;
    }
    await tx`INSERT INTO model_configurations(id,workspace_id,organization_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES (${model},${workspace},${org},'Workflow assistant model','openai-compatible','fixture','https://api.openai.com/v1',131072,16384,${tx.json({ streaming: true, temperature: true, topP: true })})`;
  });
});
after(async () => {
  await sql.begin(async (tx) => {
    for (const t of [
      "tool_executions",
      "workflow_approvals",
      "workflow_node_runs",
      "workflow_runs",
      "workflow_webhooks",
      "workflow_versions",
      "workflows",
      "workflow_mcp_action_grants",
      "workflow_http_connections",
      "tools",
      "mcp_connectors",
      "workspace_creation_settings",
      "agent_versions",
      "agents",
      "model_configurations",
      "secrets",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(t)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    await tx`DELETE FROM users WHERE id=ANY(${[owner, viewer]})`;
  });
  config.TOOL_ALLOWED_HOSTS = originalAllowed;
  await app.close();
});
test("workflow assistant uses existing administrator opt-in, enforces roles and never creates background changes", async () => {
  output = {
    kind: "definition",
    message: "Review workflow",
    definition: simple(),
  };
  assert.equal((await call(endpoint, request())).statusCode, 409);
  assert.equal(calls, 0);
  await sql`INSERT INTO workspace_creation_settings(workspace_id,organization_id,enabled,model_id,revision) VALUES (${workspace},${org},true,${model},1)`;
  assert.equal((await call(endpoint, request(), viewerToken)).statusCode, 403);
  assert.equal(calls, 0);
  const result = await call(endpoint, request());
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().definition.schemaVersion, 2);
  assert.deepEqual(
    compileWorkflowDefinition(result.json().definition).programV2!.execution,
    result.json().definition.execution,
  );
  assert.equal(
    (await sql`SELECT id FROM workflows WHERE organization_id=${org}`).length,
    0,
  );
  assert.ok(requests[0]!.system.includes('"updateMapping"'));
  assert.ok(requests[0]!.system.includes("untrusted data"));
  assert.ok(requests[0]!.system.includes('"structured-ai"'));
});
test("explicit mutations preserve layout, preview without persistence, and validate immediately before apply", async () => {
  output = insertWait();
  const before = simple(),
    snapshot = JSON.stringify(before);
  const result = await call(endpoint, request("modify", before));
  assert.equal(result.statusCode, 200, result.body);
  const candidate = result.json().definition;
  assert.equal(JSON.stringify(before), snapshot);
  assert.deepEqual(candidate.editor.nodes.start, before.editor!.nodes.start);
  assert.deepEqual(candidate.editor.nodes.end, before.editor!.nodes.end);
  assert.deepEqual(candidate.editor.viewport, before.editor!.viewport);
  assert.ok(candidate.editor.nodes.wait.x > before.editor!.nodes.start!.x);
  assert.ok(
    result.json().changes.some((s: string) => s.includes("Wait 24 hours")),
  );
  assert.equal(
    (await sql`SELECT id FROM workflows WHERE organization_id=${org}`).length,
    0,
  );
  const checked = await call(endpoint + "/validate", { definition: candidate });
  assert.equal(checked.statusCode, 200, checked.body);
  // Explicit Apply changes only the local canvas; normal persistence remains a separate request.
  const saved = await call(`/workspaces/${workspace}/workflows`, {
    name: "Applied AI proposal",
    graph: candidate,
  });
  assert.equal(saved.statusCode, 201, saved.body);
  const [stored] =
    await sql`SELECT draft_graph FROM workflows WHERE id=${saved.json().id}`;
  assert.deepEqual(stored!.draft_graph, candidate);
  output = {
    kind: "definition",
    message: "Not a mutation",
    definition: simple(),
  };
  assert.equal((await call(endpoint, request("modify"))).statusCode, 422);
});
test("invalid AI JSON/code, cyclic mutations and reserved property traversal never become proposals", async () => {
  const count =
    await sql`SELECT id FROM workflows WHERE organization_id=${org}`;
  for (const bad of [
    "not JSON fixture-credential-should-not-leak",
    {
      kind: "mutations",
      message: "Bad",
      operations: [{ op: "eval", code: "process.env" }],
    },
    {
      kind: "mutations",
      message: "Cycle",
      operations: [
        {
          op: "connect",
          edge: { id: "cycle", source: "end", target: "start" },
        },
      ],
    },
  ]) {
    output = bad;
    const result = await call(endpoint, request("modify"));
    assert.equal(result.statusCode, 422, result.body);
    assert.ok(!result.body.includes("fixture-credential-should-not-leak"));
    assert.equal(result.json().definition, undefined);
  }
  assert.equal(
    workflowMutation.safeParse({
      op: "upsertResource",
      name: "constructor",
      resource: { kind: "model", id: model },
    }).success,
    false,
  );
  assert.equal(
    (await sql`SELECT id FROM workflows WHERE organization_id=${org}`).length,
    count.length,
  );
  broken = true;
  assert.equal((await call(endpoint, request())).statusCode, 502);
  broken = false;
});
test("selected-node configuration is scoped; explanations are read-only and use the actual definition", async () => {
  const source = simple();
  source.execution.nodes.splice(1, 0, {
    id: "wait",
    kind: "wait",
    label: "Wait",
    config: { mode: "duration", seconds: 60 },
  });
  source.execution.edges = [
    { id: "a", source: "start", target: "wait" },
    { id: "b", source: "wait", target: "end" },
  ];
  output = {
    kind: "mutations",
    message: "Adjust selected wait",
    operations: [
      {
        op: "updateNode",
        nodeId: "wait",
        node: {
          id: "wait",
          kind: "wait",
          label: "Wait",
          config: { mode: "duration", seconds: 86400 },
        },
      },
    ],
  };
  const configured = await call(endpoint, {
    ...request("configure", source),
    selectedNodeId: "wait",
  });
  assert.equal(configured.statusCode, 200, configured.body);
  assert.equal(
    configured.json().definition.execution.nodes[1].config.seconds,
    86400,
  );
  output = insertWait();
  assert.equal(
    (
      await call(endpoint, {
        ...request("configure", source),
        selectedNodeId: "wait",
      })
    ).statusCode,
    422,
  );
  output = {
    kind: "explanation",
    message:
      "Input starts the workflow. A durable wait pauses for 60 seconds, then Complete returns the result. No external systems are modified.",
  };
  await sql`UPDATE memberships SET role='operator' WHERE user_id=${viewer}`;
  const explanation = await call(
    endpoint,
    request("explain", source),
    viewerToken,
  );
  assert.equal(explanation.statusCode, 200, explanation.body);
  assert.equal(explanation.json().definition, null);
  await sql`UPDATE memberships SET role='viewer' WHERE user_id=${viewer}`;
  assert.ok(requests.at(-1)!.content.includes('"seconds":60'));
  output = insertWait();
  assert.equal(
    (await call(endpoint, request("explain", source))).statusCode,
    422,
  );
});
test("mapping assistance validates declared source fields and clearly flags dynamic schema gaps", async () => {
  const source = simple();
  source.execution.nodes.splice(1, 0, {
    id: "extract",
    kind: "structured-ai",
    label: "Extract",
    config: {
      resource: "model",
      instruction: "Extract",
      outputSchema: {
        type: "object",
        properties: { invoiceNumber: { type: "string" } },
        required: ["invoiceNumber"],
        additionalProperties: false,
      },
    },
  });
  source.execution.resources = { model: { kind: "model", id: model } };
  source.execution.edges = [
    { id: "a", source: "start", target: "extract" },
    { id: "b", source: "extract", target: "end" },
  ];
  output = {
    kind: "mutations",
    message: "Use the invoice number",
    operations: [
      {
        op: "updateMapping",
        nodeId: "end",
        target: "input",
        value: reference("steps.extract.output.invoiceNumber"),
      },
    ],
  };
  const valid = await call(endpoint, request("modify", source));
  assert.equal(valid.statusCode, 200, valid.body);
  output = {
    kind: "mutations",
    message: "Invent a field",
    operations: [
      {
        op: "updateMapping",
        nodeId: "end",
        target: "input",
        value: reference("steps.extract.output.nonexistent"),
      },
    ],
  };
  const missing = await call(endpoint, request("modify", source));
  assert.equal(missing.statusCode, 422, missing.body);
  assert.match(missing.body, /nonexistent/);
  const d = simple();
  d.execution.nodes[1]!.config = {
    input: reference("trigger.body.customer.email"),
  };
  assert.ok(
    assistantMappingWarnings(d).some((w) =>
      w.includes("source schema is not declared"),
    ),
  );
  assert.deepEqual(
    assistantMappingWarnings(d, {
      type: "object",
      properties: {
        customer: {
          type: "object",
          properties: { email: { type: "string" } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    }),
    [],
  );
  assert.throws(
    () =>
      assistantMappingWarnings(d, {
        type: "object",
        properties: { customer: { type: "string" } },
        additionalProperties: false,
      }),
    /undeclared|source/,
  );
});
test("unavailable connectors and permission changes fail closed; high-risk Action proposals stay visibly flagged", async () => {
  const savedSecret = await call(`/workspaces/${workspace}/secrets`, {
    name: "WORKFLOW_AI_AUTH",
    value: "fixture-ai-credential-must-not-reach-model",
  });
  assert.equal(savedSecret.statusCode, 201, savedSecret.body);
  const secretList = await call(`/workspaces/${workspace}/secrets`);
  const secretId = secretList
    .json()
    .find((s: { name: string }) => s.name === "WORKFLOW_AI_AUTH").id;
  const connection = await call(`/workspaces/${workspace}/action-connections`, {
    name: "Invoice API",
    auth: "bearer",
    secretId,
    baseUrl: "https://api.openai.com/v1",
    methods: ["DELETE"],
  });
  assert.equal(connection.statusCode, 201, connection.body);
  const source = simple();
  source.execution.actions = [
    {
      id: "remove",
      name: "Delete invoice",
      connector: "agentconnect.http",
      operation: "DELETE",
      connectionId: connection.json().id,
      http: {
        method: "DELETE",
        url: literal("https://api.openai.com/v1/invoices"),
        headers: {},
        query: {},
      },
      description: "",
      allowSideEffects: true,
      inputSchema: { type: "object" },
      outputSchema: {},
      staticInputs: {},
      mappedInputs: {},
      timeoutMs: 5000,
      retry: { maxAttempts: 1, delayMs: 1000 },
      sideEffect: "delete",
      riskLevel: "high",
      idempotency: "unsupported",
      requiredPermissions: [],
      requiredScopes: [],
    },
  ];
  source.execution.nodes.splice(1, 0, {
    id: "remove",
    kind: "action",
    label: "Delete invoice",
    config: { actionId: "remove", inputs: {} },
  });
  source.execution.edges = [
    { id: "a", source: "start", target: "remove" },
    { id: "b", source: "remove", target: "end" },
  ];
  output = {
    kind: "definition",
    message: "Review destructive Action",
    definition: source,
  };
  const high = await call(endpoint, request());
  assert.equal(high.statusCode, 200, high.body);
  assert.ok(
    high
      .json()
      .warnings.some(
        (w: string) => w.includes("HIGH RISK") && w.includes("delete"),
      ),
  );
  assert.equal(workflowRiskWarnings(high.json().definition).length, 1);
  assert.ok(!requests.at(-1)!.content.includes("secret_id"));
  assert.ok(!requests.at(-1)!.content.includes("ciphertext"));
  assert.ok(
    !requests
      .at(-1)!
      .content.includes("fixture-ai-credential-must-not-reach-model"),
  );
  await sql`UPDATE workflow_http_connections SET enabled=false WHERE id=${connection.json().id}`;
  assert.equal(
    (await call(endpoint + "/validate", { definition: high.json().definition }))
      .statusCode,
    400,
  );
  assert.equal((await call(endpoint, request())).statusCode, 422);
});
test("mutations reject duplicate identities, dangling mappings, incompatible targets and prototype pollution", () => {
  const before = simple();
  for (const operations of [
    [{ op: "addNode", node: before.execution.nodes[0] }],
    [{ op: "disconnect", edgeId: "missing" }],
    [{ op: "removeNode", nodeId: "end" }],
    [
      {
        op: "updateMapping",
        nodeId: "end",
        target: "fields",
        field: "value",
        value: literal(1),
      },
    ],
    [
      {
        op: "updateNode",
        nodeId: "end",
        node: { ...before.execution.nodes[1], id: "other" },
      },
    ],
  ])
    assert.throws(() =>
      applyWorkflowMutations(
        before,
        operations as Parameters<typeof applyWorkflowMutations>[1],
      ),
    );
  assert.equal(before.execution.nodes.length, 2);
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
});

test("OCR/PDF acceptance: AI proposes sample review and a published per-document body with extraction, MCP write/read and business validation", async () => {
  const connector = randomUUID();
  const invoice = {
    type: "object",
    properties: {
      invoiceNumber: { type: "string" },
      supplier: { type: "string" },
      total: { type: "number" },
    },
    required: ["invoiceNumber", "supplier", "total"],
    additionalProperties: false,
  };
  const metadata = [
    {
      name: "insert_invoice",
      description: "Insert one invoice",
      inputSchema: invoice,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    {
      name: "read_invoice",
      description: "Read an invoice",
      inputSchema: {
        type: "object",
        properties: { invoiceNumber: { type: "string" } },
        required: ["invoiceNumber"],
        additionalProperties: false,
      },
      outputSchema: invoice,
      annotations: { readOnlyHint: true },
    },
  ];
  await sql`INSERT INTO mcp_connectors(id,workspace_id,organization_id,name,url,capabilities) VALUES (${connector},${workspace},${org},'Invoice database','https://api.openai.com/v1/mcp',${sql.json({ tools: metadata })})`;
  const granted = await call(`/workspaces/${workspace}/mcp-action-grants`, {
    connectorId: connector,
    operation: "insert_invoice",
    sideEffect: "write",
    riskLevel: "medium",
    allowWrites: true,
  });
  assert.equal(granted.statusCode, 200, granted.body);
  const body = workflowDefinitionV2.parse({
    schemaVersion: 2,
    execution: {
      inputFields: [
        { name: "document", label: "OCR PDF", type: "json", required: true },
        {
          name: "approvedSample",
          label: "Approved sample",
          type: "json",
          required: true,
        },
      ],
      resources: { model: { kind: "model", id: model } },
      actions: [
        {
          id: "save",
          name: "MCP database write",
          connector: "agentconnect.mcp-operation",
          connectionId: connector,
          operation: "insert_invoice",
          inputSchema: invoice,
          sideEffect: "write",
          riskLevel: "medium",
          allowSideEffects: true,
          idempotency: "unsupported",
          mappedInputs: {
            invoiceNumber: reference("steps.extract.output.invoiceNumber"),
            supplier: reference("steps.extract.output.supplier"),
            total: reference("steps.extract.output.total"),
          },
        },
        {
          id: "read",
          name: "MCP database read",
          connector: "agentconnect.mcp-operation",
          connectionId: connector,
          operation: "read_invoice",
          inputSchema: metadata[1]!.inputSchema,
          outputSchema: invoice,
          mappedInputs: {
            invoiceNumber: reference("steps.extract.output.invoiceNumber"),
          },
        },
      ],
      nodes: [
        {
          id: "start",
          kind: "input",
          label: "Document and approved sample",
          config: {},
        },
        {
          id: "extract",
          kind: "structured-ai",
          label: "Extract using approved sample",
          config: {
            resource: "model",
            input: reference("input"),
            instruction:
              "Extract the OCR text in input.document using input.approvedSample as the reviewed format and guidance. Never copy sample values into another invoice.",
            outputSchema: invoice,
          },
        },
        {
          id: "save",
          kind: "action",
          label: "Database write",
          config: { actionId: "save" },
        },
        {
          id: "read",
          kind: "action",
          label: "Read persisted data",
          config: { actionId: "read" },
        },
        {
          id: "validate",
          kind: "condition",
          label: "Validate persisted total",
          config: {
            condition: {
              operator: "equals",
              left: reference("steps.read.output.total"),
              right: reference("steps.extract.output.total"),
            },
          },
        },
        {
          id: "error",
          kind: "human-task",
          label: "Review database discrepancy",
          config: {
            mode: "approve-reject",
            prompt:
              "The persisted total differs from the extracted total. Reconcile before completing.",
            outputSchema: { type: "object" },
          },
        },
        {
          id: "join",
          kind: "merge",
          label: "Validated or reconciled",
          config: {},
        },
        {
          id: "end",
          kind: "output",
          label: "Validated invoice",
          config: { input: reference("steps.read.output") },
        },
      ],
      edges: [
        { id: "a", source: "start", target: "extract" },
        { id: "b", source: "extract", target: "save" },
        { id: "c", source: "save", target: "read" },
        { id: "d", source: "read", target: "validate" },
        { id: "valid", source: "validate", target: "join", branch: "true" },
        { id: "invalid", source: "validate", target: "error", branch: "false" },
        { id: "reviewed", source: "error", target: "join" },
        { id: "finish", source: "join", target: "end" },
      ],
    },
  });
  const child = await call(`/workspaces/${workspace}/workflows`, {
    name: "Process reviewed OCR invoice",
    graph: body,
  });
  assert.equal(child.statusCode, 201, child.body);
  const published = await call(`/workflows/${child.json().id}/publish`, {
    revision: 1,
  });
  assert.equal(published.statusCode, 201, published.body);
  const generated = workflowDefinitionV2.parse({
    schemaVersion: 2,
    execution: {
      inputFields: [
        {
          name: "files",
          label: "OCR PDF documents",
          type: "json",
          required: true,
        },
      ],
      resources: {
        model: { kind: "model", id: model },
        body: {
          kind: "workflow",
          workflowId: child.json().id,
          versionId: published.json().id,
          versionBehavior: "pinned",
        },
      },
      nodes: [
        {
          id: "start",
          kind: "input",
          label: "Upload OCR PDF documents",
          config: {},
        },
        {
          id: "extract",
          kind: "structured-ai",
          label: "Extract sample",
          config: {
            resource: "model",
            input: reference("input.files[0]"),
            instruction: "Extract the OCR PDF document into invoice fields",
            outputSchema: invoice,
          },
        },
        {
          id: "review",
          kind: "human-task",
          label: "Review and correct sample",
          config: {
            input: reference("steps.extract.output"),
            mode: "review-edit",
            prompt:
              "Review and correct one sample. Click Process to continue with remaining documents.",
            approveLabel: "Process",
            outputSchema: invoice,
          },
        },
        {
          id: "remaining",
          kind: "for-each",
          label: "Process remaining PDFs",
          config: {
            resource: "body",
            collection: reference("input.files"),
            startIndex: 1,
            maxItems: 25,
            failurePolicy: "fail-workflow",
            itemInputs: {
              document: reference("item"),
              approvedSample: reference("steps.review.output"),
            },
          },
        },
        {
          id: "end",
          kind: "output",
          label: "Validated processing results",
          config: { input: reference("steps.remaining.output") },
        },
      ],
      edges: [
        { id: "a", source: "start", target: "extract" },
        { id: "b", source: "extract", target: "review" },
        { id: "c", source: "review", target: "remaining" },
        { id: "d", source: "remaining", target: "end" },
      ],
    },
  });
  output = {
    kind: "definition",
    message:
      "Review one OCR sample, then process each remaining document through the published extraction and MCP persistence/validation workflow. Supply OCR text from your upload integration; no OCR binary parser is configured automatically.",
    definition: generated,
  };
  const response = await call(endpoint, {
    ...request(),
    prompt:
      "Upload OCR PDF documents. Extract them to structured data. Let me review and correct a sample. When I click Process, use the reviewed sample as guidance for the remaining documents. Store the result in the database through MCP, query the database to validate it, and finish only when validation succeeds.",
  });
  assert.equal(response.statusCode, 200, response.body);
  const candidate = response.json().definition;
  assert.deepEqual(
    compileWorkflowDefinition(candidate).programV2!.execution,
    generated.execution,
  );
  assert.ok(requests.at(-1)!.content.includes("insert_invoice"));
  assert.ok(requests.at(-1)!.content.includes("approvedSample"));
  assert.ok(requests.at(-1)!.content.includes(published.json().id));
  assert.equal(
    candidate.execution.nodes.find(
      (n: { kind: string }) => n.kind === "human-task",
    ).config.approveLabel,
    "Process",
  );
  assert.equal(
    candidate.execution.nodes.find(
      (n: { kind: string }) => n.kind === "for-each",
    ).config.startIndex,
    1,
  );
  const created = await call(`/workspaces/${workspace}/workflows`, {
    name: "AI generated document workflow",
    graph: candidate,
  });
  assert.equal(created.statusCode, 201, created.body);
  const validated = await call(`/workflows/${created.json().id}/validate`, {});
  assert.equal(validated.statusCode, 200, validated.body);
  assert.equal(validated.json().valid, true);
  assert.ok(
    response
      .json()
      .warnings.some((w: string) => w.includes("MCP database write")),
  );
  const forged = simple();
  forged.execution.actions = workflowDefinitionV2.parse({
    schemaVersion: 2,
    execution: {
      ...simple().execution,
      actions: [
        {
          id: "write",
          name: "Missing real mappings",
          connector: "agentconnect.mcp-operation",
          connectionId: connector,
          operation: "insert_invoice",
          inputSchema: { type: "object" },
          sideEffect: "write",
          riskLevel: "medium",
          allowSideEffects: true,
        },
      ],
    },
  }).execution.actions;
  forged.execution.nodes.splice(1, 0, {
    id: "write",
    kind: "action",
    label: "Write with hidden required fields",
    config: { actionId: "write", inputs: {} },
  });
  forged.execution.edges = [
    { id: "a", source: "start", target: "write" },
    { id: "b", source: "write", target: "end" },
  ];
  output = {
    kind: "definition",
    message: "Try to hide the operation input requirements",
    definition: forged,
  };
  const rejected = await call(endpoint, request());
  assert.equal(rejected.statusCode, 422, rejected.body);
  assert.match(rejected.body, /required Action input/);
  await sql`UPDATE workflow_mcp_action_grants SET enabled=false WHERE connector_id=${connector}`;
  const revoked = await call(endpoint + "/validate", { definition: candidate });
  assert.equal(revoked.statusCode, 400, revoked.body);
});

test("Configure can attach an existing model to an unconfigured node but cannot change another node's shared resource", async () => {
  const source = simple();
  source.execution.nodes.splice(1, 0, {
    id: "extract",
    kind: "structured-ai",
    label: "Extract",
    config: {
      resource: "selected_model",
      instruction: "Extract fields",
      outputSchema: { type: "object" },
    },
  });
  source.execution.edges = [
    { id: "a", source: "start", target: "extract" },
    { id: "b", source: "extract", target: "end" },
  ];
  output = {
    kind: "mutations",
    message: "Use the selected workspace model",
    operations: [
      {
        op: "upsertResource",
        name: "selected_model",
        resource: { kind: "model", id: model },
      },
    ],
  };
  const configured = await call(endpoint, {
    ...request("configure", source),
    selectedNodeId: "extract",
  });
  assert.equal(configured.statusCode, 200, configured.body);
  assert.equal(
    configured.json().definition.execution.resources.selected_model.id,
    model,
  );
  const shared = workflowDefinitionV2.parse(configured.json().definition);
  shared.execution.nodes.splice(2, 0, {
    id: "second",
    kind: "structured-ai",
    label: "Second extraction",
    config: {
      resource: "selected_model",
      instruction: "Extract other fields",
      outputSchema: { type: "object" },
    },
  });
  shared.execution.edges = [
    { id: "a", source: "start", target: "extract" },
    { id: "b", source: "extract", target: "second" },
    { id: "c", source: "second", target: "end" },
  ];
  const rejected = await call(endpoint, {
    ...request("configure", shared),
    selectedNodeId: "extract",
  });
  assert.equal(rejected.statusCode, 422, rejected.body);
  assert.match(rejected.body, /shared resource/);
});
test("mapping inspection ignores literal payloads that happen to resemble reference objects", () => {
  const d = simple();
  d.execution.nodes[1]!.config = {
    input: {
      type: "literal",
      value: { type: "reference", path: "steps.missing.output.password" },
    },
  };
  assert.deepEqual(assistantMappingWarnings(d), []);
  d.execution.nodes[1]!.config = {
    input: { type: "reference", path: "input", pointer: "/unknown" },
  };
  assert.ok(
    assistantMappingWarnings(d).some((w) => w.includes("JSON Pointer")),
  );
});

test("template customization requests keep extraction/review schemas aligned and clarify unavailable capabilities", async () => {
  const baseSchema = {
    type: "object",
    properties: {
      invoiceNumber: { type: "string" },
      currency: { type: "string" },
      total: { type: "number" },
    },
    required: ["invoiceNumber", "currency", "total"],
    additionalProperties: false,
  };
  const source = workflowDefinitionV2.parse({
    schemaVersion: 2,
    execution: {
      resources: { model: { kind: "model", id: model } },
      nodes: [
        { id: "start", kind: "input", label: "Document", config: {} },
        {
          id: "extract",
          kind: "structured-ai",
          label: "Extract record",
          config: {
            resource: "model",
            instruction: "Extract configured fields",
            outputSchema: baseSchema,
          },
        },
        {
          id: "review",
          kind: "human-task",
          label: "Review schema fields",
          config: {
            mode: "review-edit",
            prompt: "Review record",
            input: reference("steps.extract.output"),
            outputSchema: baseSchema,
          },
        },
        {
          id: "end",
          kind: "output",
          label: "Complete",
          config: { input: reference("steps.review.output") },
        },
      ],
      edges: [
        { id: "a", source: "start", target: "extract" },
        { id: "b", source: "extract", target: "review" },
        { id: "c", source: "review", target: "end" },
      ],
    },
  });
  const count = (
    await sql`SELECT id FROM workflows WHERE organization_id=${org}`
  ).length;
  for (const [prompt, field, remove] of [
    ["Add purchaseOrderNumber.", "purchaseOrderNumber", false],
    ["Remove currency.", "currency", true],
    ["Store supplier email too.", "supplierEmail", false],
  ] as const) {
    const schema = structuredClone(baseSchema) as {
      type: string;
      properties: Record<string, { type: string }>;
      required: string[];
      additionalProperties: boolean;
    };
    if (remove) {
      delete schema.properties[field];
      schema.required = schema.required.filter((k) => k !== field);
    } else schema.properties[field] = { type: "string" };
    const nodes = source.execution.nodes
      .filter((n) => n.kind === "structured-ai" || n.kind === "human-task")
      .map((n) => ({ ...n, config: { ...n.config, outputSchema: schema } }));
    output = {
      kind: "mutations",
      message:
        "Review the aligned extraction and review fields; configure storage separately if its operation does not expose this field.",
      operations: nodes.map((node) => ({
        op: "updateNode",
        nodeId: node.id,
        node,
      })),
    };
    const result = await call(endpoint, {
      ...request("modify", source),
      prompt,
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(
      Object.hasOwn(
        result.json().definition.execution.nodes[1].config.outputSchema
          .properties,
        field,
      ),
      !remove,
    );
    assert.deepEqual(
      result.json().definition.execution.nodes[1].config.outputSchema,
      result.json().definition.execution.nodes[2].config.outputSchema,
    );
  }
  for (const [prompt, message] of [
    [
      "Process 5 documents in parallel.",
      "For Each currently executes sequentially. Use explicit fixed Parallel branches or keep sequential iteration.",
    ],
    [
      "Use my Production DB MCP connection.",
      "No enabled Production DB MCP connection is available in this workspace. Configure and grant an existing operation first.",
    ],
    [
      "Use my Invoice Extraction Agent instead of Structured AI.",
      "Publish the Invoice Extraction Agent first; no matching published Agent is available in this workspace.",
    ],
  ]) {
    output = { kind: "clarification", message };
    const result = await call(endpoint, {
      ...request("modify", source),
      prompt,
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().definition, null);
    assert.equal(result.json().message, message);
  }
  assert.ok(
    requests
      .at(-1)!
      .system.includes("For Each currently runs sequentially only"),
  );
  assert.equal(
    (await sql`SELECT id FROM workflows WHERE organization_id=${org}`).length,
    count,
  );
});
