import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { workflowGraph } from "@agentconnect/schemas/workflows";
import {
  workflowDefinitionV2,
  compileWorkflowDefinition,
  validateWorkflowDefinition,
  agentChainDefinitionV2,
} from "@agentconnect/schemas/workflow-v2";
import { workflowAction } from "@agentconnect/schemas/workflow-actions";
import {
  workflowExpression,
  resolveWorkflowExpression,
  evaluateWorkflowCondition,
  assertWorkflowValue,
  type WorkflowCondition,
  type WorkflowDataContext,
} from "@agentconnect/schemas/workflow-values";
const literal = (value: unknown) =>
  workflowExpression.parse({ type: "literal", value });
const reference = (path: string, pointer?: string) =>
  workflowExpression.parse({
    type: "reference",
    path,
    ...(pointer !== undefined ? { pointer } : {}),
  });
const context: WorkflowDataContext = {
  trigger: { body: { customer: { email: "a@example.com" } } },
  input: { items: [{ amount: 12 }], enabled: true },
  steps: { ocr: { output: { text: "Invoice" } } },
  variables: { batchSize: 5 },
  workflow: { id: "workflow", versionId: null, runId: "run", schemaVersion: 2 },
  error: { code: null, nodeId: null },
};
const definition = () =>
  workflowDefinitionV2.parse({
    schemaVersion: 2,
    execution: {
      nodes: [
        { id: "start", kind: "input", label: "Start", config: {} },
        { id: "end", kind: "output", label: "End", config: {} },
      ],
      edges: [{ id: "next", source: "start", target: "end" }],
    },
  });

