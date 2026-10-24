import { test } from "node:test";
import assert from "node:assert/strict";
import {
  workflowGraph,
  analyzeWorkflow,
} from "@agentconnect/schemas/workflows";
import {
  selectWorkflowField,
  resolveWorkflowMapping,
  workflowToolArguments,
  workflowFieldOptions,
  workflowFieldPath,
} from "@agentconnect/schemas/workflow-mapping";
import {
  insertComponent,
  componentBoundary,
} from "@agentconnect/schemas/workflow-components";
const node = (
  id: string,
  type: string,
  data: Record<string, unknown> = {},
) => ({ id, type, position: { x: 0, y: 0 }, data: { label: id, ...data } });
const graph = (data: Record<string, unknown> = {}) =>
  workflowGraph.parse({
    nodes: [
      node("input", "input"),
      node("middle", "merge"),
      node("output", "output", data),
    ],
    edges: [
      { id: "a", source: "input", target: "middle" },
      { id: "b", source: "middle", target: "output" },
    ],
  });
test("field selection handles objects, arrays, escaped keys and JSON agent output without changing scalar types", () => {
  const value = {
    customer: { name: "A" },
    items: [{ amount: 12, active: false }],
    nothing: null,
    "a/b": { "~key": "escaped" },
  };
  assert.equal(selectWorkflowField(value, "/customer/name"), "A");
  assert.equal(selectWorkflowField(value, "/items/0/amount"), 12);
  assert.equal(selectWorkflowField(value, "/items/0/active"), false);
  assert.equal(selectWorkflowField(value, "/nothing"), null);
  assert.equal(selectWorkflowField(value, "/a~1b/~0key"), "escaped");
  assert.equal(
    selectWorkflowField(JSON.stringify(value), "/items/0/amount"),
    12,
  );
  assert.equal(selectWorkflowField("unstructured"), "unstructured");
  assert.equal(selectWorkflowField(value), value);
});
test("missing, inherited, unsafe or malformed paths fail explicitly instead of silently falling back", () => {
  for (const path of [
    "customer.name",
    "/bad~2",
    "/__proto__",
    "/constructor/x",
    "/prototype",
    "/" + Array(22).fill("a").join("/"),
  ])
    assert.equal(workflowFieldPath.safeParse(path).success, false, path);
  assert.throws(() => selectWorkflowField("plain answer", "/name"), {
    code: "WORKFLOW_MAPPING_NOT_STRUCTURED",
  });
  for (const path of ["/missing", "/a/name", "/items/02", "/items/length"])
    assert.throws(() => selectWorkflowField({ a: null, items: [1, 2] }, path), {
      code: "WORKFLOW_MAPPING_FIELD_MISSING",
    });
  assert.throws(
    () =>
      selectWorkflowField(Object.create({ secret: "inherited" }), "/secret"),
    { code: "WORKFLOW_MAPPING_FIELD_MISSING" },
  );
});
test("mapping retains legacy predecessor/ancestor behavior and assembles named fields across ancestors", () => {
  const outputs = {
    input: { customer: { name: "A" } },
    middle: { score: 0.8, approved: false },
  };
  let g = graph();
  assert.deepEqual(
    resolveWorkflowMapping(g.nodes[2]!, g, outputs),
    outputs.middle,
  );
  g = graph({ inputFrom: "input" });
  assert.deepEqual(
    resolveWorkflowMapping(g.nodes[2]!, g, outputs),
    outputs.input,
  );
  g = graph({ inputFrom: "input", inputPath: "/customer/name" });
  assert.equal(resolveWorkflowMapping(g.nodes[2]!, g, outputs), "A");
  g = graph({
    inputBindings: [
      { target: "name", source: "input", path: "/customer/name" },
      { target: "score", source: "middle", path: "/score" },
      { target: "approved", source: "middle", path: "/approved" },
    ],
  });
  assert.deepEqual(analyzeWorkflow(g).errors, []);
  assert.deepEqual(resolveWorkflowMapping(g.nodes[2]!, g, outputs), {
    name: "A",
    score: 0.8,
    approved: false,
  });
  assert.throws(
    () => resolveWorkflowMapping(g.nodes[2]!, g, { input: outputs.input }),
    { code: "WORKFLOW_MAPPING_UNAVAILABLE" },
  );
});
test("graph validation rejects conflicting modes, duplicates and non-ancestor references", () => {
  for (const data of [
    {
      inputFrom: "input",
      inputBindings: [{ target: "value", source: "input", path: "" }],
    },
    {
      inputBindings: [
        { target: "value", source: "input" },
        { target: "value", source: "middle" },
      ],
    },
    { inputBindings: [{ target: "value", source: "output" }] },
    { inputBindings: [{ target: "value", source: "missing" }] },
  ])
    assert(analyzeWorkflow(graph(data)).errors.length);
  assert.throws(() =>
    graph({ inputBindings: [{ target: "__proto__", source: "input" }] }),
  );
  const g = graph();
  g.nodes[0]!.data.inputPath = "/test";
  assert(analyzeWorkflow(g).errors.some((e) => e.includes("Input nodes")));
});
test("named tool arguments preserve values and override only mapped static keys; legacy mapping remains text", () => {
  const tool = workflowGraph.parse({
    nodes: [
      node("tool", "tool", {
        toolArguments: { limit: 10, keep: "static" },
        inputBindings: [{ target: "limit", source: "input", path: "/limit" }],
      }),
    ],
    edges: [],
  }).nodes[0]!;
  assert.deepEqual(workflowToolArguments(tool, { limit: 2, enabled: false }), {
    limit: 2,
    enabled: false,
    keep: "static",
  });
  tool.data.inputBindings = undefined;
  tool.data.inputArgument = "query";
  assert.deepEqual(workflowToolArguments(tool, { limit: 2 }), {
    limit: 10,
    keep: "static",
    query: '{"limit":2}',
  });
});
test("field discovery is bounded and includes structured JSON text without exposing inherited keys", () => {
  const options = workflowFieldOptions(
    JSON.stringify({ customer: { name: "A" }, rows: [{ amount: 1 }] }),
  );
  assert(
    options.some((o) => o.path === "/rows/0/amount" && o.type === "number"),
  );
  assert.equal(workflowFieldOptions("plain text").length, 0);
  assert(
    workflowFieldOptions(Array.from({ length: 1000 }, () => ({ x: 1, y: 2 })))
      .length <= 150,
  );
});
test("component insertion remaps named bindings and rejects references outside its boundary", () => {
  const component = workflowGraph.parse({
    nodes: [
      node("first", "merge"),
      node("last", "merge", {
        inputBindings: [{ target: "value", source: "first", path: "/name" }],
      }),
    ],
    edges: [{ id: "a", source: "first", target: "last" }],
  });
  const host = workflowGraph.parse({
    nodes: [node("input", "input"), node("output", "output")],
    edges: [{ id: "a", source: "input", target: "output" }],
  });
  const result = insertComponent(host, component, "input", "mapped");
  assert.equal(
    result.nodes.find((n) => n.id === "mapped_1")!.data.inputBindings![0]!
      .source,
    "mapped_0",
  );
  assert.equal(component.nodes[1]!.data.inputBindings![0]!.source, "first");
  component.nodes[1]!.data.inputBindings![0]!.source = "outside";
  assert.throws(() => componentBoundary(component), /inside/);
});
