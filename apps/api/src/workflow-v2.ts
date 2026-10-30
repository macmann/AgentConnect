import { z } from "zod";
import {
  workflowGraph,
  type WorkflowGraph,
} from "@agentconnect/schemas/workflows";
import {
  compileWorkflowDefinition,
  workflowDefinition,
  workflowDefinitionV2,
  WorkflowCompileError,
  type WorkflowDefinitionV2,
} from "@agentconnect/schemas/workflow-v2";
import {
  actionJsonSchema,
  type WorkflowAction,
} from "@agentconnect/schemas/workflow-actions";
import { Ajv } from "ajv";
import { sql } from "./db.js";
import { HttpError, workspaceAccess } from "./app.js";
import {
  validateToolIds,
  connectorFor,
  executeTool,
  ToolError,
  toolSecret,
  type ToolContext,
} from "./tool-runtime.js";

export function storedWorkflowGraph(value: unknown): WorkflowGraph {
  // Already compiled run snapshots must retain their validated program and trigger envelope.
  const compiled = workflowGraph.safeParse(value);
  if (
    value &&
    typeof value === "object" &&
    Object.hasOwn(value, "programV2") &&
    !compiled.success
  )
    throw compiled.error;
  if (compiled.success && compiled.data.programV2) {
    const graph = compileWorkflowDefinition({
      schemaVersion: 2,
      execution: compiled.data.programV2.execution,
    });
    graph.programV2!.trigger = compiled.data.programV2.trigger;
    return graph;
  }
  try {
    return compileWorkflowDefinition(value);
  } catch (error) {
    if (error instanceof WorkflowCompileError)
      throw new HttpError(400, error.message);
    throw error;
  }
}
export function workflowV2Program(
  graph: WorkflowGraph,
): WorkflowDefinitionV2["execution"] | undefined {
  return graph.programV2
    ? workflowDefinitionV2.parse({
        schemaVersion: 2,
        execution: graph.programV2.execution,
      }).execution
    : undefined;
}
export function definitionInput(value: unknown) {
  const definition = workflowDefinition.parse(value);
  // Prevent clients from injecting internal compiled programs in a V1 payload.
  return definition;
}
export async function validateV2Resources(
  graph: WorkflowGraph,
  ctx: ToolContext,
) {
  const program = workflowV2Program(graph);
  if (!program) return;
  for (const [resourceName, resource] of Object.entries(program.resources)) {
    let found = false;
    switch (resource.kind) {
      case "agent": {
        const rows =
          await sql`SELECT v.id FROM agent_versions v JOIN agents a ON a.id=v.agent_id WHERE v.id=${resource.versionId} AND v.agent_id=${resource.agentId} AND v.workspace_id=${ctx.workspaceId} AND v.organization_id=${ctx.organizationId} AND a.archived_at IS NULL`;
        found = !!rows.length;
        break;
      }
      case "tool":
        await validateToolIds([resource.id], ctx);
        found = true;
        break;
      case "mcp":
        await connectorFor(resource.id, ctx);
        found = true;
        break;
      case "knowledge": {
        const rows =
          await sql`SELECT id,public_access FROM knowledge_bases WHERE id=${resource.id} AND workspace_id=${ctx.workspaceId} AND organization_id=${ctx.organizationId} AND archived_at IS NULL`;
        found =
          !!rows.length && (!ctx.publicAccess || !!rows[0]!.public_access);
        break;
      }
      case "model":
        found = !!(
          await sql`SELECT id FROM model_configurations WHERE id=${resource.id} AND workspace_id=${ctx.workspaceId} AND organization_id=${ctx.organizationId} AND archived_at IS NULL`
        ).length;
        break;
      case "secret":
        found = !!(
          await sql`SELECT id FROM secrets WHERE id=${resource.id} AND workspace_id=${ctx.workspaceId} AND organization_id=${ctx.organizationId}`
        ).length;
        break;
      case "connection":
        found = !!(
          await sql`SELECT id FROM enterprise_connectors WHERE id=${resource.id} AND workspace_id=${ctx.workspaceId} AND organization_id=${ctx.organizationId} AND enabled=true AND archived_at IS NULL`
        ).length;
        break;
    }
    if (!found)
      throw new HttpError(
        400,
        `Resource ${resourceName} (${resource.kind}) is unavailable in this workspace`,
      );
    if (
      ctx.publicAccess &&
      ["secret", "connection", "model", "mcp"].includes(resource.kind)
    )
      throw new HttpError(
        400,
        "This resource reference is not available in public workflows",
      );
  }
  for (const node of program.nodes) {
    if (node.kind === "structured-ai" || node.kind === "human-task")
      schemaValidator(node.config.outputSchema);
  }
  for (const action of program.actions) {
    try {
      await validateWorkflowAction(action, ctx);
    } catch (error) {
      const node = program.nodes.find(
        (n) => n.kind === "action" && n.config.actionId === action.id,
      );
      throw new HttpError(
        400,
        `${node?.id ?? action.id}: check the registered Action and its saved connection (${error instanceof ToolError ? error.code : "ACTION_UNAVAILABLE"})`,
      );
    }
  }
}
export function schemaValidator(schema: Record<string, unknown>) {
  actionJsonSchema.parse(schema);
  let count = 0;
  const walk = (v: unknown, depth: number): void => {
    if (++count > 500 || depth > 12)
      throw new ToolError("ACTION_SCHEMA_UNSUPPORTED");
    if (v && typeof v === "object")
      for (const [key, value] of Object.entries(v)) {
        if (
          [
            "$ref",
            "$dynamicRef",
            "pattern",
            "patternProperties",
            "$id",
          ].includes(key)
        )
          throw new ToolError("ACTION_SCHEMA_UNSUPPORTED");
        if (key === "format" && typeof value === "string" && value !== "date")
          throw new ToolError("ACTION_SCHEMA_UNSUPPORTED");
        walk(value, depth + 1);
      }
  };
  walk(schema, 0);
  try {
    return new Ajv({ strict: false, validateFormats: true })
      .addFormat("date", {
        type: "string",
        validate: (v: string) =>
          /^\d{4}-\d{2}-\d{2}$/.test(v) &&
          !Number.isNaN(Date.parse(v)) &&
          new Date(v).toISOString().slice(0, 10) === v,
      })
      .compile(schema);
  } catch {
    throw new ToolError("ACTION_SCHEMA_UNSUPPORTED");
  }
}
export async function validateWorkflowAction(
  action: WorkflowAction,
  ctx: ToolContext,
) {
  const [tool] = await validateToolIds([action.toolId], ctx);
  if (!tool) throw new ToolError("TOOL_UNAVAILABLE");
  if (
    action.sideEffect !== "read" ||
    action.idempotency === "key" ||
    action.requiredScopes.length
  )
    throw new ToolError("ACTION_EXECUTOR_UNSUPPORTED");
  if (action.connector === "agentconnect.mcp" && tool.config.kind !== "mcp")
    throw new ToolError("ACTION_CONNECTOR_MISMATCH");
  if (action.connector === "agentconnect.tool" && tool.config.kind === "mcp")
    throw new ToolError("ACTION_CONNECTOR_MISMATCH");
  if (tool.config.kind === "mcp") {
    const connector = await connectorFor(tool.config.connectorId, ctx);
    if (connector.secret_id) await toolSecret(connector.secret_id, ctx);
  } else if ("secretId" in tool.config && tool.config.secretId)
    await toolSecret(tool.config.secretId, ctx);
  if (action.connectionId) {
    const actual =
      tool.config.kind === "mcp"
        ? tool.config.connectorId
        : "secretId" in tool.config
          ? tool.config.secretId
          : undefined;
    if (actual !== action.connectionId)
      throw new ToolError("ACTION_CONNECTION_MISMATCH");
  }
  schemaValidator(action.inputSchema);
  schemaValidator(action.outputSchema);
  for (const permission of action.requiredPermissions) {
    if (!ctx.userId) throw new ToolError("ACTION_PERMISSION_REQUIRED");
    await workspaceAccess(ctx.userId, ctx.workspaceId, permission);
  }
}
export async function executeWorkflowAction(
  action: WorkflowAction,
  args: Record<string, unknown>,
  ctx: ToolContext,
  signal: AbortSignal,
) {
  await validateWorkflowAction(action, ctx);
  if (!schemaValidator(action.inputSchema)(args))
    throw new ToolError("ACTION_INPUT_INVALID");
  const timeout = AbortSignal.timeout(action.timeoutMs),
    combined = AbortSignal.any([signal, timeout]);
  try {
    const result = await executeTool(action.toolId, args, ctx, combined);
    if (!schemaValidator(action.outputSchema)(result.result))
      throw new ToolError("ACTION_OUTPUT_INVALID");
    return result.result;
  } catch (error) {
    if (timeout.aborted && !signal.aborted)
      throw new ToolError("ACTION_TIMEOUT", true);
    throw error;
  }
}
export const v2DefinitionRequest = z.strictObject({
  definition: workflowDefinitionV2,
});

