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
  workflowGraph,
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
  workflowAgentVersion,
  executeWorkflowAgent,
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
  workspace_id: string;
  organization_id: string;
  user_id: string;
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
) {
  const analysis = analyzeWorkflow(graph);
  if (analysis.errors.length) throw new WorkflowError("WORKFLOW_GRAPH_INVALID");
  for (const n of graph.nodes) {
    if (n.type === "agent")
      await workflowAgentVersion(n.data.agentVersionId!, ctx);
    if (n.type === "tool") await validateToolIds([n.data.toolId!], ctx);
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
  decisions: Annotation<Record<string, boolean>>({
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
  if (node.type === "input") return state.input;
  if (node.data.inputFrom) {
    if (!(node.data.inputFrom in state.outputs))
      throw new WorkflowError("WORKFLOW_MAPPING_UNAVAILABLE");
    return state.outputs[node.data.inputFrom];
  }
  const values = graph.edges
    .filter((e) => e.target === node.id)
    .filter((e) => e.source in state.outputs)
    .map((e) => [e.source, state.outputs[e.source]] as const);
  if (!values.length) throw new WorkflowError("WORKFLOW_MAPPING_UNAVAILABLE");
  return node.type === "merge" ? Object.fromEntries(values) : values[0]![1];
}
export async function compileWorkflow(
  run: WorkflowRun,
  signal: AbortSignal,
  overrides: {
    providerFactory?: ProviderFactory;
    embeddingFactory?: EmbeddingFactory;
  } = {},
) {
  const graph = workflowGraph.parse(run.graph_snapshot),
    analysis = analyzeWorkflow(graph);
  if (analysis.errors.length) throw new WorkflowError("WORKFLOW_GRAPH_INVALID");
  const ctx: ToolContext = {
    workspaceId: run.workspace_id,
    organizationId: run.organization_id,
    userId: run.user_id,
    workflowRunId: run.id,
  };
  const builder = new StateGraph<
    typeof State.spec,
    GraphState,
    GraphUpdate,
    string
  >(State);
  for (const node of graph.nodes)
    builder.addNode("node_" + node.id, async (state: GraphState) => {
      signal.throwIfAborted();
      const input = nodeInput(node, graph, state),
        started = performance.now();
      if (Buffer.byteLength(JSON.stringify(input)) > 128000)
        throw new WorkflowError("WORKFLOW_INPUT_LIMIT");
      await sql`INSERT INTO workflow_node_runs(run_id,node_id,workspace_id,organization_id,label,kind,status,input) VALUES (${run.id},${node.id},${run.workspace_id},${run.organization_id},${node.data.label},${node.type},'running',${sql.json(redact(input) as never)}) ON CONFLICT(run_id,node_id) DO UPDATE SET status='running',error_code=NULL,finished_at=NULL`;
      try {
        let output: unknown = input,
          inputTokens: number | null = null,
          outputTokens: number | null = null,
          citations: unknown[] = [];
        const nodeCtx = { ...ctx, workflowNodeId: node.id };
        if (node.type === "agent") {
          const result = await executeWorkflowAgent(
            node.data.agentVersionId!,
            node.data.prefix + stringify(input) + node.data.suffix,
            nodeCtx,
            signal,
            overrides.providerFactory,
            overrides.embeddingFactory,
          );
          output = result.output;
          inputTokens = result.inputTokens;
          outputTokens = result.outputTokens;
          citations = result.citations;
        }
        if (node.type === "tool") {
          const args = {
            ...node.data.toolArguments,
            ...(node.data.inputArgument
              ? { [node.data.inputArgument]: stringify(input) }
              : {}),
          };
          output = (await executeTool(node.data.toolId!, args, nodeCtx, signal))
            .result;
        }
        if (node.type === "approval") {
          await sql`INSERT INTO workflow_approvals(id,run_id,node_id,workspace_id,organization_id,prompt,input,decision) VALUES (${randomUUID()},${run.id},${node.id},${run.workspace_id},${run.organization_id},${node.data.approvalPrompt},${sql.json(redact(input) as never)},'pending') ON CONFLICT(run_id,node_id) DO NOTHING`;
          await sql`UPDATE workflow_node_runs SET status='waiting' WHERE run_id=${run.id} AND node_id=${node.id}`;
          const decision = interrupt<
            { nodeId: string },
            { decision: string; editedInput?: unknown }
          >({ nodeId: node.id });
          if (decision.decision !== "approved")
            throw new WorkflowError("APPROVAL_REJECTED");
          output =
            decision.editedInput === undefined ? input : decision.editedInput;
        }
        let branch: boolean | undefined;
        if (node.type === "router" || node.type === "condition") {
          const text = stringify(input);
          branch =
            node.data.operator === "contains"
              ? text.includes(node.data.value)
              : node.data.operator === "equals"
                ? text === node.data.value
                : text.trim().length > 0;
        }
        output = redact(output);
        if (Buffer.byteLength(JSON.stringify(output)) > 128000)
          throw new WorkflowError("WORKFLOW_OUTPUT_LIMIT");
        signal.throwIfAborted();
        await sql`UPDATE workflow_node_runs SET status='completed',output=${sql.json(output as never)},input_tokens=${inputTokens},output_tokens=${outputTokens},citations=${sql.json(citations as never)},duration_ms=${Math.round(performance.now() - started)},finished_at=now() WHERE run_id=${run.id} AND node_id=${node.id}`;
        return {
          outputs: { [node.id]: output },
          ...(branch !== undefined ? { decisions: { [node.id]: branch } } : {}),
        };
      } catch (e) {
        if (isGraphInterrupt(e)) throw e;
        const code = signal.aborted ? "WORKFLOW_CANCELLED" : errorCode(e);
        await sql`UPDATE workflow_node_runs SET status=${signal.aborted ? "cancelled" : "failed"},error_code=${code},duration_ms=${Math.round(performance.now() - started)},finished_at=now() WHERE run_id=${run.id} AND node_id=${node.id}`;
        throw e;
      }
    });
  builder.addEdge(
    START,
    "node_" + graph.nodes.find((n) => n.type === "input")!.id,
  );
  for (const node of graph.nodes) {
    if (node.type === "output") {
      builder.addEdge("node_" + node.id, END);
      continue;
    }
    if (node.type === "router" || node.type === "condition") {
      const edges = graph.edges.filter((e) => e.source === node.id);
      builder.addConditionalEdges(
        "node_" + node.id,
        (state) => (state.decisions[node.id] ? "true" : "false"),
        Object.fromEntries(
          edges.map((e) => [e.sourceHandle!, "node_" + e.target]),
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
  return e instanceof WorkflowError ||
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
  const run = await claimWorkflowRun();
  if (!run) return false;
  const controller = new AbortController(),
    deadline = setTimeout(() => controller.abort(), 300000);
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
    if (run.attempts > 3) throw new WorkflowError("WORKFLOW_RECOVERY_LIMIT");
    const graph = await compileWorkflow(run, controller.signal, overrides),
      executionConfig = {
        configurable: { thread_id: run.id },
        signal: controller.signal,
        recursionLimit: 60,
        maxConcurrency: 4,
      };
    const before = await graph.getState(executionConfig);
    const [approval] =
      await sql`SELECT decision,edited_input,edited_input IS NOT NULL AS has_edit FROM workflow_approvals WHERE run_id=${run.id}`;
    let initial: GraphUpdate | Command | null = before.createdAt
      ? null
      : { input: run.input, outputs: {}, decisions: {} };
    if (
      approval?.decision === "approved" &&
      before.tasks.some((t) => t.interrupts?.length)
    )
      initial = new Command({
        resume: {
          decision: "approved",
          ...(approval.has_edit ? { editedInput: approval.edited_input } : {}),
        },
      });
    const result = await graph.invoke(initial, executionConfig);
    const snapshot = await graph.getState(executionConfig);
    const waiting = snapshot.tasks.some((t) => t.interrupts?.length);
    const outputNode = run.graph_snapshot.nodes.find(
      (n) => n.type === "output",
    )!;
    const output = waiting ? null : result.outputs[outputNode.id];
    if (!waiting && output === undefined)
      throw new WorkflowError("WORKFLOW_OUTPUT_MISSING");
    const saved =
      await sql`UPDATE workflow_runs SET status=${waiting ? "waiting" : "completed"},output=${output === null ? null : sql.json(output as never)},lease_owner=NULL,lease_expires_at=NULL,finished_at=${waiting ? null : new Date()} WHERE id=${run.id} AND lease_owner=${run.lease_owner} AND status='running' AND cancel_requested=false RETURNING id`;
    if (!saved.length)
      await sql`UPDATE workflow_runs SET status='cancelled',error_code='WORKFLOW_CANCELLED',finished_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE id=${run.id} AND lease_owner=${run.lease_owner} AND cancel_requested=true AND status='running'`;
  } catch (e) {
    const [row] =
      await sql`SELECT cancel_requested,status FROM workflow_runs WHERE id=${run.id}`;
    const cancelled = row?.cancel_requested;
    const code = cancelled
      ? "WORKFLOW_CANCELLED"
      : controller.signal.aborted
        ? "WORKFLOW_TIMEOUT"
        : errorCode(e);
    await sql`UPDATE workflow_runs SET status=${cancelled ? "cancelled" : "failed"},error_code=${code},lease_owner=NULL,lease_expires_at=NULL,finished_at=now() WHERE id=${run.id} AND lease_owner=${run.lease_owner} AND status='running'`;
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
  }
  return true;
}
