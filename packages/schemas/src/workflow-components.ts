import { z } from "zod";
import {
  workflowGraph,
  analyzeWorkflow,
  type WorkflowGraph,
} from "@agentconnect/schemas/workflows";
// Stored components are expanded into ordinary nodes before draft save. Runtime
// snapshots and dependency checks therefore need no parallel execution model.
export function componentBoundary(graph: WorkflowGraph) {
  const ids = new Set(graph.nodes.map((n) => n.id));
  if (graph.nodes.some((n) => n.type === "input" || n.type === "output"))
    throw new Error("Select processing nodes only; exclude Input and Output");
  if (
    graph.edges.some((e) => !ids.has(e.source) || !ids.has(e.target)) ||
    graph.nodes.some((n) => n.data.inputFrom && !ids.has(n.data.inputFrom))
  )
    throw new Error("Component references must stay inside the selected group");
  const entries = graph.nodes.filter(
    (n) => !graph.edges.some((e) => e.target === n.id),
  );
  const exits = graph.nodes.filter(
    (n) => !graph.edges.some((e) => e.source === n.id),
  );
  if (entries.length !== 1 || exits.length !== 1)
    throw new Error("Select a connected group with one entry and one exit");
  const reserved = new Set(ids);
  let i = "component_input",
    o = "component_output";
  while (reserved.has(i)) i += "_";
  while (reserved.has(o)) o += "_";
  const wrapped = workflowGraph.parse({
    nodes: [
      {
        id: i,
        type: "input",
        position: { x: 0, y: 0 },
        data: { label: "Input" },
      },
      ...graph.nodes,
      {
        id: o,
        type: "output",
        position: { x: 0, y: 0 },
        data: { label: "Output" },
      },
    ],
    edges: [
      ...graph.edges,
      { id: i, source: i, target: entries[0]!.id },
      { id: o, source: exits[0]!.id, target: o },
    ],
  });
  const errors = analyzeWorkflow(wrapped).errors;
  if (errors.length) throw new Error(errors.join("; "));
  return { entry: entries[0]!.id, exit: exits[0]!.id };
}
export const componentInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000).default(""),
    graph: workflowGraph,
  })
  .superRefine((value, ctx) => {
    try {
      componentBoundary(value.graph);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["graph"],
        message: (error as Error).message,
      });
    }
  });
export function extractComponent(graph: WorkflowGraph, selection: string[]) {
  const ids = new Set(selection);
  const result = workflowGraph.parse({
    nodes: graph.nodes.filter((n) => ids.has(n.id)),
    edges: graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
  });
  componentBoundary(result);
  return result;
}
export function insertComponent(
  graph: WorkflowGraph,
  component: WorkflowGraph,
  anchorId: string,
  prefix: string,
): WorkflowGraph {
  const boundary = componentBoundary(component),
    anchor = graph.nodes.find((n) => n.id === anchorId);
  if (
    !anchor ||
    ["output", "condition", "router", "parallel"].includes(anchor.type)
  )
    throw new Error("Select a node with a single output to insert after");
  const outgoing = graph.edges.filter((e) => e.source === anchorId);
  if (outgoing.length !== 1 || outgoing[0]!.sourceHandle)
    throw new Error("Select a node with one outgoing connection");
  if (
    graph.nodes.length + component.nodes.length > 40 ||
    graph.edges.length + component.edges.length + 1 > 80
  )
    throw new Error("This component exceeds workflow size limits");
  const names = new Map(
    component.nodes.map((n, i) => [n.id, `${prefix}_${i}`]),
  );
  if ([...names.values()].some((id) => graph.nodes.some((n) => n.id === id)))
    throw new Error("Component node IDs conflict; retry insertion");
  const minX = Math.min(...component.nodes.map((n) => n.position.x)),
    minY = Math.min(...component.nodes.map((n) => n.position.y));
  return workflowGraph.parse({
    ...graph,
    nodes: [
      ...graph.nodes,
      ...component.nodes.map((n) => ({
        ...n,
        id: names.get(n.id)!,
        position: {
          x: Math.min(10000, anchor.position.x + 240 + n.position.x - minX),
          y: Math.min(10000, anchor.position.y + n.position.y - minY),
        },
        data: {
          ...n.data,
          ...(n.data.inputFrom
            ? { inputFrom: names.get(n.data.inputFrom) }
            : {}),
        },
      })),
    ],
    edges: [
      ...graph.edges.filter((e) => e.source !== anchorId),
      ...component.edges.map((e, i) => ({
        ...e,
        id: `${prefix}_edge_${i}`,
        source: names.get(e.source)!,
        target: names.get(e.target)!,
      })),
      {
        id: `${prefix}_in`,
        source: anchorId,
        target: names.get(boundary.entry)!,
      },
      {
        ...outgoing[0]!,
        id: `${prefix}_out`,
        source: names.get(boundary.exit)!,
      },
    ],
  });
}
