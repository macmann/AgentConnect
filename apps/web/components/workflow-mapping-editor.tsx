"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  WorkflowGraph,
  WorkflowNode,
} from "@agentconnect/schemas/workflows";
import {
  workflowAncestors,
  workflowFieldOptions,
  resolveWorkflowMapping,
  workflowToolArguments,
  pointerSegments,
} from "@agentconnect/schemas/workflow-mapping";
import { requestJson } from "./agent-client";
import { Button } from "./button";
import { HelpTooltip } from "./help-tooltip";
type SampleRun = {
  id: string;
  status: string;
  graph_snapshot: WorkflowGraph;
  nodes: { node_id: string; status: string; output: unknown }[];
};
const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? "No value";
function FieldPath({
  path,
  onChange,
  options,
  label,
}: {
  path: string;
  onChange: (p: string) => void;
  options: { path: string; type: string }[];
  label: string;
}) {
  let error = "";
  try {
    pointerSegments(path);
  } catch {
    error =
      "Use a path such as /customer/name or /items/0. Blank selects the complete output.";
  }
  return (
    <div className="workflow-field-path">
      <label>
        {label}
        <select
          value={
            options.some((o) => o.path === path) || path === ""
              ? path
              : "__custom"
          }
          onChange={(e) => {
            if (e.target.value !== "__custom") onChange(e.target.value);
          }}
        >
          <option value="">Complete output</option>
          {options.map((o) => (
            <option key={o.path} value={o.path}>
              {o.path} · {o.type}
            </option>
          ))}
          {path && !options.some((o) => o.path === path) && (
            <option value="__custom">Custom field path</option>
          )}
        </select>
      </label>
      <details>
        <summary>Custom field path</summary>
        <label>
          JSON Pointer
          <input
            value={path}
            maxLength={512}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={!!error}
          />
        </label>
        <HelpTooltip>
          Paths use / between fields and zero-based array indices. Use ~1 for a
          slash in a key and ~0 for a tilde. No expressions or code are
          evaluated.
        </HelpTooltip>
      </details>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </div>
  );
}
export function WorkflowMappingEditor({
  node,
  graph,
  runs,
  onChange,
}: {
  node: WorkflowNode;
  graph: WorkflowGraph;
  runs: { id: string; status: string; created_at: string }[];
  onChange: (data: Partial<WorkflowNode["data"]>) => void;
}) {
  const [sample, setSample] = useState("");
  const run = useQuery({
    queryKey: ["workflow-mapping-sample", sample],
    queryFn: () => requestJson<SampleRun>(`/workflow-runs/${sample}`),
    enabled: !!sample,
  });
  const ancestors = workflowAncestors(graph, node.id),
    sources = graph.nodes.filter((n) => ancestors.has(n.id));
  const outputs = Object.fromEntries(
    (run.data?.nodes ?? [])
      .filter((n) => n.status === "completed")
      .map((n) => [n.node_id, n.output]),
  );
  const mode = node.data.inputBindings?.length ? "fields" : "single";
  function options(source: string) {
    if (Object.hasOwn(outputs, source))
      return workflowFieldOptions(outputs[source]);
    if (graph.nodes.find((n) => n.id === source)?.type === "input")
      return (graph.inputFields ?? []).map((f) => ({
        path: "/" + f.name,
        type: f.type,
      }));
    return [];
  }
  const defaultSource =
    graph.edges.filter((e) => e.target === node.id).map((e) => e.source)[0] ??
    "";
  const selectedSource = node.data.inputFrom ?? defaultSource;
  let preview: unknown,
    previewError = "";
  if (run.data) {
    try {
      preview = resolveWorkflowMapping(node, graph, outputs);
    } catch (e) {
      previewError = (e as Error).message;
    }
  }
  const stale =
    !!run.data &&
    JSON.stringify(run.data.graph_snapshot) !== JSON.stringify(graph);
  return (
    <section className="configure-group workflow-mapping-editor">
      <div className="setting-label-row">
        <h4>Input mapping</h4>
        <HelpTooltip>
          Pass a complete upstream output, select one field, or assemble named
          fields from ancestors. Missing fields stop the step; there is no
          silent fallback. A source on a branch that did not execute is
          unavailable.
        </HelpTooltip>
      </div>
      <label>
        Mapping mode
        <select
          value={mode}
          onChange={(e) =>
            onChange(
              e.target.value === "fields"
                ? {
                    inputFrom: undefined,
                    inputPath: undefined,
                    inputArgument: undefined,
                    inputBindings: [
                      {
                        target: "value",
                        source: sources[0]?.id ?? "",
                        path: "",
                      },
                    ],
                  }
                : { inputBindings: undefined },
            )
          }
        >
          <option value="single">Single value or complete output</option>
          <option value="fields">
            Named fields{node.type === "tool" ? " → tool arguments" : ""}
          </option>
        </select>
      </label>
      {mode === "single" ? (
        <>
          <label>
            Source step
            <select
              value={node.data.inputFrom ?? ""}
              onChange={(e) =>
                onChange({
                  inputFrom: e.target.value || undefined,
                  inputPath: undefined,
                })
              }
            >
              <option value="">
                Connected predecessor
                {node.type === "merge" ? "s (merged object)" : ""}
              </option>
              {sources.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.data.label}
                </option>
              ))}
            </select>
          </label>
          <FieldPath
            path={node.data.inputPath ?? ""}
            onChange={(inputPath) =>
              onChange({ inputPath: inputPath || undefined })
            }
            options={
              node.type === "merge" && !node.data.inputFrom
                ? workflowFieldOptions(
                    Object.fromEntries(
                      graph.edges
                        .filter(
                          (e) =>
                            e.target === node.id &&
                            Object.hasOwn(outputs, e.source),
                        )
                        .map((e) => [e.source, outputs[e.source]]),
                    ),
                  )
                : options(selectedSource)
            }
            label="Select input field"
          />
        </>
      ) : (
        <>
          <p className="muted">
            {node.type === "tool"
              ? "Mapped fields override matching static tool arguments and retain their types."
              : "The next step receives an object containing these named fields."}
          </p>
          {node.data.inputBindings?.map((b, i) => (
            <fieldset className="configure-group" key={i}>
              <legend>Mapped field {i + 1}</legend>
              <label>
                Target field name
                <input
                  value={b.target}
                  maxLength={64}
                  onChange={(e) =>
                    onChange({
                      inputBindings: node.data.inputBindings!.map((x, j) =>
                        j === i ? { ...x, target: e.target.value } : x,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Source step
                <select
                  value={b.source}
                  onChange={(e) =>
                    onChange({
                      inputBindings: node.data.inputBindings!.map((x, j) =>
                        j === i
                          ? { ...x, source: e.target.value, path: "" }
                          : x,
                      ),
                    })
                  }
                >
                  <option value="">Choose an upstream step</option>
                  {sources.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.data.label}
                    </option>
                  ))}
                </select>
              </label>
              <FieldPath
                label="Select source field"
                path={b.path}
                options={options(b.source)}
                onChange={(path) =>
                  onChange({
                    inputBindings: node.data.inputBindings!.map((x, j) =>
                      j === i ? { ...x, path } : x,
                    ),
                  })
                }
              />
              <Button
                type="button"
                className="secondary"
                onClick={() =>
                  onChange({
                    inputBindings: node.data.inputBindings!.filter(
                      (_, j) => j !== i,
                    ),
                  })
                }
              >
                Remove mapped field
              </Button>
            </fieldset>
          ))}
          <Button
            type="button"
            className="secondary"
            disabled={(node.data.inputBindings?.length ?? 0) >= 20}
            onClick={() =>
              onChange({
                inputBindings: [
                  ...(node.data.inputBindings ?? []),
                  {
                    target: `field_${(node.data.inputBindings?.length ?? 0) + 1}`,
                    source: sources[0]?.id ?? "",
                    path: "",
                  },
                ],
              })
            }
          >
            Add mapped field
          </Button>
        </>
      )}
      <details className="workflow-mapping-preview">
        <summary>Preview mapped input</summary>
        <p className="muted">
          Uses recorded, potentially redacted outputs. No agents or tools are
          executed.
        </p>
        <label>
          Recorded run
          <select value={sample} onChange={(e) => setSample(e.target.value)}>
            <option value="">Select a run for sample values</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {new Date(r.created_at).toLocaleString()} · {r.status} ·{" "}
                {r.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        {run.isFetching && <p role="status">Loading recorded outputs…</p>}
        {run.error && <p role="alert">{run.error.message}</p>}
        {stale && (
          <p role="status">
            This run used a different graph. Sample values may differ from your
            next run.
          </p>
        )}
        {previewError && (
          <p role="alert">
            {previewError}. Check the source step and field path.
          </p>
        )}
        {run.data && !previewError && (
          <>
            <h5>Mapped input</h5>
            <pre>{pretty(preview)}</pre>
            {node.type === "agent" && (
              <details>
                <summary>Agent user-message preview</summary>
                <pre>
                  {node.data.prefix +
                    (typeof preview === "string"
                      ? preview
                      : JSON.stringify(preview)) +
                    node.data.suffix}
                </pre>
              </details>
            )}
            {node.type === "tool" && (
              <>
                <h5>Tool arguments preview</h5>
                <pre>{pretty(workflowToolArguments(node, preview))}</pre>
              </>
            )}
          </>
        )}
      </details>
    </section>
  );
}