export async function executeStructuredAI(
  modelId: string,
  instruction: string,
  input: unknown,
  outputSchema: Record<string, unknown>,
  ctx: ToolContext,
  signal: AbortSignal,
  factory?: import("@agentconnect/provider-sdk").ProviderFactory,
) {
  const { modelSnapshot } = await import("./agents.js");
  const { connection } = await import("./agent-models.js");
  const { defaultProcessingFactory } =
    await import("./knowledge-processing.js");
  const { tracedProvider } = await import("./ai-tracing.js");
  const { tokenCount } = await import("./context-control.js");
  const model = await modelSnapshot(modelId, ctx.workspaceId);
  const validate = schemaValidator(outputSchema);
  const system =
    instruction +
    "\nReturn only valid JSON matching this schema: " +
    JSON.stringify(outputSchema);
  const content = typeof input === "string" ? input : JSON.stringify(input);
  const maxOutputTokens = Math.min(8192, model.maxOutputTokens);
  if (
    tokenCount(system + content, "o200k_base") + maxOutputTokens + 512 >
    model.contextWindow
  )
    throw new ToolError("STRUCTURED_AI_CONTEXT_LIMIT");
  const provider = tracedProvider(
    (factory ?? defaultProcessingFactory)(
      await connection(model, ctx.workspaceId, ctx.organizationId),
    ),
    model,
  );
  let text = "",
    inputTokens: number | null = null,
    outputTokens: number | null = null;
  for await (const event of provider.stream({
    system,
    messages: [{ role: "user", content }],
    temperature: 0,
    topP: null,
    maxOutputTokens,
    responseSchema: { name: "workflow_output", schema: outputSchema },
    signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
  })) {
    if (event.type === "token") {
      text += event.text;
      if (text.length > 128000)
        throw new ToolError("STRUCTURED_AI_OUTPUT_LIMIT");
    }
    if (event.type === "usage") {
      inputTokens = event.inputTokens;
      outputTokens = event.outputTokens;
    }
  }
  let output: unknown;
  try {
    output = JSON.parse(text);
  } catch {
    throw new ToolError("STRUCTURED_AI_OUTPUT_INVALID");
  }
  const { assertWorkflowValue } =
    await import("@agentconnect/schemas/workflow-values");
  assertWorkflowValue(output);
  if (!validate(output)) throw new ToolError("STRUCTURED_AI_OUTPUT_INVALID");
  return { output, inputTokens, outputTokens };
}
