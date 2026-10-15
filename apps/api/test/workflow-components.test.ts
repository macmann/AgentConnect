import { test } from "node:test";
import assert from "node:assert/strict";
import {
  workflowGraph,
  analyzeWorkflow,
} from "@agentconnect/schemas/workflows";
import {
  componentBoundary,
  extractComponent,
  insertComponent,
} from "@agentconnect/schemas/workflow-components";
const n = (id: string, type: string, data: Record<string, unknown> = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { label: id, ...data },
});
const g = (nodes: unknown[], edges: string[][]) =>
  workflowGraph.parse({
    nodes,
    edges: edges.map(([source, target], i) => ({
      id: `e${i}`,
      source,
      target,
    })),
  });
test("component insertion remaps internal inputs, edges and IDs without mutating its source", () => {
  const component = g(
    [n("first", "merge"), n("last", "merge", { inputFrom: "first" })],
    [["first", "last"]],
  );
  const host = g([n("in", "input"), n("out", "output")], [["in", "out"]]);
  const result = insertComponent(host, component, "in", "c123");
  assert.equal(
    result.nodes.find((n) => n.id === "c123_1")!.data.inputFrom,
    "c123_0",
  );
  assert.equal(component.nodes[1]!.data.inputFrom, "first");
  assert.equal(host.nodes.length, 2);
  assert.deepEqual(analyzeWorkflow(result).errors, []);
  const second = insertComponent(result, component, "in", "c456");
  assert.deepEqual(analyzeWorkflow(second).errors, []);
  assert.equal(second.nodes.length, 6);
  assert.throws(
    () => insertComponent(result, component, "in", "c123"),
    /conflict/,
  );
});
test("component boundaries reject disconnected, cyclic and external-input groups", () => {
  assert.throws(
    () => componentBoundary(g([n("a", "merge"), n("b", "merge")], [])),
    /one entry/,
  );
  assert.throws(
    () =>
      componentBoundary(
        g(
          [n("a", "merge"), n("b", "merge")],
          [
            ["a", "b"],
            ["b", "a"],
          ],
        ),
      ),
    /one entry/,
  );
  const host = g(
    [
      n("in", "input"),
      n("a", "merge", { inputFrom: "in" }),
      n("out", "output"),
    ],
    [
      ["in", "a"],
      ["a", "out"],
    ],
  );
  assert.throws(() => extractComponent(host, ["a"]), /inside/);
});