test("V1 remains the unchanged public contract; V2 execution and layout are separate", () => {
  const legacy = workflowGraph.parse({
    nodes: [
      {
        id: "start",
        type: "input",
        position: { x: 0, y: 0 },
        data: { label: "Start" },
      },
      {
        id: "end",
        type: "output",
        position: { x: 200, y: 0 },
        data: { label: "End" },
      },
    ],
    edges: [{ id: "next", source: "start", target: "end" }],
  });
  assert.deepEqual(compileWorkflowDefinition(legacy), legacy);
  const v2 = definition(),
    first = compileWorkflowDefinition(v2);
  v2.editor = {
    nodes: { start: { x: 400, y: 800 } },
    edges: {},
    viewport: { x: 10, y: 100, zoom: 1.5 },
  };
  const moved = compileWorkflowDefinition(v2);
  assert.deepEqual(first.programV2, moved.programV2);
  assert.notDeepEqual(first.nodes[0]!.position, moved.nodes[0]!.position);
  assert.equal(JSON.stringify(first.programV2).includes("editor"), false);
  assert.equal(first.nodes[0]!.type, "input");
  assert.ok(!workflowDefinitionV2.safeParse({ ...v2, nodes: [] }).success);
});
test("resource references are typed IDs and never inline agent, provider or credential configuration", () => {
  const v2 = definition(),
    agentId = randomUUID(),
    versionId = randomUUID();
  v2.execution.resources = {
    agent: { kind: "agent", agentId, versionId },
    kb: { kind: "knowledge", id: randomUUID() },
    tool: { kind: "tool", id: randomUUID() },
    mcp: { kind: "mcp", id: randomUUID() },
    model: { kind: "model", id: randomUUID() },
    secret: { kind: "secret", id: randomUUID() },
    connection: { kind: "connection", id: randomUUID() },
  };
  assert.ok(workflowDefinitionV2.safeParse(v2).success);
  assert.ok(
    !workflowDefinitionV2.safeParse({
      ...v2,
      execution: {
        ...v2.execution,
        resources: {
          agent: {
            kind: "agent",
            agentId,
            versionId,
            config: { prompt: "duplicate" },
          },
        },
      },
    }).success,
  );
  assert.ok(
    !workflowDefinitionV2.safeParse({
      ...v2,
      execution: {
        ...v2.execution,
        resources: {
          secret: { kind: "secret", id: randomUUID(), value: "credential" },
        },
      },
    }).success,
  );
});
test("safe workflow references resolve roots, nested objects, arrays, literals and legacy JSON Pointer", () => {
  assert.equal(
    resolveWorkflowExpression(
      reference("trigger.body.customer.email"),
      context,
    ),
    "a@example.com",
  );
  assert.equal(
    resolveWorkflowExpression(reference("input.items[0].amount"), context),
    12,
  );
  assert.equal(
    resolveWorkflowExpression(reference("steps.ocr.output.text"), context),
    "Invoice",
  );
  assert.equal(
    resolveWorkflowExpression(reference("variables.batchSize"), context),
    5,
  );
  assert.equal(
    resolveWorkflowExpression(reference("workflow.schemaVersion"), context),
    2,
  );
  assert.equal(
    resolveWorkflowExpression(reference("error.code"), context),
    null,
  );
  assert.deepEqual(
    resolveWorkflowExpression(literal({ items: [true, null, 3] }), context),
    { items: [true, null, 3] },
  );
  assert.equal(
    resolveWorkflowExpression(reference("input", ""), {
      ...context,
      input: "plain text",
    }),
    "plain text",
  );
  assert.equal(
    resolveWorkflowExpression(reference("input", "/items/0/amount"), context),
    12,
  );
  assert.equal(
    resolveWorkflowExpression(reference("input", "/a~1b/x~0y"), {
      ...context,
      input: '{"a/b":{"x~y":4}}',
    }),
    4,
  );
  assert.throws(
    () => resolveWorkflowExpression(reference("input.unknown"), context),
    /WORKFLOW_REFERENCE_MISSING/,
  );
  assert.throws(
    () => resolveWorkflowExpression(reference("input.items[9]"), context),
    /WORKFLOW_REFERENCE_MISSING/,
  );
});
test("prototype traversal, inherited properties, accessors, eval syntax and unbounded values are rejected", () => {
  for (const path of [
    "input.__proto__.polluted",
    "input.constructor.prototype",
    "input.prototype",
    "global.process",
    "input.foo()",
    "input.items[01]",
    "input['constructor']",
    "input.x + 2",
  ])
    assert.ok(
      !workflowExpression.safeParse({ type: "reference", path }).success,
      path,
    );
  assert.ok(
    !workflowExpression.safeParse({
      type: "reference",
      path: "input",
      pointer: "/__proto__/x",
    }).success,
  );
  assert.throws(
    () => resolveWorkflowExpression(reference("input.toString"), context),
    /WORKFLOW_REFERENCE_MISSING/,
  );
  let calls = 0;
  const getter = Object.defineProperty({}, "unsafe", {
    enumerable: true,
    get() {
      calls++;
      return "secret";
    },
  });
  assert.throws(() =>
    resolveWorkflowExpression(reference("input.unsafe"), {
      ...context,
      input: getter,
    }),
  );
  assert.throws(() => assertWorkflowValue(getter));
  assert.equal(calls, 0);
  assert.ok(
    !workflowExpression.safeParse({
      type: "literal",
      value: JSON.parse('{"__proto__":{"x":1}}'),
    }).success,
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.ok(
    !workflowExpression.safeParse({ type: "literal", value: cyclic }).success,
  );
  let deep: unknown = 1;
  for (let i = 0; i < 40; i++) deep = { value: deep };
  assert.ok(
    !workflowExpression.safeParse({ type: "literal", value: deep }).success,
  );
});
test("conditions operate on typed values without coercion or code execution", () => {
  const evaluate = (
    operator: WorkflowCondition["operator"],
    a: unknown,
    b?: unknown,
  ) =>
    evaluateWorkflowCondition(
      {
        operator,
        left: literal(a),
        ...(b !== undefined ? { right: literal(b) } : {}),
      },
      context,
    );
  assert.equal(evaluate("equals", { x: [1, true] }, { x: [1, true] }), true);
  assert.equal(evaluate("equals", 1, "1"), false);
  assert.equal(evaluate("not-equals", 1, 2), true);
  assert.equal(evaluate("contains", "invoice 42", "42"), true);
  assert.equal(evaluate("not-contains", [1, 2], 3), true);
  assert.equal(evaluate("contains", [{ a: 1 }], { a: 1 }), true);
  assert.equal(evaluate("greater-than", 3, 2), true);
  assert.equal(evaluate("greater-than-or-equal", 3, 3), true);
  assert.equal(evaluate("less-than", 2, 3), true);
  assert.equal(evaluate("less-than-or-equal", 3, 3), true);
  for (const value of [null, "", [], {}])
    assert.equal(evaluate("empty", value), true);
  assert.equal(evaluate("not-empty", 0), true);
  assert.equal(evaluate("true", true), true);
  assert.equal(evaluate("false", false), true);
  assert.throws(
    () => evaluate("greater-than", "3", 2),
    /WORKFLOW_CONDITION_TYPE/,
  );
  assert.throws(() => evaluate("true", "true"), /WORKFLOW_CONDITION_TYPE/);
});
test("compiler rejects malformed graphs and invalid or future references", () => {
  const d = definition();
  d.execution.edges.push({ id: "cycle", source: "end", target: "start" });
  assert.ok(validateWorkflowDefinition(d).some((e) => e.includes("Cycles")));
  const duplicate = definition();
  duplicate.execution.nodes.push(duplicate.execution.nodes[0]!);
  assert.ok(
    validateWorkflowDefinition(duplicate).some((e) => e.includes("unique")),
  );
  const missing = definition();
  missing.execution.edges[0]!.target = "missing";
  assert.ok(
    validateWorkflowDefinition(missing).some((e) =>
      e.includes("existing nodes"),
    ),
  );
  for (const path of [
    "steps.end.output",
    "steps.unknown.output",
    "variables.unknown",
    "workflow.password",
  ]) {
    const d = definition();
    d.execution.nodes[1] = {
      id: "end",
      kind: "output",
      label: "End",
      config: {
        input: reference(path),
        title: "",
        summary: "",
        format: "auto",
      },
    };
    assert.ok(validateWorkflowDefinition(d).length, path);
  }
  const id = definition();
  id.execution.nodes[0]!.id = "toString";
  assert.ok(validateWorkflowDefinition(id).length);
});
test("Action contract is bounded, reusable and rejects unsupported execution guarantees", () => {
  const action = workflowAction.parse({
    id: "lookup",
    name: "Lookup",
    connector: "agentconnect.tool",
    operation: "execute",
    toolId: randomUUID(),
  });
  assert.equal(action.retry.maxAttempts, 1);
  assert.equal(action.sideEffect, "read");
  assert.equal(action.timeoutMs, 5000);
  assert.deepEqual(action.inputSchema, { type: "object" });
  assert.ok(
    !workflowAction.safeParse({ ...action, retry: { maxAttempts: 100 } })
      .success,
  );
  assert.ok(
    !workflowAction.safeParse({ ...action, credentials: "secret" }).success,
  );
  for (const change of [
    { sideEffect: "write" },
    { idempotency: "key" },
    { requiredScopes: ["write:all"] },
  ]) {
    const d = definition();
    d.execution.actions = [workflowAction.parse({ ...action, ...change })];
    assert.ok(validateWorkflowDefinition(d).length);
  }
});
test("AI V2 conversion retains published resource references and never converts inline agents", () => {
  const agentId = randomUUID(),
    versionId = randomUUID();
  const legacy = workflowGraph.parse({
    nodes: [
      {
        id: "start",
        type: "input",
        position: { x: 0, y: 0 },
        data: { label: "Start" },
      },
      {
        id: "step",
        type: "agent",
        position: { x: 200, y: 0 },
        data: { label: "Agent", agentVersionId: versionId },
      },
      {
        id: "end",
        type: "output",
        position: { x: 400, y: 0 },
        data: { label: "End" },
      },
    ],
    edges: [
      { id: "first", source: "start", target: "step" },
      { id: "last", source: "step", target: "end" },
    ],
  });
  const converted = agentChainDefinitionV2(legacy, { [versionId]: agentId });
  assert.equal(converted.schemaVersion, 2);
  assert.deepEqual(converted.execution.resources.agent_step, {
    kind: "agent",
    agentId,
    versionId,
  });
  assert.equal(
    compileWorkflowDefinition(converted).nodes[1]!.data.agentVersionId,
    versionId,
  );
  assert.throws(() => agentChainDefinitionV2(legacy, {}));
});
