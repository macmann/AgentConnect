"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { requestJson } from "./agent-client";
import { Button } from "./button";
import { StructuredFields, type ValueSchema } from "./workflow-v2-fields";
type Task = {
  run_id: string;
  workflow_id: string;
  workflow_name: string;
  node_id: string;
  task: string;
  prompt: string;
  input: unknown;
  created_at: string;
  cursor_time?: string;
  config: {
    mode: string;
    outputSchema?: ValueSchema;
    approveLabel?: string;
    rejectLabel?: string;
  };
};
export function WorkflowOperations({
  workspaceId,
  role,
  tasks = false,
}: {
  workspaceId: string;
  role: string;
  tasks?: boolean;
}) {
  const [before, setBefore] = useState<{ time: string; id: string } | null>(
    null,
  );
  const [runId, setRun] = useState(""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const list = useQuery({
    queryKey: ["workflow-operations", workspaceId, tasks, before],
    queryFn: () =>
      requestJson<
        (Task & {
          id: string;
          status: string;
          error_code?: string;
          current_nodes?: string[];
          human_tasks: number;
        })[]
      >(
        `/workspaces/${workspaceId}/workflow-operations?view=${tasks ? "tasks" : "runs"}${before ? `&before=${encodeURIComponent(before.time)}&beforeId=${before.id}` : ""}`,
      ),
    refetchInterval: 5000,
  });
  const run = useQuery({
    queryKey: ["workflow-operation-run", runId],
    enabled: !!runId,
    queryFn: () => requestJson<RunDetail>(`/workflow-runs/${runId}`),
    refetchInterval: 5000,
  });
  const approve = [
    "owner",
    "org_admin",
    "workspace_admin",
    "operator",
  ].includes(role);
  return (
    <section className="panel">
      <h2>{tasks ? "Human Tasks" : "Workflow runs"}</h2>
      <p>
        {tasks
          ? "Review pending workflow decisions. Each decision resumes the existing durable run."
          : "Inspect workflow activity, waits, retries and child runs across this workspace."}
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {list.error && <p role="alert">{list.error.message}</p>}
      {list.isPending && <p>Loading…</p>}
      {list.data?.length === 0 && (
        <p>{tasks ? "No pending human tasks." : "No workflow runs yet."}</p>
      )}
      {list.data?.map((row) =>
        tasks ? (
          <TaskCard
            key={row.run_id + row.node_id}
            task={row}
            canApprove={approve}
            onComplete={async (decision, value) => {
              setError("");
              try {
                await requestJson(
                  `/workflow-runs/${row.run_id}/approval`,
                  "POST",
                  {
                    nodeId: row.node_id,
                    decision,
                    ...(value === undefined ? {} : { editedInput: value }),
                  },
                );
                setNotice(
                  "Decision recorded. The workflow will resume through the worker.",
                );
                await list.refetch();
              } catch (e) {
                setError((e as Error).message);
                throw e;
              }
            }}
          />
        ) : (
          <article key={row.id} className="workflow-run-row">
            <strong>{row.workflow_name}</strong>
            <p>
              {row.status.replaceAll("_", " ")} ·{" "}
              {new Date(row.created_at).toLocaleString()} · {row.human_tasks}{" "}
              human tasks {row.error_code}
            </p>
            <Button onClick={() => setRun(row.id)}>
              Inspect run {row.id.slice(0, 8)}
            </Button>
          </article>
        ),
      )}
      {before && (
        <Button onClick={() => setBefore(null)}>Latest entries</Button>
      )}
      {list.data?.length === 100 && (
        <Button
          onClick={() => {
            const last = list.data!.at(-1)!;
            setBefore({
              time: last.cursor_time ?? last.created_at,
              id: last.id,
            });
          }}
        >
          Older entries
        </Button>
      )}
      {run.error && <p role="alert">{run.error.message}</p>}
      {run.data && (
        <div aria-label="Run inspection">
          <Button onClick={() => setRun("")}>Close inspection</Button>
          <WorkflowRunDetail run={run.data} onChild={setRun} />
        </div>
      )}
    </section>
  );
}
function TaskCard({
  task,
  canApprove,
  onComplete,
}: {
  task: Task;
  canApprove: boolean;
  onComplete: (decision: string, value?: unknown) => Promise<void>;
}) {
  const [edited, setEdited] = useState<unknown>(undefined),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function decide(decision: string) {
    setBusy(true);
    try {
      await onComplete(decision, decision === "approved" ? edited : undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="panel">
      <h3>
        {task.workflow_name} · {task.task}
      </h3>
      <p>
        Run {task.run_id.slice(0, 8)} ·{" "}
        {new Date(task.created_at).toLocaleString()}
      </p>
      <p>{task.prompt}</p>
      <fieldset disabled={!canApprove || busy}>
        {task.config.mode === "review-edit" ? (
          <StructuredFields
            schema={task.config.outputSchema ?? {}}
            value={edited === undefined ? task.input : edited}
            onChange={setEdited}
            label="Review fields"
          />
        ) : (
          <details>
            <summary>Review input</summary>
            <pre>{JSON.stringify(task.input, null, 2)}</pre>
          </details>
        )}
        <Button onClick={() => void decide("approved")}>
          {task.config.approveLabel ?? "Approve"}
        </Button>
        <Button onClick={() => void decide("rejected")}>
          {task.config.rejectLabel ?? "Reject"}
        </Button>
      </fieldset>
      {!canApprove && (
        <p>Workflow approval permission is required to complete this task.</p>
      )}
      {error && <p role="alert">{error}</p>}
    </article>
  );
}
export type RunDetail = {
  id: string;
  status: string;
  input: unknown;
  output: unknown;
  error_code?: string;
  graph_snapshot: { nodes: { id: string; data: { label: string } }[] };
  nodes: {
    node_id: string;
    status: string;
    input: unknown;
    output: unknown;
    error_code?: string;
    attempts?: number;
    retry_history?: unknown;
  }[];
  approvals?: { node_id: string; decision: string }[];
  suspensions: {
    node_id: string;
    kind: string;
    status: string;
    due_at?: string;
    total_items?: number;
  }[];
  children: {
    id: string;
    parent_node_id: string;
    iteration_index?: number;
    status: string;
  }[];
  actionExecutions: {
    node_id: string;
    connector: string;
    operation: string;
    status: string;
    attempts: number;
    duration_ms?: number;
    error_code?: string;
    attempt_history: unknown;
  }[];
};
export function WorkflowRunDetail({
  run,
  onChild,
}: {
  run: RunDetail;
  onChild?: (id: string) => void;
}) {
  const active = new Map(run.nodes.map((n) => [n.node_id, n]));
  return (
    <div>
      <h3>
        Run {run.id.slice(0, 8)} · {run.status}
      </h3>
      {run.error_code && <p role="alert">{run.error_code}</p>}
      <ol>
        {run.graph_snapshot.nodes.map((n) => {
          const step = active.get(n.id);
          const wait = run.suspensions.find(
            (s) => s.node_id === n.id && s.status === "pending",
          );
          return (
            <li key={n.id}>
              <strong>{n.data.label}</strong> ·{" "}
              {wait
                ? wait.kind === "event"
                  ? "Waiting for event"
                  : wait.kind === "timer"
                    ? "Waiting for timer"
                    : "Waiting for child results"
                : run.approvals?.some(
                      (a) => a.node_id === n.id && a.decision === "pending",
                    )
                  ? "Waiting for human"
                  : (step?.status ??
                    (["completed", "failed", "rejected", "cancelled"].includes(
                      run.status,
                    )
                      ? "Skipped / not reached"
                      : "Pending / not reached"))}
              {step?.error_code && <span> · {step.error_code}</span>}
              {step && (
                <details>
                  <summary>
                    Safe step data · {step.attempts ?? 1} attempts
                  </summary>
                  <pre>
                    {JSON.stringify(
                      {
                        input: step.input,
                        output: step.output,
                        retries: step.retry_history,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              )}
            </li>
          );
        })}
      </ol>
      {run.suspensions
        .filter((s) => s.status === "pending")
        .map((s) => (
          <p key={s.node_id}>
            {s.node_id}: {s.kind} wait{" "}
            {s.total_items !== undefined && s.total_items !== null
              ? ` · ${run.children.filter((c) => c.parent_node_id === s.node_id && ["completed", "failed", "cancelled", "rejected"].includes(c.status)).length} of ${s.total_items} processed`
              : ""}{" "}
            {s.due_at ? `until ${new Date(s.due_at).toLocaleString()}` : ""}
          </p>
        ))}
      {!!run.children.length && (
        <div>
          <h4>Child runs / For Each progress</h4>
          <p>
            {run.children.filter((c) => c.status === "completed").length}{" "}
            completed ·{" "}
            {
              run.children.filter((c) =>
                ["failed", "rejected", "cancelled"].includes(c.status),
              ).length
            }{" "}
            failed ·{" "}
            {
              run.children.filter((c) =>
                ["queued", "running", "waiting"].includes(c.status),
              ).length
            }{" "}
            active
          </p>
          {run.children.map((c) => (
            <p key={c.id}>
              {c.parent_node_id}{" "}
              {c.iteration_index === null ? "" : `item ${c.iteration_index}`} ·{" "}
              {c.status}{" "}
              {onChild && (
                <Button onClick={() => onChild(c.id)}>
                  Inspect child {c.id.slice(0, 8)}
                </Button>
              )}
            </p>
          ))}
        </div>
      )}
      {!!run.actionExecutions.length && (
        <details>
          <summary>Action attempts</summary>
          {run.actionExecutions.map((a) => (
            <p key={a.node_id}>
              {a.node_id} · {a.connector}/{a.operation} · {a.status} ·{" "}
              {a.attempts} attempts · {a.duration_ms} ms {a.error_code}
            </p>
          ))}
        </details>
      )}
      <details>
        <summary>Safe workflow input/output</summary>
        <pre>
          {JSON.stringify({ input: run.input, output: run.output }, null, 2)}
        </pre>
      </details>
    </div>
  );
}
