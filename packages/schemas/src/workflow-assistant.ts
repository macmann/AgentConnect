import { z } from "zod";
import {
  workflowDefinitionV2,
  workflowV2Node,
  workflowResource,
  compileWorkflowDefinition,
  type WorkflowDefinitionV2,
} from "@agentconnect/schemas/workflow-v2";
import { workflowAction } from "@agentconnect/schemas/workflow-actions";
import {
  workflowIdentifier,
  workflowExpression,
  workflowCondition,
  workflowJson,
} from "@agentconnect/schemas/workflow-values";
import { workflowInputField } from "@agentconnect/schemas/workflows";
const edge = workflowDefinitionV2.shape.execution.shape.edges.element;
export const workflowMutation = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("addNode"),
    node: workflowV2Node,
    nearNodeId: workflowIdentifier.optional(),
  }),
  z.strictObject({ op: z.literal("removeNode"), nodeId: workflowIdentifier }),
  z.strictObject({
    op: z.literal("updateNode"),
    nodeId: workflowIdentifier,
    node: workflowV2Node,
  }),
  z.strictObject({ op: z.literal("connect"), edge }),
  z.strictObject({ op: z.literal("disconnect"), edgeId: workflowIdentifier }),
  z.strictObject({
    op: z.literal("updateMapping"),
    nodeId: workflowIdentifier,
    target: z.enum(["input", "inputs", "fields", "itemInputs"]),
    field: workflowIdentifier.optional(),
    value: workflowExpression,
  }),
  z.strictObject({
    op: z.literal("updateCondition"),
    nodeId: workflowIdentifier,
    condition: workflowCondition,
  }),
  z.strictObject({ op: z.literal("upsertAction"), action: workflowAction }),
  z.strictObject({
    op: z.literal("removeAction"),
    actionId: workflowIdentifier,
  }),
  z.strictObject({
    op: z.literal("upsertResource"),
    name: workflowIdentifier,
    resource: workflowResource,
  }),
  z.strictObject({ op: z.literal("removeResource"), name: workflowIdentifier }),
  z.strictObject({
    op: z.literal("setVariable"),
    name: workflowIdentifier,
    value: workflowJson,
  }),
  z.strictObject({
    op: z.literal("setInputFields"),
    fields: z.array(workflowInputField).max(30),
  }),
]);
export const workflowAssistantRequest = z.strictObject({
  mode: z.enum(["create", "modify", "configure", "explain"]),
  prompt: z.string().trim().min(1).max(4000),
  definition: workflowDefinitionV2,
  workflowId: z.uuid().optional(),
  selectedNodeId: workflowIdentifier.optional(),
});
export const workflowAssistantReply = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("definition"),
    message: z.string().min(1).max(4000),
    definition: workflowDefinitionV2,
  }),
  z.strictObject({
    kind: z.literal("mutations"),
    message: z.string().min(1).max(4000),
    operations: z.array(workflowMutation).min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal("explanation"),
    message: z.string().min(1).max(12000),
  }),
  z.strictObject({
    kind: z.literal("clarification"),
    message: z.string().min(1).max(4000),
  }),
]);
export type WorkflowAssistantRequest = z.infer<typeof workflowAssistantRequest>;
export type WorkflowAssistantReply = z.infer<typeof workflowAssistantReply>;
export type WorkflowMutation = z.infer<typeof workflowMutation>;
export function applyWorkflowMutations(
  current: WorkflowDefinitionV2,
  operations: WorkflowMutation[],
  selectedNodeId?: string,
): WorkflowDefinitionV2 {
  const next = structuredClone(workflowDefinitionV2.parse(current)),
    e = next.execution;
  const find = (id: string) => {
    const n = e.nodes.find((n) => n.id === id);
    if (!n) throw new Error("Mutation references an unavailable node");
    return n;
  };
  for (const operation of operations) {
    const o = workflowMutation.parse(operation);
    if (selectedNodeId) {
      const selected = find(selectedNodeId);
      if (o.op === "upsertAction") {
        if (
          selected.kind !== "action" ||
          selected.config.actionId !== o.action.id ||
          e.nodes.some(
            (n) =>
              n.id !== selectedNodeId &&
              n.kind === "action" &&
              n.config.actionId === o.action.id,
          )
        )
          throw new Error("Use Modify workflow to change shared Actions");
      } else if (o.op === "upsertResource") {
        if (
          !("resource" in selected.config) ||
          selected.config.resource !== o.name ||
          e.nodes.some(
            (n) =>
              n.id !== selectedNodeId &&
              "resource" in n.config &&
              n.config.resource === o.name,
          )
        )
          throw new Error(
            "Use Modify workflow to change shared resource references",
          );
      } else if (
        !["updateNode", "updateMapping", "updateCondition"].includes(o.op) ||
        !("nodeId" in o) ||
        o.nodeId !== selectedNodeId
      )
        throw new Error(
          "Configure selected node cannot edit other steps; use Modify workflow",
        );
    }
    switch (o.op) {
      case "addNode": {
        if (e.nodes.some((n) => n.id === o.node.id))
          throw new Error("Node already exists");
        const anchor = o.nearNodeId ? find(o.nearNodeId) : e.nodes.at(-1);
        const point = (anchor && next.editor?.nodes[anchor.id]) || {
          x: Math.min(
            (anchor ? e.nodes.indexOf(anchor) : e.nodes.length) * 250,
            9000,
          ),
          y: 150,
        };
        const x = Math.min(point.x + 250, 9750);
        let y = point.y;
        while (
          e.nodes
            .map(
              (node, i) =>
                next.editor?.nodes[node.id] ?? { x: i * 250, y: 150 },
            )
            .some((p) => Math.abs(p.x - x) < 180 && Math.abs(p.y - y) < 100) &&
          y < 9750
        )
          y += 140;
        next.editor ??= { nodes: {}, edges: {} };
        next.editor.nodes[o.node.id] = { x, y };
        e.nodes.push(o.node);
        break;
      }
      case "removeNode":
        find(o.nodeId);
        e.nodes = e.nodes.filter((n) => n.id !== o.nodeId);
        e.edges = e.edges.filter(
          (edge) => edge.source !== o.nodeId && edge.target !== o.nodeId,
        );
        if (next.editor) delete next.editor.nodes[o.nodeId];
        break;
      case "updateNode": {
        const before = find(o.nodeId);
        if (
          o.node.id !== before.id ||
          (selectedNodeId && o.node.kind !== before.kind)
        )
          throw new Error("Node identity must be preserved");
        e.nodes[e.nodes.indexOf(before)] = o.node;
        break;
      }
      case "connect":
        if (e.edges.some((edge) => edge.id === o.edge.id))
          throw new Error(
            "Edge already exists; disconnect it before replacing it",
          );
        e.edges.push(o.edge);
        break;
      case "disconnect":
        if (!e.edges.some((edge) => edge.id === o.edgeId))
          throw new Error("Edge unavailable");
        e.edges = e.edges.filter((edge) => edge.id !== o.edgeId);
        if (next.editor) delete next.editor.edges[o.edgeId];
        break;
      case "updateMapping": {
        const n = find(o.nodeId);
        if (o.target === "input") {
          if (
            [
              "input",
              "transform",
              "set-variable",
              "switch",
              "for-each",
            ].includes(n.kind) ||
            o.field
          )
            throw new Error(
              "This node does not support the requested input mapping",
            );
          Object.assign(n.config, { input: o.value });
        } else {
          const valid =
            (o.target === "inputs" && n.kind === "action") ||
            (o.target === "fields" && n.kind === "transform") ||
            (o.target === "itemInputs" && n.kind === "for-each");
          if (!valid || !o.field)
            throw new Error("Mapping target is incompatible with this node");
          const fields = (
            n.config as unknown as Record<string, Record<string, unknown>>
          )[o.target]!;
          fields[o.field] = o.value;
        }
        break;
      }
      case "updateCondition": {
        const n = find(o.nodeId);
        if (n.kind !== "condition") throw new Error("Condition node required");
        n.config.condition = o.condition;
        break;
      }
      case "upsertAction": {
        const index = e.actions.findIndex((a) => a.id === o.action.id);
        if (index < 0) e.actions.push(o.action);
        else e.actions[index] = o.action;
        break;
      }
      case "removeAction":
        if (!e.actions.some((a) => a.id === o.actionId))
          throw new Error("Action unavailable");
        e.actions = e.actions.filter((a) => a.id !== o.actionId);
        break;
      case "upsertResource":
        e.resources[o.name] = o.resource;
        break;
      case "removeResource":
        if (!Object.hasOwn(e.resources, o.name))
          throw new Error("Resource unavailable");
        delete e.resources[o.name];
        break;
      case "setVariable":
        e.variables[o.name] = o.value;
        break;
      case "setInputFields":
        e.inputFields = o.fields;
        break;
    }
  }
  const parsed = workflowDefinitionV2.parse(next);
  compileWorkflowDefinition(parsed);
  return parsed;
}
export function workflowChangeSummary(
  before: WorkflowDefinitionV2,
  after: WorkflowDefinitionV2,
): string[] {
  const changes: string[] = [];
  for (const n of after.execution.nodes) {
    const old = before.execution.nodes.find((x) => x.id === n.id);
    if (!old) changes.push(`Add ${n.kind}: ${n.label}`);
    else if (JSON.stringify(old) !== JSON.stringify(n))
      changes.push(`Configure ${n.label} (${n.id})`);
  }
  for (const n of before.execution.nodes)
    if (!after.execution.nodes.some((x) => x.id === n.id))
      changes.push(`Remove ${n.label} (${n.id})`);
  for (const edge of after.execution.edges)
    if (
      !before.execution.edges.some(
        (x) => JSON.stringify(x) === JSON.stringify(edge),
      )
    )
      changes.push(
        `Connect ${edge.source} → ${edge.target}${edge.branch ? ` (${edge.branch})` : ""}`,
      );
  for (const edge of before.execution.edges)
    if (
      !after.execution.edges.some(
        (x) => JSON.stringify(x) === JSON.stringify(edge),
      )
    )
      changes.push(`Disconnect ${edge.source} → ${edge.target}`);
  for (const key of [
    "actions",
    "resources",
    "variables",
    "inputFields",
  ] as const)
    if (
      JSON.stringify(before.execution[key]) !==
      JSON.stringify(after.execution[key])
    )
      changes.push(`Update ${key}`);
  return changes;
}

