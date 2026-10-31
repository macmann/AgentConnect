import { HttpError } from "./http-error.js";
import { executeWorkflowNodeAction } from "./workflow-action-runtime.js";
import {
  suspensionFor,
  wakeWorkflowSuspensions,
  WorkflowControlError,
} from "./workflow-control.js";
import { selectWorkflowField } from "@agentconnect/schemas/workflow-mapping";
import {
  storedWorkflowGraph,
  workflowV2Program,
  validateV2Resources,
  executeStructuredAI,
  schemaValidator,
} from "./workflow-v2.js";
import {
  resolveWorkflowExpression,
  evaluateWorkflowCondition,
  WorkflowValueError,
  type WorkflowDataContext,
} from "@agentconnect/schemas/workflow-values";
import {
  resolveWorkflowMapping,
  workflowToolArguments,
  WorkflowMappingError,
} from "@agentconnect/schemas/workflow-mapping";
import { workspaceAccess } from "./app.js";
import { context } from "@opentelemetry/api";
import {
  observe,
  observationContent,
  observationError,
  workflowTraceContext,
} from "./ai-tracing.js";
import { workflowRetry } from "./workflow-retries.js";
import { randomUUID } from "node:crypto";
import {
  Annotation,
  StateGraph,
  START,
  END,
  Command,
  interrupt,
} from "@langchain/langgraph";
import { isGraphInterrupt } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { ProviderFactory } from "@agentconnect/provider-sdk";
import { ProviderError } from "@agentconnect/provider-sdk";
import type { EmbeddingFactory } from "@agentconnect/provider-sdk/embeddings";
import { KnowledgeError } from "@agentconnect/rag/parsers";
import {
  analyzeWorkflow,
  type WorkflowGraph,
  type WorkflowNode,
} from "@agentconnect/schemas/workflows";
import {
  executeTool,
  validateToolIds,
  ToolError,
  redact,
  type ToolContext,
} from "./tool-runtime.js";
import {
  workflowNodeAgent,
  executeWorkflowNodeAgent,
} from "./workflow-agents.js";
import { sql } from "./db.js";
import { config } from "./config.js";
export class WorkflowError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export type WorkflowRun = {
  id: string;
  workflow_id: string;
  version_id?: string | null;
  scheduled_for?: Date | string | null;
  parent_run_id?: string | null;
  webhook_id?: string | null;
  workspace_id: string;
  organization_id: string;
  user_id: string | null;
  conversation_id?: string | null;
  customer_action_id?: string | null;
  api_key_id?: string | null;
  schedule_id?: string | null;
  graph_snapshot: WorkflowGraph;
  input: string;
  status: string;
  lease_owner: string | null;
  attempts: number;
  cancel_requested: boolean;
};
let saverPromise: Promise<PostgresSaver> | undefined;
export async function workflowSaver() {
  if (!saverPromise)
    saverPromise = (async () => {
      const saver = PostgresSaver.fromConnString(config.DATABASE_URL, {
        schema: "workflow_checkpoints",
      });
      try {
        await saver.setup();
        return saver;
      } catch (e) {
        await saver.end();
        saverPromise = undefined;
        throw e;
      }
    })();
  return saverPromise;
}
export async function closeWorkflowSaver() {
  if (saverPromise) {
    const saver = await saverPromise;
    await saver.end();
    saverPromise = undefined;
  }
}
export async function validateWorkflowDependencies(
  graph: WorkflowGraph,
  ctx: ToolContext,
  runtime = false,
  tree?: { depth: number; path: Set<string>; budget: { count: number } },
) {
  if (graph.nodes.length > config.WORKFLOW_MAX_NODES)
    throw new WorkflowError("WORKFLOW_NODE_LIMIT");
  const analysis = analyzeWorkflow(graph);
  if (analysis.errors.length) throw new WorkflowError("WORKFLOW_GRAPH_INVALID");
  await validateV2Resources(graph, ctx);
  for (const n of graph.nodes) {
    if (n.type === "agent") await workflowNodeAgent(n, ctx, runtime);
    if (n.type === "tool") await validateToolIds([n.data.toolId!], ctx);
  }
  if (!runtime) {
    const traversal = tree ?? {
      depth: 0,
      path: new Set(ctx.workflowId ? [ctx.workflowId] : []),
      budget: { count: 0 },
    };
    if (++traversal.budget.count > 40)
      throw new HttpError(
        400,
        "Workflow dependency inspection exceeds 40 definitions",
      );
    const program = workflowV2Program(graph);
    for (const node of program?.nodes ?? []) {
      if (node.kind !== "for-each" && node.kind !== "subworkflow") continue;
      const resource = program!.resources[node.config.resource];
      if (resource?.kind !== "workflow") continue;
      if (
        traversal.path.has(resource.workflowId) ||
        traversal.depth + 1 >= config.WORKFLOW_MAX_DEPTH
      )
        throw new HttpError(
          400,
          `${node.id}: recursive subworkflow or nested depth limit exceeded`,
        );
      const [version] =
        await sql`SELECT v.graph FROM workflow_versions v JOIN workflows w ON w.id=v.workflow_id WHERE v.workflow_id=${resource.workflowId} AND v.workspace_id=${ctx.workspaceId} AND v.organization_id=${ctx.organizationId} AND w.archived_at IS NULL AND (${resource.versionBehavior}='latest-published' OR v.id=${resource.versionId ?? null}) ORDER BY v.version DESC LIMIT 1`;
      if (!version)
        throw new HttpError(
          400,
          `${node.id}: published child workflow unavailable`,
        );
      try {
        await validateWorkflowDependencies(
          storedWorkflowGraph(version.graph),
          { ...ctx, workflowId: resource.workflowId },
          false,
          {
            depth: traversal.depth + 1,
            path: new Set([...traversal.path, resource.workflowId]),
            budget: traversal.budget,
          },
        );
      } catch (error) {
        throw new HttpError(
          400,
          `${node.id}: child workflow unavailable or invalid (${error instanceof HttpError ? error.message : error instanceof WorkflowError ? error.code : "dependency validation failed"})`,
        );
      }
    }
  }
  return analysis;
}
const State = Annotation.Root({
  input: Annotation<string>(),
  outputs: Annotation<Record<string, unknown>>({
    reducer: (a, b) => {
      const merged = { ...a, ...b };
      if (Buffer.byteLength(JSON.stringify(merged)) > 1000000)
        throw new WorkflowError("WORKFLOW_STATE_LIMIT");
      return merged;
    },
    default: () => ({}),
  }),
  errors: Annotation<
    Record<
      string,
      { code: string; message: string; nodeId: string; attempt: number }
    >
  >({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  variables: Annotation<Record<string, unknown>>({
    reducer: (a, b) => {
      const merged = { ...a, ...b };
      if (Buffer.byteLength(JSON.stringify(merged)) > 1000000)
        throw new WorkflowError("WORKFLOW_STATE_LIMIT");
      return merged;
    },
    default: () => ({}),
  }),
  decisions: Annotation<Record<string, boolean | string>>({
    reducer: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),
});
type GraphState = typeof State.State;
type GraphUpdate = typeof State.Update;
const stringify = (v: unknown) =>
  typeof v === "string" ? v : JSON.stringify(v);
function nodeInput(
  node: WorkflowNode,
  graph: WorkflowGraph,
  state: GraphState,
) {
  if (node.type === "input")
    return graph.inputFields.length ? JSON.parse(state.input) : state.input;
  return resolveWorkflowMapping(node, graph, state.outputs);
}
export async function compileWorkflow(
  run: WorkflowRun,
  signal: AbortSignal,
  overrides: {
    providerFactory?: ProviderFactory;
    embeddingFactory?: EmbeddingFactory;
  } = {},
) {
  const graph = storedWorkflowGraph(run.graph_snapshot),
    analysis = analyzeWorkflow(graph);
  if (analysis.errors.length) throw new WorkflowError("WORKFLOW_GRAPH_INVALID");
  const ctx: ToolContext = {
    workspaceId: run.workspace_id,
    organizationId: run.organization_id,
    userId: run.user_id ?? undefined,
    workflowRunId: run.id,
    workflowId: run.workflow_id,
    publicAccess: !!run.customer_action_id,
  };
  const program = workflowV2Program(graph);
  if (program) await validateV2Resources(graph, ctx);
  const dataContext = (
    state: GraphState,
    nodeId: string,
  ): WorkflowDataContext => {
    let currentError: unknown = {
      code: null,
      message: null,
      nodeId: null,
      attempt: 0,
    };
    const pending = [nodeId],
      seen = new Set<string>();
    while (pending.length) {
      const id = pending.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (state.errors?.[id]) {
        currentError = state.errors[id];
        break;
      }
      pending.push(
        ...graph.edges
          .filter((e) => e.target === id)
          .map((e) => e.source)
          .sort(),
      );
    }
    let input: unknown = state.input;
    if (program) {
      try {
        input = JSON.parse(state.input);
      } catch {
        /* Text input remains text. */
      }
    }
    return {
      trigger: graph.programV2?.trigger ?? {
        type: run.schedule_id
          ? "schedule"
          : run.api_key_id
            ? "api"
            : run.customer_action_id
              ? "customer"
              : "manual",
        body: input,
      },
      input,
      steps: Object.fromEntries(
        Object.entries(state.outputs).map(([id, output]) => [
          id,
          {
            output,
            ...(program?.nodes.find((n) => n.id === id)?.kind === "for-each" &&
            Array.isArray(output)
              ? {
                  summary: {
                    total: output.length,
                    failed: output.filter((v) => v?.status === "failed").length,
                    completed: output.filter((v) => v?.status === "completed")
                      .length,
                  },
                }
              : {}),
          },
        ]),
      ),
      variables: { ...program?.variables, ...state.variables },
      workflow: {
        id: run.workflow_id,
        versionId: run.version_id ?? null,
        runId: run.id,
        schemaVersion: program ? 2 : 1,
      },
      error: currentError,
      item: graph.programV2?.scope?.item,
      iteration: graph.programV2?.scope?.iteration,
    };
  };
  const builder = new StateGraph<
    typeof State.spec,
    GraphState,
    GraphUpdate,
    string
  >(State);
  for (const node of graph.nodes)
    builder.addNode("node_" + node.id, async (state: GraphState) =>
      observe(
        "workflow.node." + node.type,
        "chain",
        {
          "workflow.run.id": run.id,
          "workflow.node.id": node.id,
          "workflow.node.kind":
            program?.nodes.find((n) => n.id === node.id)?.kind ?? node.type,
        },
        async (span) => {
          signal.throwIfAborted();
          if (
            run.api_key_id ||
            run.schedule_id ||
            run.parent_run_id ||
            run.webhook_id
          ) {
            if (!run.user_id)
              throw new WorkflowError("WORKFLOW_ACCESS_REVOKED");
            try {
              await workspaceAccess(
                run.user_id,
                run.workspace_id,
                "workflow:execute",
              );
            } catch {
              throw new WorkflowError("WORKFLOW_ACCESS_REVOKED");
            }
            const [issuer] =
              await sql`SELECT verified_at FROM users WHERE id=${run.user_id}`;
            if (
              !issuer ||
              (config.REQUIRE_EMAIL_VERIFICATION && !issuer.verified_at)
            )
              throw new WorkflowError("WORKFLOW_ACCESS_REVOKED");
            if (run.webhook_id) {
              const active =
                await sql`SELECT id FROM workflow_webhooks WHERE id=${run.webhook_id} AND created_by=${run.user_id} AND enabled AND expires_at>now()`;
              if (!active.length)
                throw new WorkflowError("WORKFLOW_WEBHOOK_REVOKED");
            }
            if (run.api_key_id) {
              const [key] =
                await sql`SELECT id FROM workspace_api_keys WHERE id=${run.api_key_id} AND created_by=${run.user_id} AND scope='workflow:execute' AND revoked_at IS NULL AND expires_at>now()`;
              if (!key) throw new WorkflowError("WORKFLOW_KEY_REVOKED");
            }
          }
          const started = performance.now();
          await sql`INSERT INTO workflow_node_runs(run_id,node_id,workspace_id,organization_id,label,kind,status,input) VALUES (${run.id},${node.id},${run.workspace_id},${run.organization_id},${node.data.label},${program?.nodes.find((n) => n.id === node.id)?.kind ?? node.type},'running',NULL) ON CONFLICT(run_id,node_id) DO UPDATE SET status='running',input=NULL,error_code=NULL,finished_at=NULL`;
          try {
            const definitionNode = program?.nodes.find((n) => n.id === node.id);
            const context = dataContext(state, node.id);
            const expression =
              definitionNode && "input" in definitionNode.config
                ? definitionNode.config.input
                : undefined;
            const input = expression
              ? resolveWorkflowExpression(expression, context)
              : node.type === "input" && program
                ? context.input
                : nodeInput(node, graph, state);
            observationContent(span, "input", redact(input));
            if (Buffer.byteLength(JSON.stringify(input)) > 128000)
              throw new WorkflowError("WORKFLOW_INPUT_LIMIT");
            await sql`UPDATE workflow_node_runs SET input=${sql.json(redact(input) as never)} WHERE run_id=${run.id} AND node_id=${node.id}`;
            let output: unknown = input,
              inputTokens: number | null = null,
              outputTokens: number | null = null,
              citations: unknown[] = [];
            const nodeCtx = { ...ctx, workflowNodeId: node.id };
            if (
              definitionNode &&
              ["for-each", "subworkflow", "wait", "wait-for-event"].includes(
                definitionNode.kind,
              )
            ) {
              const suspension = await suspensionFor(
                run,
                definitionNode,
                input,
                context,
              );
              await sql`UPDATE workflow_node_runs SET status='waiting' WHERE run_id=${run.id} AND node_id=${node.id}`;
              interrupt<{ nodeId: string }, { ready: boolean }>({
                nodeId: node.id,
              });
              if (suspension.status !== "ready")
                throw new WorkflowControlError("WORKFLOW_RESUME_NOT_READY");
              if (suspension.error_code)
                throw new WorkflowControlError(suspension.error_code);
              output =
                definitionNode.kind === "subworkflow"
                  ? selectWorkflowField(
                      (suspension.result as unknown[])[0],
                      definitionNode.config.outputPath,
                    )
                  : suspension.result;
            }
            if (definitionNode?.kind === "structured-ai") {
              const resource =
                program!.resources[definitionNode.config.resource]!;
              if (resource.kind !== "model")
                throw new WorkflowError("WORKFLOW_MODEL_UNAVAILABLE");
              const result = await executeStructuredAI(
                resource.id,
                definitionNode.config.instruction,
                input,
                definitionNode.config.outputSchema,
                nodeCtx,
                signal,
                overrides.providerFactory,
              );
              output = result.output;
              inputTokens = result.inputTokens;
              outputTokens = result.outputTokens;
            }
            if (definitionNode?.kind === "transform")
              output = Object.fromEntries(
                Object.entries(definitionNode.config.fields).map(
                  ([key, value]) => [
                    key,
                    resolveWorkflowExpression(value, context),
                  ],
                ),
              );
            let variableUpdate: Record<string, unknown> | undefined;
            if (definitionNode?.kind === "set-variable") {
              output = resolveWorkflowExpression(
                definitionNode.config.value,
                context,
              );
              variableUpdate = { [definitionNode.config.name]: output };
            }
            if (node.type === "agent") {
              const result = await workflowRetry(run.id, node, signal, () =>
                executeWorkflowNodeAgent(
                  node,
                  node.data.prefix + stringify(input) + node.data.suffix,
                  nodeCtx,
                  signal,
                  overrides.providerFactory,
                  overrides.embeddingFactory,
                ),
              );
              output = result.output;
              inputTokens = result.inputTokens;
              outputTokens = result.outputTokens;
              citations = result.citations;
            }
            if (node.type === "tool" || node.type === "action") {
              if (definitionNode?.kind === "action") {
                const action = program!.actions.find(
                  (a) => a.id === definitionNode.config.actionId,
                )!;
                output = await workflowRetry(run.id, node, signal, () =>
                  executeWorkflowNodeAction(
                    action,
                    definitionNode.config.inputs,
                    context,
                    nodeCtx,
                    signal,
                  ),
                );
              } else {
                const args = workflowToolArguments(node, input);
                output = (
                  await workflowRetry(run.id, node, signal, () =>
                    executeTool(node.data.toolId!, args, nodeCtx, signal),
                  )
                ).result;
              }
            }
            if (node.type === "approval" || node.type === "human-task") {
              const prompt =
                definitionNode?.kind === "human-task"
                  ? definitionNode.config.prompt
                  : node.data.approvalPrompt;
              await sql`INSERT INTO workflow_approvals(id,run_id,node_id,workspace_id,organization_id,prompt,input,decision) VALUES (${randomUUID()},${run.id},${node.id},${run.workspace_id},${run.organization_id},${prompt},${sql.json(redact(input) as never)},'pending') ON CONFLICT(run_id,node_id) DO NOTHING`;
              await sql`UPDATE workflow_node_runs SET status='waiting' WHERE run_id=${run.id} AND node_id=${node.id}`;
              const decision = interrupt<
                { nodeId: string },
                { decision: string; editedInput?: unknown }
              >({ nodeId: node.id });
              if (decision.decision !== "approved")
                throw new WorkflowError("APPROVAL_REJECTED");
              output =
                decision.editedInput === undefined
                  ? input
                  : decision.editedInput;
              if (
                definitionNode?.kind === "human-task" &&
                !schemaValidator(definitionNode.config.outputSchema)(output)
              )
                throw new WorkflowError("HUMAN_TASK_OUTPUT_INVALID");
            }
            let branch: boolean | string | undefined;
            if (definitionNode?.kind === "switch") {
              const left = resolveWorkflowExpression(
                definitionNode.config.value,
                context,
              );
              branch =
                definitionNode.config.cases.find((c) =>
                  evaluateWorkflowCondition(
                    {
                      operator: "equals",
                      left: { type: "literal", value: left as never },
                      right: { type: "literal", value: c.value },
                    },
                    context,
                  ),
                )?.id ?? "default";
            }
            if (node.type === "router" || node.type === "condition") {
              const text = stringify(input);
              branch =
                definitionNode?.kind === "condition"
                  ? evaluateWorkflowCondition(
                      definitionNode.config.condition,
                      context,
                    )
                  : node.data.operator === "contains"
                    ? text.includes(node.data.value)
                    : node.data.operator === "equals"
                      ? text === node.data.value
                      : text.trim().length > 0;
            }
            output = redact(output);
            if (variableUpdate && definitionNode?.kind === "set-variable")
              variableUpdate = { [definitionNode.config.name]: output };
            if (
              Buffer.byteLength(JSON.stringify(output)) >
              config.WORKFLOW_OUTPUT_BYTES
            )
              throw new WorkflowError("WORKFLOW_OUTPUT_LIMIT");
            signal.throwIfAborted();
            await sql`UPDATE workflow_node_runs SET status='completed',retry_at=NULL,output=${sql.json(output as never)},input_tokens=${inputTokens},output_tokens=${outputTokens},citations=${sql.json(citations as never)},duration_ms=${Math.round(performance.now() - started)},finished_at=now() WHERE run_id=${run.id} AND node_id=${node.id}`;
            observationContent(span, "output", output);
            return {
              outputs: { [node.id]: output },
              ...(variableUpdate ? { variables: variableUpdate } : {}),
              ...(branch !== undefined
                ? { decisions: { [node.id]: branch } }
                : definitionNode?.onError
                  ? { decisions: { [node.id]: "success" } }
                  : {}),
            };
          } catch (e) {
            if (isGraphInterrupt(e)) throw e;
            const code = signal.aborted ? "WORKFLOW_CANCELLED" : errorCode(e);
            await sql`UPDATE workflow_node_runs SET status=${signal.aborted ? "cancelled" : "failed"},retry_at=NULL,error_code=${code},duration_ms=${Math.round(performance.now() - started)},finished_at=now() WHERE run_id=${run.id} AND node_id=${node.id}`;
            const definitionNode = program?.nodes.find((n) => n.id === node.id);
            if (!signal.aborted && definitionNode?.onError) {
              const [trace] =
                await sql`SELECT attempts FROM workflow_node_runs WHERE run_id=${run.id} AND node_id=${node.id}`;
              const safe = {
                code: /^[A-Z][A-Z0-9_]{0,80}$/.test(code)
                  ? code
                  : "WORKFLOW_EXECUTION_FAILED",
                message: "This step could not be completed.",
                nodeId: node.id,
                attempt: Math.max(1, Math.min(3, Number(trace?.attempts ?? 1))),
              };
              observationError(span, { code: safe.code });
              return {
                outputs: { [node.id]: safe },
                errors: { [node.id]: safe },
                decisions: { [node.id]: "error" },
              };
            }
            throw e;
          }
        },
        isGraphInterrupt,
      ),
    );
  builder.addEdge(
    START,
    "node_" + graph.nodes.find((n) => n.type === "input")!.id,
  );
  for (const node of graph.nodes) {
    if (node.type === "output") {
      builder.addEdge("node_" + node.id, END);
      continue;
    }
    if (
      node.type === "router" ||
      node.type === "condition" ||
      node.type === "switch" ||
      !!program?.nodes.find((n) => n.id === node.id)?.onError
    ) {
      const edges = graph.edges.filter((e) => e.source === node.id);
      builder.addConditionalEdges(
        "node_" + node.id,
        (state) =>
          node.type === "switch" ||
          program?.nodes.find((n) => n.id === node.id)?.onError
            ? String(state.decisions[node.id])
            : state.decisions[node.id]
              ? "true"
              : "false",
        Object.fromEntries(
          edges.map((e) => [e.sourceHandle ?? "success", "node_" + e.target]),
        ),
      );
    } else
      for (const edge of graph.edges.filter((e) => e.source === node.id)) {
        if (!analysis.joins[edge.target])
          builder.addEdge("node_" + node.id, "node_" + edge.target);
      }
  }
  for (const [target, sources] of Object.entries(analysis.joins))
    builder.addEdge(
      sources.map((id) => "node_" + id),
      "node_" + target,
    );
  return builder.compile({ checkpointer: await workflowSaver() });
}
function errorCode(e: unknown) {
  return e instanceof WorkflowControlError ||
    e instanceof WorkflowValueError ||
    e instanceof WorkflowMappingError ||
    e instanceof WorkflowError ||
    e instanceof ToolError ||
    e instanceof ProviderError ||
    e instanceof KnowledgeError
    ? e.code
    : "WORKFLOW_EXECUTION_FAILED";
}
export async function claimWorkflowRun() {
  return sql.begin(async (tx) => {
    const [run] = await tx<
      WorkflowRun[]
    >`SELECT * FROM workflow_runs WHERE (status='queued' OR (status='running' AND lease_expires_at<now())) AND cancel_requested=false ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!run) return null;
    const owner = randomUUID();
    const [claimed] = await tx<
      WorkflowRun[]
    >`UPDATE workflow_runs SET status='running',lease_owner=${owner},lease_expires_at=now()+interval '120 seconds',attempts=attempts+1,started_at=COALESCE(started_at,now()) WHERE id=${run.id} RETURNING *`;
    return claimed!;
  });
}
export async function processWorkflowRun(
  overrides: {
    providerFactory?: ProviderFactory;
    embeddingFactory?: EmbeddingFactory;
  } = {},
) {
  await wakeWorkflowSuspensions();
  const run = await claimWorkflowRun();
  if (!run) return false;
  return context.with(workflowTraceContext(run.id), () =>
    observe(
      "workflow.run",
      "chain",
      {
        "langfuse.trace.name": "Workflow execution",
        "session.id": run.id,
        "workflow.run.id": run.id,
        "workspace.id": run.workspace_id,
        "organization.id": run.organization_id,
        "user.id": run.user_id ?? "anonymous",
        "workflow.attempt": run.attempts,
        "workflow.trigger": run.schedule_id
          ? "schedule"
          : run.api_key_id
            ? "api"
            : run.customer_action_id
              ? "customer"
              : "manual",
      },
      async (span) => {
        observationContent(span, "input", redact(run.input), true);
        const controller = new AbortController(),
          deadline = setTimeout(
            () => controller.abort(),
            config.WORKFLOW_ACTIVE_TIMEOUT_MS,
          );
        deadline.unref();
        const heartbeat = setInterval(() => {
          void sql`UPDATE workflow_runs SET lease_expires_at=now()+interval '120 seconds' WHERE id=${run.id} AND lease_owner=${run.lease_owner} AND status='running' AND cancel_requested=false RETURNING id`
            .then((rows) => {
              if (!rows.length) controller.abort();
            })
            .catch(() => controller.abort());
        }, 5000);
        heartbeat.unref();
        try {
          if (run.attempts > 3)
            throw new WorkflowError("WORKFLOW_RECOVERY_LIMIT");
          const graph = await compileWorkflow(
              run,
              controller.signal,
              overrides,
            ),
            executionConfig = {
              configurable: { thread_id: run.id },
              signal: controller.signal,
              recursionLimit: 60,
              maxConcurrency: 4,
            };
          const before = await graph.getState(executionConfig);
          const resume: Record<string, unknown> = {};
          for (const task of before.tasks)
            for (const interruption of task.interrupts ?? []) {
              const nodeId = (interruption.value as { nodeId?: string })
                ?.nodeId;
              if (!nodeId || !interruption.id) continue;
              const [approval] =
                await sql`SELECT edited_input,edited_input IS NOT NULL AS has_edit FROM workflow_approvals WHERE run_id=${run.id} AND node_id=${nodeId} AND decision='approved'`;
              const [suspension] =
                await sql`SELECT id FROM workflow_suspensions WHERE run_id=${run.id} AND node_id=${nodeId} AND status='ready'`;
              if (approval)
                resume[interruption.id] = {
                  decision: "approved",
                  ...(approval.has_edit
                    ? { editedInput: approval.edited_input }
                    : {}),
                };
              else if (suspension) resume[interruption.id] = { ready: true };
            }
          const initial: GraphUpdate | Command | null = !before.createdAt
            ? {
                input: run.input,
                outputs: {},
                decisions: {},
                variables: {},
                errors: {},
              }
            : Object.keys(resume).length
              ? new Command({ resume })
              : null;
          const result = await graph.invoke(initial, executionConfig);
          const snapshot = await graph.getState(executionConfig);
          const waiting = snapshot.tasks.some((t) => t.interrupts?.length);
          const remaining = snapshot.tasks
            .flatMap((t) => t.interrupts ?? [])
            .map((i) => (i.value as { nodeId: string }).nodeId);
          await sql`UPDATE workflow_suspensions SET resumed_at=now(),token_hash=NULL WHERE run_id=${run.id} AND status='ready' AND resumed_at IS NULL AND NOT (node_id=ANY(${remaining}))`;
          const outputNode = run.graph_snapshot.nodes.find(
            (n) => n.type === "output",
          )!;
          const output = waiting ? null : result.outputs[outputNode.id];
          if (!waiting && output === undefined)
            throw new WorkflowError("WORKFLOW_OUTPUT_MISSING");
          span.setAttribute(
            "workflow.status",
            waiting ? "waiting" : "completed",
          );
          observationContent(span, "output", output, true);
          const saved =
            await sql`UPDATE workflow_runs SET status=${waiting ? "waiting" : "completed"},output=${output === null ? null : sql.json(output as never)},lease_owner=NULL,lease_expires_at=NULL,finished_at=${waiting ? null : new Date()} WHERE id=${run.id} AND lease_owner=${run.lease_owner} AND status='running' AND cancel_requested=false RETURNING id`;
          if (!saved.length) {
            span.setAttribute("workflow.status", "cancelled");
            observationError(span, { code: "WORKFLOW_CANCELLED" });
            await sql`UPDATE workflow_runs SET status='cancelled',error_code='WORKFLOW_CANCELLED',finished_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE id=${run.id} AND lease_owner=${run.lease_owner} AND cancel_requested=true AND status='running'`;
          }
        } catch (e) {
          const [row] =
            await sql`SELECT cancel_requested,status FROM workflow_runs WHERE id=${run.id}`;
          const cancelled = row?.cancel_requested;
          const code = cancelled
            ? "WORKFLOW_CANCELLED"
            : controller.signal.aborted
              ? "WORKFLOW_TIMEOUT"
              : errorCode(e);
          observationError(span, { code });
          span.setAttribute(
            "workflow.status",
            cancelled ? "cancelled" : "failed",
          );
          await sql`UPDATE workflow_runs SET status=${cancelled ? "cancelled" : "failed"},error_code=${code},lease_owner=NULL,lease_expires_at=NULL,finished_at=now() WHERE id=${run.id} AND lease_owner=${run.lease_owner} AND status='running'`;
        } finally {
          clearTimeout(deadline);
          clearInterval(heartbeat);
        }
        return true;
      },
    ),
  );
}
