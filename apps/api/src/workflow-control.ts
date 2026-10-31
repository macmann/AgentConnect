import { config } from "./config.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql } from "./db.js";
import { storedWorkflowGraph, workflowV2Program } from "./workflow-v2.js";
import {
  normalizeWorkflowInput,
  type WorkflowGraph,
} from "@agentconnect/schemas/workflows";
import {
  resolveWorkflowExpression,
  assertWorkflowValue,
  type WorkflowDataContext,
} from "@agentconnect/schemas/workflow-values";
import type { WorkflowDefinitionV2 } from "@agentconnect/schemas/workflow-v2";
import type { WorkflowRun } from "./workflow-runtime.js";
import { redact } from "./tool-runtime.js";
type Node = WorkflowDefinitionV2["execution"]["nodes"][number];
export class WorkflowControlError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export type Suspension = {
  id: string;
  run_id: string;
  node_id: string;
  workspace_id: string;
  organization_id: string;
  kind: "wait" | "event" | "children";
  status: string;
  due_at: Date | null;
  result: unknown;
  error_code: string | null;
  payload: {
    graph?: WorkflowGraph;
    workflowId?: string;
    versionId?: string;
    inputs?: {
      input: string;
      scope?: { item: unknown; iteration: { index: number } };
    }[];
    failurePolicy?: string;
    collect?: boolean;
    eventName?: string;
    outputSchema?: Record<string, unknown>;
    value?: unknown;
  };
};
export async function suspensionFor(
  run: WorkflowRun,
  node: Node,
  input: unknown,
  context: WorkflowDataContext,
): Promise<Suspension> {
  const [existing] = await sql<
    Suspension[]
  >`SELECT * FROM workflow_suspensions WHERE run_id=${run.id} AND node_id=${node.id}`;
  if (existing) return existing;
  let kind: Suspension["kind"] = "wait",
    due: Date | null = null,
    payload: Suspension["payload"] = {};
  if (node.kind === "wait") {
    due =
      node.config.mode === "duration"
        ? new Date(Date.now() + node.config.seconds * 1000)
        : (() => {
            const value = resolveWorkflowExpression(
              node.config.until!,
              context,
            );
            if (
              typeof value !== "string" ||
              !z.iso.datetime({ offset: true }).safeParse(value).success
            )
              throw new WorkflowControlError("WAIT_TIMESTAMP_INVALID");
            return new Date(value);
          })();
    if (
      !Number.isFinite(due.getTime()) ||
      due.getTime() > Date.now() + 2592000000
    )
      throw new WorkflowControlError("WAIT_LIMIT_EXCEEDED");
    payload.value = redact(input);
  } else if (node.kind === "wait-for-event") {
    kind = "event";
    due = new Date(Date.now() + node.config.timeoutSeconds * 1000);
    payload = {
      eventName: node.config.eventName,
      outputSchema: node.config.outputSchema,
    };
  } else if (node.kind === "subworkflow" || node.kind === "for-each") {
    kind = "children";
    const resource = workflowV2Program(run.graph_snapshot)?.resources[
      node.config.resource
    ];
    if (resource?.kind !== "workflow")
      throw new WorkflowControlError("SUBWORKFLOW_UNAVAILABLE");
    const ancestry = await sql<
      { workflow_id: string; id: string; depth: number }[]
    >`WITH RECURSIVE lineage AS (SELECT id,workflow_id,parent_run_id,0 AS depth FROM workflow_runs WHERE id=${run.id} UNION ALL SELECT r.id,r.workflow_id,r.parent_run_id,l.depth+1 FROM workflow_runs r JOIN lineage l ON r.id=l.parent_run_id WHERE l.depth<4) SELECT id,workflow_id,depth FROM lineage`;
    if (
      ancestry.length >= config.WORKFLOW_MAX_DEPTH ||
      ancestry.some((a) => a.workflow_id === resource.workflowId)
    )
      throw new WorkflowControlError("SUBWORKFLOW_RECURSION_LIMIT");
    const [version] =
      await sql`SELECT v.id,v.graph FROM workflow_versions v JOIN workflows w ON w.id=v.workflow_id WHERE v.workflow_id=${resource.workflowId} AND v.workspace_id=${run.workspace_id} AND v.organization_id=${run.organization_id} AND w.archived_at IS NULL AND (${resource.versionBehavior}='latest-published' OR v.id=${resource.versionId ?? null}) ORDER BY v.version DESC LIMIT 1`;
    if (!version) throw new WorkflowControlError("SUBWORKFLOW_UNAVAILABLE");
    const graph = storedWorkflowGraph(version.graph);
    const { validateWorkflowDependencies } =
      await import("./workflow-runtime.js");
    await validateWorkflowDependencies(graph, {
      workflowId: resource.workflowId,
      workspaceId: run.workspace_id,
      organizationId: run.organization_id,
      userId: run.user_id ?? undefined,
    });
    let items: unknown[] = [input];
    if (node.kind === "for-each") {
      const collection = resolveWorkflowExpression(
        node.config.collection,
        context,
      );
      if (!Array.isArray(collection))
        throw new WorkflowControlError("FOR_EACH_ARRAY_REQUIRED");
      if (
        Math.max(0, collection.length - node.config.startIndex) >
          node.config.maxItems ||
        collection.length > config.WORKFLOW_MAX_ITERATIONS
      )
        throw new WorkflowControlError("FOR_EACH_LIMIT_EXCEEDED");
      items = collection.slice(node.config.startIndex);
    }
    payload = {
      workflowId: resource.workflowId,
      versionId: version.id,
      graph,
      collect: node.kind === "for-each",
      failurePolicy:
        node.kind === "for-each" ? node.config.failurePolicy : "fail-workflow",
      inputs: items.map((item, index) => {
        const scope = {
          item,
          iteration: {
            index:
              index + (node.kind === "for-each" ? node.config.startIndex : 0),
          },
        };
        const value =
          node.kind === "for-each" && Object.keys(node.config.itemInputs).length
            ? Object.fromEntries(
                Object.entries(node.config.itemInputs).map(
                  ([key, expression]) => [
                    key,
                    resolveWorkflowExpression(expression, {
                      ...context,
                      ...scope,
                    }),
                  ],
                ),
              )
            : item;
        const normalized = normalizeWorkflowInput(
          graph,
          !graph.inputFields.length &&
            (graph.programV2 || typeof value !== "string")
            ? JSON.stringify(value)
            : value,
        );
        return {
          input: normalized,
          ...(node.kind === "for-each" ? { scope } : {}),
        };
      }),
    };
  } else throw new WorkflowControlError("WORKFLOW_SUSPENSION_INVALID");
  payload = JSON.parse(JSON.stringify(payload));
  assertWorkflowValue(payload);
  if (Buffer.byteLength(JSON.stringify(payload)) > 1000000)
    throw new WorkflowControlError("WORKFLOW_STATE_LIMIT");
  const [created] = await sql<
    Suspension[]
  >`INSERT INTO workflow_suspensions(id,run_id,node_id,workspace_id,organization_id,kind,due_at,payload) VALUES (${randomUUID()},${run.id},${node.id},${run.workspace_id},${run.organization_id},${kind},${due},${sql.json(payload as never)}) ON CONFLICT(run_id,node_id) DO UPDATE SET node_id=EXCLUDED.node_id RETURNING *`;
  return created!;
}
// Every worker queue poll services durable records. No timer is needed for any individual wait.
export async function wakeWorkflowSuspensions() {
  // Terminal ancestors cancel their descendants, including child runs parked at HITL/event waits.
  await sql`WITH RECURSIVE stopped AS (SELECT id FROM workflow_runs WHERE (cancel_requested OR status IN ('failed','cancelled','rejected')) AND EXISTS(SELECT 1 FROM workflow_runs c WHERE c.parent_run_id=workflow_runs.id AND c.status IN ('queued','running','waiting')) UNION SELECT r.id FROM workflow_runs r JOIN stopped p ON r.parent_run_id=p.id) UPDATE workflow_runs r SET cancel_requested=true,status=CASE WHEN r.status='running' THEN 'running' ELSE 'cancelled' END,finished_at=CASE WHEN r.status='running' THEN r.finished_at ELSE now() END FROM stopped s WHERE r.id=s.id AND r.parent_run_id IS NOT NULL AND r.status IN ('queued','running','waiting')`;
  await sql`UPDATE workflow_suspensions s SET status='cancelled',token_hash=NULL FROM workflow_runs r WHERE r.id=s.run_id AND (r.cancel_requested OR r.status IN ('failed','cancelled','rejected') OR (r.status='completed' AND s.status='pending')) AND s.status<>'cancelled'`;
  await sql`UPDATE workflow_suspensions s SET status='ready',result=CASE WHEN s.kind='wait' THEN s.payload->'value' ELSE NULL END,error_code=CASE WHEN s.kind='event' THEN 'WORKFLOW_EVENT_TIMEOUT' ELSE NULL END FROM workflow_runs r WHERE r.id=s.run_id AND r.status IN ('running','waiting') AND NOT r.cancel_requested AND s.status='pending' AND s.kind IN ('wait','event') AND s.due_at<=now()`;
  const pending = await sql<
    { id: string }[]
  >`SELECT s.id FROM workflow_suspensions s JOIN workflow_runs r ON r.id=s.run_id WHERE s.kind='children' AND s.status='pending' AND r.status IN ('running','waiting') AND NOT r.cancel_requested AND NOT EXISTS(SELECT 1 FROM workflow_runs c WHERE c.parent_run_id=s.run_id AND c.parent_node_id=s.node_id AND c.status IN ('queued','running','waiting')) ORDER BY s.created_at LIMIT 100`;
  for (const { id } of pending)
    await sql.begin(async (tx) => {
      const [s] = await tx<
        Suspension[]
      >`SELECT * FROM workflow_suspensions WHERE id=${id} AND status='pending' FOR UPDATE SKIP LOCKED`;
      if (!s) return;
      const [parent] =
        await tx`SELECT * FROM workflow_runs WHERE id=${s.run_id}`;
      if (
        !parent ||
        parent.cancel_requested ||
        !["running", "waiting"].includes(parent.status)
      )
        return;
      const children =
        await tx`SELECT id,status,output,error_code,iteration_index FROM workflow_runs WHERE parent_run_id=${s.run_id} AND parent_node_id=${s.node_id} ORDER BY iteration_index`;
      if (
        children.some((c) =>
          ["queued", "running", "waiting"].includes(c.status),
        )
      )
        return;
      const failed = children.find((c) => c.status !== "completed");
      if (failed && s.payload.failurePolicy !== "continue") {
        await tx`UPDATE workflow_suspensions SET status='ready',error_code='SUBWORKFLOW_FAILED' WHERE id=${s.id}`;
        return;
      }
      const inputs = s.payload.inputs ?? [];
      if (children.length === inputs.length) {
        const result = children.map((c) =>
          c.status === "completed"
            ? s.payload.collect
              ? {
                  index:
                    s.payload.inputs?.[c.iteration_index]?.scope?.iteration
                      .index ?? c.iteration_index,
                  status: "completed",
                  output: c.output,
                }
              : c.output
            : {
                status: "failed",
                error: {
                  code: c.error_code ?? "SUBWORKFLOW_FAILED",
                  index:
                    s.payload.inputs?.[c.iteration_index]?.scope?.iteration
                      .index ?? c.iteration_index,
                },
              },
        );
        if (
          Buffer.byteLength(JSON.stringify(result)) >
          config.WORKFLOW_OUTPUT_BYTES
        )
          await tx`UPDATE workflow_suspensions SET status='ready',error_code='WORKFLOW_OUTPUT_LIMIT' WHERE id=${s.id}`;
        else
          await tx`UPDATE workflow_suspensions SET status='ready',result=${tx.json(result as never)} WHERE id=${s.id}`;
        return;
      }
      const available =
        await tx`SELECT id FROM workflows WHERE id=${s.payload.workflowId!} AND workspace_id=${s.workspace_id} AND organization_id=${s.organization_id} AND archived_at IS NULL`;
      if (!available.length) {
        await tx`UPDATE workflow_suspensions SET status='ready',error_code='SUBWORKFLOW_UNAVAILABLE' WHERE id=${s.id}`;
        return;
      }
      // Serialize the shared descendant budget on the root run, not in process memory.
      const lineage =
        await tx`WITH RECURSIVE l AS (SELECT id,parent_run_id,0 AS depth FROM workflow_runs WHERE id=${s.run_id} UNION ALL SELECT r.id,r.parent_run_id,l.depth+1 FROM workflow_runs r JOIN l ON r.id=l.parent_run_id WHERE l.depth<4) SELECT id FROM l WHERE parent_run_id IS NULL`;
      const rootId = lineage[0]?.id;
      if (!rootId) {
        await tx`UPDATE workflow_suspensions SET status='ready',error_code='SUBWORKFLOW_RECURSION_LIMIT' WHERE id=${s.id}`;
        return;
      }
      const [root] =
        await tx`SELECT status,cancel_requested FROM workflow_runs WHERE id=${rootId} FOR UPDATE`;
      if (
        root?.cancel_requested ||
        !["queued", "running", "waiting"].includes(root?.status)
      )
        return;
      const [count] =
        await tx`WITH RECURSIVE descendants AS (SELECT id,0 AS depth FROM workflow_runs WHERE id=${rootId} UNION ALL SELECT r.id,d.depth+1 FROM workflow_runs r JOIN descendants d ON r.parent_run_id=d.id WHERE d.depth<4) SELECT count(*)::int AS total FROM descendants`;
      if (count!.total > 100) {
        await tx`UPDATE workflow_suspensions SET status='ready',error_code='WORKFLOW_CHILD_LIMIT' WHERE id=${s.id}`;
        return;
      }
      const index = children.length,
        entry = inputs[index]!,
        graph = structuredClone(s.payload.graph!);
      if (graph.programV2 && entry.scope)
        graph.programV2.scope = entry.scope as never;
      await tx`INSERT INTO workflow_runs(id,workflow_id,version_id,workspace_id,organization_id,user_id,graph_snapshot,input,status,parent_run_id,parent_node_id,iteration_index,api_key_id,schedule_id,webhook_id) VALUES (${randomUUID()},${s.payload.workflowId!},${s.payload.versionId!},${s.workspace_id},${s.organization_id},${parent.user_id},${tx.json(graph)},${entry.input},'queued',${s.run_id},${s.node_id},${index},${parent.api_key_id},${parent.schedule_id},${parent.webhook_id}) ON CONFLICT DO NOTHING`;
    });
  await sql`UPDATE workflow_runs r SET status='queued',attempts=0 FROM workflow_suspensions s WHERE s.run_id=r.id AND s.status='ready' AND s.resumed_at IS NULL AND r.status='waiting' AND NOT r.cancel_requested`;
}
