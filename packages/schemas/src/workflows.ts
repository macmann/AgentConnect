import { agentConfig } from "@agentconnect/schemas/agents";
import {
  workflowBinding,
  workflowFieldPath,
} from "@agentconnect/schemas/workflow-mapping";
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
  "structured-ai",
  "human-task",
  "transform",
  "set-variable",
  "switch",
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
    retry: z
      .object({
        maxAttempts: z.number().int().min(1).max(3).default(1),
        delayMs: z.number().int().min(100).max(10000).default(1000),
      })
      .default({ maxAttempts: 1, delayMs: 1000 }),
    resultTitle: z.string().trim().max(120).default(""),
    resultSummary: z.string().trim().max(400).default(""),
    resultFormat: z.enum(["auto", "text", "json"]).default("auto"),
    agentVersionId: z.uuid().optional(),
    inlineAgent: agentConfig.optional(),
    inlineModelSnapshot: z.record(z.string(), z.json()).optional(),
    toolId: z.uuid().optional(),
    toolArguments: z.record(z.string(), z.json()).default({}),
    inputArgument: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
      .optional(),
    inputFrom: nodeId.optional(),
    inputPath: workflowFieldPath.optional(),
    inputBindings: z.array(workflowBinding).max(20).optional(),
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
  sourceHandle: nodeId.nullable().optional(),
  sourcePort: z.enum(["out-top", "out-bottom", "out-left"]).optional(),
  targetPort: z.enum(["in-top", "in-bottom", "in-right"]).optional(),
});
export const workflowInputField = z.object({
  name: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
    .refine(
      (v) => !["__proto__", "constructor", "prototype"].includes(v),
      "Reserved field name",
    ),
  label: z.string().trim().min(1).max(100),
  type: z.enum(["text", "number", "boolean", "json"]),
  required: z.boolean().default(false),
  defaultValue: z.json().optional(),
});
export const workflowGraph = z.object({
  inputFields: z.array(workflowInputField).max(30).default([]),
  schemaVersion: z.literal(1).default(1),
  // Internal compiler artifact. Public definition inputs omit this field.
  programV2: z
    .object({
      compilerVersion: z.literal(1),
      execution: z.record(z.string(), z.json()),
      trigger: z.record(z.string(), z.json()).optional(),
    })
    .optional(),
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
  input: z.union([
    z.string().trim().min(1).max(12000),
    z.record(z.string(), z.json()),
  ]),
  versionId: z.uuid().optional(),
  revision: z.number().int().min(1).optional(),
});
export const workflowApprovalInput = z.object({
  nodeId: nodeId.optional(),
  decision: z.enum(["approved", "rejected"]),
  comment: z.string().max(2000).default(""),
  editedInput: z.json().optional(),
});
export type WorkflowGraph = z.infer<typeof workflowGraph>;
export type WorkflowNode = z.infer<typeof workflowNode>;
export function analyzeWorkflow(graph: WorkflowGraph) {
  const errors: string[] = [];
  if (
    !graph.programV2 &&
    graph.nodes.some((n) =>
      [
        "structured-ai",
        "human-task",
        "transform",
        "set-variable",
        "switch",
      ].includes(n.type),
    )
  )
    errors.push("These node kinds require Workflow V2");
  if (
    new Set(graph.inputFields?.map((f) => f.name)).size !==
    (graph.inputFields?.length ?? 0)
  )
    errors.push("Input field names must be unique");
  for (const field of graph.inputFields ?? []) {
    if (
      field.defaultValue !== undefined &&
      !validWorkflowValue(field.type, field.defaultValue)
    )
      errors.push(`${field.label}: default value must match its type`);
  }
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
  if (
    !graph.programV2 &&
    graph.nodes.filter((n) => n.type === "approval").length > 1
  )
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
    } else if (n.type === "switch" && graph.programV2) {
      if (outs.length < 2)
        errors.push(`${n.data.label}: connect cases and a default route`);
    } else if (n.type === "parallel") {
      if (outs.length < 2 || outs.length > 4)
        errors.push(`${n.data.label}: connect two to four branches`);
    } else if (outs.length > 1)
      errors.push(`${n.data.label}: use Router or Parallel for branching`);
    if (
      !["router", "condition", ...(graph.programV2 ? ["switch"] : [])].includes(
        n.type,
      ) &&
      graph.edges.some((e) => e.source === n.id && e.sourceHandle)
    )
      errors.push(
        `${n.data.label}: branch handles only belong to Router/Condition`,
      );
    if (
      !["agent", "tool"].includes(n.type) &&
      (n.data.retry?.maxAttempts ?? 1) > 1
    )
      errors.push(
        `${n.data.label}: retries are supported on agent and read-only tool steps`,
      );
    if (n.data.inlineAgent && n.data.agentVersionId)
      errors.push(`${n.data.label}: choose one agent source`);
    if (n.type === "agent" && !n.data.agentVersionId && !n.data.inlineAgent)
      errors.push(
        `${n.data.label}: choose an agent or create a workflow agent`,
      );
    if (n.type === "tool" && !n.data.toolId)
      errors.push(`${n.data.label}: select a registered tool`);
    if (
      n.type === "input" &&
      (n.data.inputFrom || n.data.inputPath || n.data.inputBindings?.length)
    )
      errors.push(`${n.data.label}: Input nodes cannot map upstream values`);
    if (n.data.inputBindings?.length) {
      if (n.data.inputFrom || n.data.inputPath || n.data.inputArgument)
        errors.push(
          `${n.data.label}: named mappings cannot combine with whole-input or single tool-argument mapping`,
        );
      if (
        new Set(n.data.inputBindings.map((b) => b.target)).size !==
        n.data.inputBindings.length
      )
        errors.push(`${n.data.label}: mapped target fields must be unique`);
      for (const binding of n.data.inputBindings)
        if (
          !nodes.has(binding.source) ||
          binding.source === n.id ||
          !reach(n.id, incoming).has(binding.source)
        )
          errors.push(
            `${n.data.label}: mapped fields must reference ancestors`,
          );
    }
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
              "human-task",
              "switch",
              "set-variable",
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

