import { z } from "zod";
export const workflowKinds = [
  "input",
  "agent",
  "tool",
  "router",
  "condition",
  "parallel",
  "merge",
  "approval",
  "output",
] as const;
const nodeId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,47}$/);
export const workflowNode = z.object({
  id: nodeId,
  type: z.enum(workflowKinds),
  position: z.object({
    x: z.number().min(-10000).max(10000),
    y: z.number().min(-10000).max(10000),
  }),
  data: z.object({
    label: z.string().min(1).max(100),
    agentVersionId: z.uuid().optional(),
    toolId: z.uuid().optional(),
    toolArguments: z.record(z.string(), z.json()).default({}),
    inputArgument: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
      .optional(),
    inputFrom: nodeId.optional(),
    operator: z.enum(["contains", "equals", "not-empty"]).default("contains"),
    value: z.string().max(1000).default(""),
    prefix: z.string().max(2000).default(""),
    suffix: z.string().max(2000).default(""),
    approvalPrompt: z
      .string()
      .max(2000)
      .default("Review this result before continuing."),
  }),
});
export const workflowEdge = z.object({
  id: z.string().min(1).max(128),
  source: nodeId,
  target: nodeId,
  sourceHandle: z.enum(["true", "false"]).nullable().optional(),
});
export const workflowGraph = z.object({
  schemaVersion: z.literal(1).default(1),
  nodes: z.array(workflowNode).min(1).max(40),
  edges: z.array(workflowEdge).max(80),
});
export const workflowInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(""),
  graph: workflowGraph,
});
export const workflowUpdate = workflowInput.extend({
  revision: z.number().int().min(1),
});
export const workflowRunInput = z.object({
  input: z.string().trim().min(1).max(12000),
  versionId: z.uuid().optional(),
  revision: z.number().int().min(1).optional(),
});
export const workflowApprovalInput = z.object({
  decision: z.enum(["approved", "rejected"]),
  comment: z.string().max(2000).default(""),
  editedInput: z.json().optional(),
});
export type WorkflowGraph = z.infer<typeof workflowGraph>;
export type WorkflowNode = z.infer<typeof workflowNode>;
export function analyzeWorkflow(graph: WorkflowGraph) {
  const errors: string[] = [];
  const joins: Record<string, string[]> = {};
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, string[]>(),
    outgoing = new Map<string, string[]>();
  for (const n of graph.nodes) {
    incoming.set(n.id, []);
    outgoing.set(n.id, []);
  }
  if (nodes.size !== graph.nodes.length) errors.push("Node IDs must be unique");
  if (new Set(graph.edges.map((e) => e.id)).size !== graph.edges.length)
    errors.push("Edge IDs must be unique");
  const pairs = new Set<string>();
  for (const e of graph.edges) {
    if (!nodes.has(e.source) || !nodes.has(e.target)) {
      errors.push("Connections must reference existing nodes");
      continue;
    }
    const pair = e.source + ":" + e.target;
    if (pairs.has(pair)) errors.push("Duplicate connections are not allowed");
    pairs.add(pair);
    incoming.get(e.target)!.push(e.source);
    outgoing.get(e.source)!.push(e.target);
  }
  const inputs = graph.nodes.filter((n) => n.type === "input"),
    outputs = graph.nodes.filter((n) => n.type === "output");
  if (inputs.length !== 1) errors.push("Exactly one Input node is required");
  if (outputs.length !== 1) errors.push("Exactly one Output node is required");
  if (graph.nodes.filter((n) => n.type === "approval").length > 1)
    errors.push("This workflow supports one approval gate");
  const colors = new Map<string, number>();
  let cycle = false;
  function visit(id: string) {
    if (colors.get(id) === 1) {
      cycle = true;
      return;
    }
    if (colors.get(id) === 2) return;
    colors.set(id, 1);
    for (const next of outgoing.get(id) ?? []) visit(next);
    colors.set(id, 2);
  }
  for (const id of nodes.keys()) visit(id);
  if (cycle) errors.push("Cycles require a loop policy and are not supported");
  const reach = (start: string, links: Map<string, string[]>) => {
    const seen = new Set<string>();
    const todo = [start];
    while (todo.length) {
      const id = todo.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      todo.push(...(links.get(id) ?? []));
    }
    return seen;
  };
  if (inputs.length === 1 && outputs.length === 1) {
    const reachable = reach(inputs[0]!.id, outgoing),
      finishes = reach(outputs[0]!.id, incoming);
    for (const n of graph.nodes) {
      if (!reachable.has(n.id))
        errors.push(`${n.data.label}: unreachable from Input`);
      if (!finishes.has(n.id))
        errors.push(`${n.data.label}: no path to Output`);
    }
  }
  for (const n of graph.nodes) {
    const ins = incoming.get(n.id)!,
      outs = outgoing.get(n.id)!;
    if (n.type === "input" && ins.length)
      errors.push("Input cannot have incoming connections");
    if (n.type === "output" && outs.length)
      errors.push("Output cannot have outgoing connections");
    if (n.type !== "input" && !ins.length)
      errors.push(`${n.data.label}: incoming connection required`);
    if (n.type !== "output" && !outs.length)
      errors.push(`${n.data.label}: outgoing connection required`);
    if (ins.length > 1 && n.type !== "merge")
      errors.push(`${n.data.label}: use a Merge node before converging paths`);
    if (n.type === "router" || n.type === "condition") {
      const edges = graph.edges.filter((e) => e.source === n.id);
      if (
        edges.length !== 2 ||
        !edges.some((e) => e.sourceHandle === "true") ||
        !edges.some((e) => e.sourceHandle === "false")
      )
        errors.push(`${n.data.label}: connect one true and one false branch`);
    } else if (n.type === "parallel") {
      if (outs.length < 2 || outs.length > 4)
        errors.push(`${n.data.label}: connect two to four branches`);
    } else if (outs.length > 1)
      errors.push(`${n.data.label}: use Router or Parallel for branching`);
    if (
      !["router", "condition"].includes(n.type) &&
      graph.edges.some((e) => e.source === n.id && e.sourceHandle)
    )
      errors.push(
        `${n.data.label}: branch handles only belong to Router/Condition`,
      );
    if (n.type === "agent" && !n.data.agentVersionId)
      errors.push(`${n.data.label}: select a published agent version`);
    if (n.type === "tool" && !n.data.toolId)
      errors.push(`${n.data.label}: select a registered tool`);
    if (n.data.inputFrom) {
      if (
        !nodes.has(n.data.inputFrom) ||
        n.data.inputFrom === n.id ||
        !reach(n.id, incoming).has(n.data.inputFrom)
      )
        errors.push(
          `${n.data.label}: input mapping must reference an ancestor`,
        );
    }
  }
  if (!cycle)
    for (const n of graph.nodes.filter((n) => n.type === "parallel")) {
      const branches = outgoing.get(n.id)!;
      const ends: string[] = [];
      const branchNodes = new Set<string>();
      const terminalSources: string[] = [];
      for (const start of branches) {
        let current = start;
        const path = new Set<string>();
        let previous = n.id;
        for (let step = 0; step < graph.nodes.length; step++) {
          const item = nodes.get(current);
          if (!item) break;
          if (item.type === "merge") {
            ends.push(current);
            terminalSources.push(previous);
            break;
          }
          if (
            [
              "input",
              "output",
              "parallel",
              "router",
              "condition",
              "approval",
            ].includes(item.type) ||
            path.has(current) ||
            branchNodes.has(current)
          ) {
            errors.push(
              `${n.data.label}: parallel branches must be separate linear agent/tool paths ending at one Merge`,
            );
            break;
          }
          path.add(current);
          branchNodes.add(current);
          const next = outgoing.get(current) ?? [];
          if (next.length !== 1) break;
          previous = current;
          current = next[0]!;
        }
      }
      if (ends.length !== branches.length || new Set(ends).size !== 1)
        errors.push(
          `${n.data.label}: all branches must join at the same Merge`,
        );
      else if (incoming.get(ends[0]!)!.length !== terminalSources.length)
        errors.push(
          `${n.data.label}: parallel Merge cannot accept other incoming paths`,
        );
      else joins[ends[0]!] = terminalSources;
    }
  return { errors: [...new Set(errors)], joins };
}
