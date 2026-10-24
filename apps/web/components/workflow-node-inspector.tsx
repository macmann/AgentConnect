"use client";
import type { WorkflowNode } from "@agentconnect/schemas/workflows";
import { Citations, type Citation } from "./citations";
import { ToolTraces, type ToolTrace } from "./tool-studio";
export type WorkflowStepTrace = {
  node_id: string;
  status: string;
  input: unknown;
  output: unknown;
  duration_ms: number | null;
  error_code: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  citations: Citation[];
  attempts: number;
  retry_history: {
    attempt: number;
    code: string;
    durationMs: number;
    willRetry: boolean;
  }[];
};
export function WorkflowNodeInspector({
  node,
  trace,
  tools,
}: {
  node: WorkflowNode;
  trace?: WorkflowStepTrace;
  tools: (ToolTrace & { workflow_node_id?: string })[];
}) {
  return (
    <section
      className="workflow-selected-step"
      aria-label="Selected step details"
    >
      <h4>Step details: {node.data.label}</h4>
      <p>
        {node.type} · {trace?.status ?? "Not executed"}
        {trace?.duration_ms != null ? ` · ${trace.duration_ms} ms` : ""}
      </p>
      {!trace && (
        <p>
          This step has no recorded execution. It may be queued or on a branch
          that was not taken.
        </p>
      )}
      {trace?.error_code && (
        <p role="alert" className="error-text">
          {trace.error_code}
          {trace.error_code.startsWith("WORKFLOW_MAPPING_")
            ? " — check the mapped source and field path."
            : ""}
        </p>
      )}
      {trace && (
        <>
          <p>
            {trace.attempts} attempt(s)
            {node.type === "agent"
              ? ` · Reported tokens: ${trace.input_tokens ?? "unavailable"} input / ${trace.output_tokens ?? "unavailable"} output`
              : ""}
          </p>
          <details open>
            <summary>Recorded input</summary>
            <pre>
              {JSON.stringify(trace.input, null, 2) ?? "No input recorded"}
            </pre>
          </details>
          <details open>
            <summary>Recorded output</summary>
            <pre>
              {JSON.stringify(trace.output, null, 2) ?? "No output recorded"}
            </pre>
          </details>
          <Citations sources={trace.citations ?? []} />
          {!!trace.retry_history?.length && (
            <details>
              <summary>Retry history</summary>
              <ul>
                {trace.retry_history.map((r, i) => (
                  <li key={i}>
                    Attempt {r.attempt} · {r.code} · {r.durationMs} ms ·{" "}
                    {r.willRetry ? "Retry scheduled" : "Stopped"}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <ToolTraces
            traces={tools.filter((t) => t.workflow_node_id === node.id)}
          />
        </>
      )}
      {(node.data.inputFrom ||
        node.data.inputPath ||
        node.data.inputBindings?.length) && (
        <details>
          <summary>Published/run input mapping</summary>
          <pre>
            {JSON.stringify(
              {
                source: node.data.inputFrom,
                path: node.data.inputPath,
                fields: node.data.inputBindings,
              },
              null,
              2,
            )}
          </pre>
        </details>
      )}
      <small>
        Recorded values may be redacted. Configuration comes from this run’s
        immutable snapshot.
      </small>
    </section>
  );
}