export function workflowMappingSummary(
  definition: WorkflowDefinitionV2,
): string[] {
  const summary: string[] = [];
  const describe = (expression: z.infer<typeof workflowExpression>) => {
    if (expression.type === "literal")
      return expression.value !== null && typeof expression.value === "object"
        ? "Fixed structured value"
        : `Fixed value: ${String(expression.value).slice(0, 160)}`;
    const path = expression.path;
    if (path.startsWith("steps.")) {
      const match = /^steps\.([^.]+)\.output(?:\.(.*))?$/.exec(path);
      if (match)
        return `${definition.execution.nodes.find((n) => n.id === match[1])?.label ?? match[1]} → ${match[2] ?? "entire output"}`;
    }
    return path
      .replace(/^trigger\.body\.?/, "Trigger → ")
      .replace(/^input\.?/, "Workflow input → ")
      .replace(/^variables\.?/, "Workflow variables → ")
      .replace(/\./g, " → ");
  };
  for (const node of definition.execution.nodes) {
    if ("input" in node.config && node.config.input)
      summary.push(`${node.label} · input ← ${describe(node.config.input)}`);
    const fields =
      node.kind === "action"
        ? {
            ...definition.execution.actions.find(
              (a) => a.id === node.config.actionId,
            )?.mappedInputs,
            ...node.config.inputs,
          }
        : node.kind === "for-each"
          ? node.config.itemInputs
          : node.kind === "transform"
            ? node.config.fields
            : {};
    for (const [field, value] of Object.entries(fields))
      summary.push(`${node.label} · ${field} ← ${describe(value)}`);
    if (node.kind === "for-each")
      summary.push(
        `${node.label} · collection ← ${describe(node.config.collection)}`,
      );
  }
  return summary;
}
