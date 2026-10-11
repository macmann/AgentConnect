"use client";
import {
  workflowPresentation,
  workflowValue,
  workflowFieldLabel,
} from "@agentconnect/schemas/workflow-results";
export function WorkflowResult({
  output,
  title = "Result",
  summary = "",
  format = "auto",
}: {
  output: unknown;
  title?: string;
  summary?: string;
  format?: "auto" | "text" | "json";
}) {
  const p = workflowPresentation(output, format);
  return (
    <section aria-label={title} className="generated-block">
      <h4>{title}</h4>
      {summary && <p>{summary}</p>}
      {p.kind === "fields" && (
        <dl>
          {p.fields?.map((f, index) => (
            <div key={index}>
              <dt>
                <strong>{f.label}</strong>
              </dt>
              <dd
                style={{
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  margin: "0 0 12px",
                }}
              >
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {p.kind === "table" && (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                {p.columns?.map((c) => (
                  <th key={c} scope="col">
                    {workflowFieldLabel(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {p.rows?.map((r, i) => (
                <tr key={i}>
                  {p.columns?.map((c) => (
                    <td key={c}>{workflowValue(r[c])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {p.truncated && (
            <p>
              Showing the first 100 results. Full output is available below.
            </p>
          )}
        </div>
      )}
      {["text", "json"].includes(p.kind) && (
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {p.text}
        </pre>
      )}
      {["table", "fields"].includes(p.kind) && (
        <details>
          <summary>View full output</summary>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {workflowValue(output)}
          </pre>
        </details>
      )}
    </section>
  );
}