export function validWorkflowValue(type: string, value: unknown) {
  return type === "json"
    ? value !== undefined
    : type === "text"
      ? typeof value === "string"
      : type === "number"
        ? typeof value === "number" && Number.isFinite(value)
        : typeof value === "boolean";
}
export function normalizeWorkflowInput(
  graph: WorkflowGraph,
  input: unknown,
): string {
  const fields = graph.inputFields ?? [];
  if (!fields.length) {
    if (
      graph.programV2 &&
      input &&
      typeof input === "object" &&
      !Array.isArray(input)
    ) {
      const serialized = JSON.stringify(input);
      if (serialized.length > 12000)
        throw new Error("Workflow input exceeds 12000 characters");
      return serialized;
    }
    if (typeof input !== "string" || !input.trim() || input.length > 12000)
      throw new Error(
        "Provide text input (1–12000 characters) for this workflow",
      );
    return input.trim();
  }
  let values = input;
  if (typeof input === "string") {
    try {
      values = JSON.parse(input);
    } catch {
      throw new Error("Provide an object matching the workflow input fields");
    }
  }
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw new Error("Workflow input must be an object");
  const record = values as Record<string, unknown>;
  if (Object.keys(record).some((k) => !fields.some((f) => f.name === k)))
    throw new Error("Unknown workflow input field");
  const result: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const value = Object.hasOwn(record, field.name)
      ? record[field.name]
      : field.defaultValue;
    if (value === undefined) {
      if (field.required) throw new Error(`${field.label} is required`);
      continue;
    }
    if (
      !validWorkflowValue(field.type, value) ||
      (field.required && field.type === "text" && !(value as string).trim())
    )
      throw new Error(`${field.label}: enter a valid ${field.type} value`);
    result[field.name] = value;
  }
  const serialized = JSON.stringify(result);
  if (serialized.length > 12000)
    throw new Error("Workflow input exceeds 12000 characters");
  return serialized;
}
