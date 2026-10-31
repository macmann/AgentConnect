import { z } from "zod";
import { validateV2Mappings } from "@agentconnect/schemas/workflow-v2-validation";
import {
  workflowGraph,
  workflowInputField,
  analyzeWorkflow,
  type WorkflowGraph,
} from "@agentconnect/schemas/workflows";
import { pointerSegments } from "@agentconnect/schemas/workflow-mapping";
import { workflowAncestors } from "@agentconnect/schemas/workflow-mapping";
import {
  workflowAction,
  actionRetry,
  actionInputs,
  actionJsonSchema,
} from "@agentconnect/schemas/workflow-actions";
import {
  workflowIdentifier,
  workflowExpression,
  workflowCondition,
  workflowJson,
  referenceSegments,
  type WorkflowExpression,
} from "@agentconnect/schemas/workflow-values";

export const workflowResource = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("agent"),
    agentId: z.uuid(),
    versionId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal("workflow"),
    workflowId: z.uuid(),
    versionId: z.uuid().optional(),
    versionBehavior: z.enum(["pinned", "latest-published"]).default("pinned"),
  }),
  z.strictObject({ kind: z.literal("knowledge"), id: z.uuid() }),
  z.strictObject({ kind: z.literal("tool"), id: z.uuid() }),
  z.strictObject({ kind: z.literal("mcp"), id: z.uuid() }),
  z.strictObject({ kind: z.literal("model"), id: z.uuid() }),
  z.strictObject({ kind: z.literal("secret"), id: z.uuid() }),
  z.strictObject({ kind: z.literal("connection"), id: z.uuid() }),
]);
const binding = { input: workflowExpression.optional() };
const common = {
  id: workflowIdentifier,
  onError: workflowIdentifier.optional(),
  label: z.string().trim().min(1).max(100),
};
export const workflowV2Node = z.discriminatedUnion("kind", [
  z.strictObject({
    ...common,
    kind: z.literal("input"),
    config: z.strictObject({}),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("agent"),
    config: z.strictObject({
      ...binding,
      resource: workflowIdentifier,
      prefix: z.string().max(2000).default(""),
      suffix: z.string().max(2000).default(""),
      retry: actionRetry,
    }),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("action"),
    config: z.strictObject({
      ...binding,
      actionId: workflowIdentifier,
      inputs: actionInputs.default({}),
    }),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("structured-ai"),
    config: z.strictObject({
      ...binding,
      resource: workflowIdentifier,
      instruction: z.string().trim().min(1).max(8000),
      outputSchema: actionJsonSchema,
    }),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("human-task"),
    config: z.strictObject({
      ...binding,
      mode: z.enum(["approve-reject", "review-edit"]),
      prompt: z.string().min(1).max(2000),
      outputSchema: actionJsonSchema,
      approveLabel: z.string().trim().min(1).max(40).default("Approve"),
      rejectLabel: z.string().trim().min(1).max(40).default("Reject"),
    }),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("transform"),
    config: z.strictObject({ fields: actionInputs }),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("set-variable"),
    config: z.strictObject({
      name: workflowIdentifier,
      value: workflowExpression,
    }),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("switch"),
    config: z.strictObject({
      ...binding,
      value: workflowExpression,
      cases: z
        .array(
          z.strictObject({
            id: workflowIdentifier.refine(
              (v) => v !== "default",
              "Reserved route name",
            ),
            label: z.string().min(1).max(80),
            value: workflowJson,
          }),
        )
        .min(1)
        .max(10),
    }),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("for-each"),
    config: z.strictObject({
      resource: workflowIdentifier,
      collection: workflowExpression.refine(
        (v) => v.type === "reference",
        "Select a typed array reference",
      ),
      itemInputs: actionInputs.default({}),
      startIndex: z.number().int().min(0).max(99).default(0),
      maxItems: z.number().int().min(1).max(100).default(25),
      failurePolicy: z
        .enum(["fail-workflow", "continue"])
        .default("fail-workflow"),
    }),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("subworkflow"),
    config: z.strictObject({
      ...binding,
      resource: workflowIdentifier,
      outputPath: z.string().max(512).default(""),
    }),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("wait"),
    config: z.strictObject({
      ...binding,
      mode: z.enum(["duration", "until"]),
      seconds: z.number().int().min(1).max(2592000).default(60),
      until: workflowExpression.optional(),
    }),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("wait-for-event"),
    config: z.strictObject({
      ...binding,
      eventName: z.string().trim().min(1).max(100),
      timeoutSeconds: z.number().int().min(1).max(2592000).default(86400),
      outputSchema: actionJsonSchema.default({}),
    }),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("condition"),
    config: z.strictObject({ ...binding, condition: workflowCondition }),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("parallel"),
    config: z.strictObject({ ...binding }),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("merge"),
    config: z.strictObject({ ...binding }),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("approval"),
    config: z.strictObject({
      ...binding,
      prompt: z
        .string()
        .max(2000)
        .default("Review this result before continuing."),
    }),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("output"),
    config: z.strictObject({
      ...binding,
      title: z.string().max(120).default(""),
      summary: z.string().max(400).default(""),
      format: z.enum(["auto", "text", "json"]).default("auto"),
    }),
  }),
]);
const coordinate = z.strictObject({
  x: z.number().min(-10000).max(10000),
  y: z.number().min(-10000).max(10000),
});
export const workflowDefinitionV2 = z.strictObject({
  schemaVersion: z.literal(2),
  execution: z.strictObject({
    inputFields: z.array(workflowInputField).max(30).default([]),
    variables: z.record(workflowIdentifier, workflowJson).default({}),
    resources: z.record(workflowIdentifier, workflowResource).default({}),
    actions: z.array(workflowAction).max(40).default([]),
    nodes: z.array(workflowV2Node).min(1).max(40),
    edges: z
      .array(
        z.strictObject({
          id: workflowIdentifier,
          source: workflowIdentifier,
          target: workflowIdentifier,
          branch: workflowIdentifier.optional(),
        }),
      )
      .max(80),
  }),
  editor: z
    .strictObject({
      nodes: z.record(workflowIdentifier, coordinate).default({}),
      edges: z
        .record(
          workflowIdentifier,
          z.strictObject({
            sourcePort: z
              .enum(["out-top", "out-bottom", "out-left"])
              .optional(),
            targetPort: z.enum(["in-top", "in-bottom", "in-right"]).optional(),
          }),
        )
        .default({}),
      viewport: z
        .strictObject({
          x: z.number().finite(),
          y: z.number().finite(),
          zoom: z.number().min(0.15).max(2),
        })
        .optional(),
    })
    .optional(),
});
export type WorkflowDefinitionV2 = z.infer<typeof workflowDefinitionV2>;
export const workflowDefinition = z.union([
  workflowDefinitionV2,
  workflowGraph.omit({ programV2: true }),
]);
export type WorkflowDefinition = z.infer<typeof workflowDefinition>;
export class WorkflowCompileError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join("; "));
  }
}
// This is a runtime adapter, deliberately not a second scheduler or execution engine.
export function compileWorkflowDefinition(
  value: unknown,
  options: { validate?: boolean } = {},
): WorkflowGraph {
  const definition = workflowDefinition.parse(value);
  if (definition.schemaVersion === 1) return definition;
  const { execution: e, editor } = definition;
  const errors: string[] = [];
  const actions = new Map(e.actions.map((a) => [a.id, a]));
  if (actions.size !== e.actions.length)
    errors.push("Action IDs must be unique");
  for (const a of e.actions) {
    if (a.sideEffect !== "read")
      errors.push(`${a.id}: only read actions have a registered executor`);
    if (a.idempotency === "key")
      errors.push(`${a.id}: this executor does not support idempotency keys`);
    if (a.requiredScopes.length)
      errors.push(
        `${a.id}: this executor cannot verify additional OAuth scopes`,
      );
  }
  const nodes = e.nodes.map((n, i) => {
    const resource =
      "resource" in n.config ? e.resources[n.config.resource] : undefined;
    if (n.kind === "structured-ai" && resource?.kind !== "model")
      errors.push(`${n.id}: select an existing model resource`);
    if (n.kind === "agent" && resource?.kind !== "agent")
      errors.push(`${n.id}: select a published agent resource`);
    const action =
      n.kind === "action" ? actions.get(n.config.actionId) : undefined;
    if (n.kind === "action" && !action)
      errors.push(`${n.id}: action unavailable`);
    return {
      id: n.id,
      type: n.kind === "action" ? "tool" : n.kind,
      // Layout only projects into the legacy adapter. It is never consulted by validation or execution.
      position: editor?.nodes[n.id] ?? { x: i * 250, y: 80 },
      data: {
        label: n.label,
        ...(n.kind === "agent"
          ? {
              agentVersionId:
                resource?.kind === "agent" ? resource.versionId : undefined,
              prefix: n.config.prefix,
              suffix: n.config.suffix,
              retry: n.config.retry,
            }
          : {}),
        ...(action ? { toolId: action.toolId, retry: action.retry } : {}),
        ...(n.kind === "approval" ? { approvalPrompt: n.config.prompt } : {}),
        ...(n.kind === "output"
          ? {
              resultTitle: n.config.title,
              resultSummary: n.config.summary,
              resultFormat: n.config.format,
            }
          : {}),
      },
    };
  });
  const graph = workflowGraph.parse({
    schemaVersion: 1,
    inputFields: e.inputFields,
    nodes,
    programV2: { compilerVersion: 1, execution: JSON.parse(JSON.stringify(e)) },
    edges: [
      ...e.edges,
      ...e.nodes
        .filter((n) => n.onError)
        .map((n) => ({
          id: "error_" + n.id,
          source: n.id,
          target: n.onError!,
          branch: "error",
        })),
    ].map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.branch,
      ...editor?.edges[edge.id],
    })),
  });
  errors.push(...analyzeWorkflow(graph).errors);
  for (const node of e.nodes) {
    if (
      node.onError &&
      (!e.nodes.some((n) => n.id === node.onError) ||
        [
          "input",
          "output",
          "parallel",
          "merge",
          "condition",
          "switch",
          "human-task",
          "approval",
        ].includes(node.kind))
    )
      errors.push(
        `${node.id}: choose an existing error handler on a supported operation`,
      );
    if (node.kind === "for-each" || node.kind === "subworkflow") {
      const resource = e.resources[node.config.resource];
      if (
        resource?.kind !== "workflow" ||
        (resource.versionBehavior === "pinned" && !resource.versionId)
      )
        errors.push(`${node.id}: select a published workflow and version`);
    }
    if (
      node.kind === "wait" &&
      node.config.mode === "until" &&
      !node.config.until
    )
      errors.push(`${node.id}: choose a wait-until timestamp`);
    if (node.kind === "subworkflow") {
      try {
        pointerSegments(node.config.outputPath);
      } catch {
        errors.push(`${node.id}: select a valid result field`);
      }
    }
  }
  const nodeIds = new Set(e.nodes.map((n) => n.id)),
    edgeIds = new Set(graph.edges.map((edge) => edge.id));
  if (
    Object.keys(editor?.nodes ?? {}).some((id) => !nodeIds.has(id)) ||
    Object.keys(editor?.edges ?? {}).some((id) => !edgeIds.has(id))
  )
    errors.push("Editor layout references an unknown node or edge");
  const expressions = (
    node: (typeof e.nodes)[number],
  ): WorkflowExpression[] => [
    ...("input" in node.config && node.config.input ? [node.config.input] : []),
    ...(node.kind === "condition"
      ? [
          node.config.condition.left,
          ...(node.config.condition.right ? [node.config.condition.right] : []),
        ]
      : []),
    ...("inputs" in node.config ? Object.values(node.config.inputs) : []),
    ...(node.kind === "transform" ? Object.values(node.config.fields) : []),
    ...(node.kind === "for-each"
      ? [node.config.collection, ...Object.values(node.config.itemInputs)]
      : []),
    ...(node.kind === "wait" && node.config.until ? [node.config.until] : []),
    ...(node.kind === "set-variable" || node.kind === "switch"
      ? [node.config.value]
      : []),
    ...(node.kind === "action"
      ? Object.values(actions.get(node.config.actionId)?.mappedInputs ?? {})
      : []),
  ];
  for (const node of e.nodes) {
    if (
      node.kind === "set-variable" &&
      !Object.hasOwn(e.variables, node.config.name)
    )
      errors.push(`${node.id}: declare the variable before assigning it`);
    if (node.kind === "switch") {
      const routes = [...node.config.cases.map((c) => c.id), "default"];
      const outgoing = e.edges.filter((edge) => edge.source === node.id);
      if (
        new Set(routes).size !== routes.length ||
        outgoing.length !== routes.length ||
        routes.some(
          (route) =>
            outgoing.filter((edge) => edge.branch === route).length !== 1,
        )
      )
        errors.push(
          `${node.id}: connect each unique case and default exactly once`,
        );
      if (
        new Set(node.config.cases.map((c) => JSON.stringify(c.value))).size !==
        node.config.cases.length
      )
        errors.push(`${node.id}: case values must be unique`);
    }
    const ancestors = workflowAncestors(graph, node.id);
    for (const expression of expressions(node)) {
      if (expression.type !== "reference") continue;
      const parts = referenceSegments(expression.path);
      if (
        parts[0] === "steps" &&
        (parts.length < 3 ||
          (parts[2] !== "output" &&
            !(
              parts[2] === "summary" &&
              e.nodes.find((n) => n.id === parts[1])?.kind === "for-each"
            )) ||
          !ancestors.has(parts[1]!))
      )
        errors.push(
          `${node.id}: step references must select an ancestor output`,
        );
      if (
        parts[0] === "variables" &&
        parts.length > 1 &&
        !Object.hasOwn(e.variables, parts[1]!)
      )
        errors.push(`${node.id}: unknown workflow variable`);
      if (
        parts[0] === "workflow" &&
        (parts.length !== 2 ||
          !["id", "versionId", "runId", "schemaVersion"].includes(parts[1]!))
      )
        errors.push(`${node.id}: unknown workflow metadata field`);
      if (node.kind === "input" && parts[0] === "steps")
        errors.push(`${node.id}: input cannot reference steps`);
    }
  }
  errors.push(...validateV2Mappings(e));
  if (errors.length && options.validate !== false)
    throw new WorkflowCompileError([...new Set(errors)]);
  // Persist the validated execution program without editor layout or resource configurations.
  graph.programV2 = {
    compilerVersion: 1,
    execution: JSON.parse(JSON.stringify(e)),
  };
  return graph;
}
export function validateWorkflowDefinition(value: unknown): string[] {
  try {
    compileWorkflowDefinition(value);
    return [];
  } catch (error) {
    return error instanceof WorkflowCompileError
      ? error.errors
      : error instanceof z.ZodError
        ? error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
        : ["Invalid workflow definition"];
  }
}

// AI chain proposals already use published versions. Conversion is opt-in and rejects inline assets.
export function agentChainDefinitionV2(
  graph: WorkflowGraph,
  agentIds: Record<string, string>,
): WorkflowDefinitionV2 {
  const resources: WorkflowDefinitionV2["execution"]["resources"] = {};
  const nodes = graph.nodes.map((n) => {
    const common = { id: n.id, label: n.data.label };
    if (n.type === "input") return { ...common, kind: "input", config: {} };
    if (n.type === "output")
      return {
        ...common,
        kind: "output",
        config: {
          title: n.data.resultTitle,
          summary: n.data.resultSummary,
          format: n.data.resultFormat,
        },
      };
    if (
      n.type !== "agent" ||
      n.data.inlineAgent ||
      !n.data.agentVersionId ||
      !agentIds[n.data.agentVersionId]
    )
      throw new WorkflowCompileError([
        "Only published-agent chain proposals can be converted automatically",
      ]);
    const resource = "agent_" + n.id;
    resources[resource] = {
      kind: "agent",
      agentId: agentIds[n.data.agentVersionId]!,
      versionId: n.data.agentVersionId,
    };
    return {
      ...common,
      kind: "agent",
      config: {
        resource,
        prefix: n.data.prefix,
        suffix: n.data.suffix,
        retry: n.data.retry,
      },
    };
  });
  const definition = workflowDefinitionV2.parse({
    schemaVersion: 2,
    execution: {
      resources,
      nodes,
      edges: graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
      })),
    },
    editor: {
      nodes: Object.fromEntries(graph.nodes.map((n) => [n.id, n.position])),
    },
  });
  compileWorkflowDefinition(definition);
  return definition;
}
