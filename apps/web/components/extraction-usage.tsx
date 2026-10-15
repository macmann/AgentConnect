"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { requestJson } from "./agent-client";
import { HelpTooltip } from "./help-tooltip";
type Usage = {
  rows: {
    id: string;
    source_revision: number;
    attempt: number;
    stage: string;
    page: number | null;
    model_name: string | null;
    status: string;
    input_tokens: number | null;
    output_tokens: number | null;
    estimated_cost_usd: number | null;
    duration_ms: number | null;
    error_code: string | null;
    trace_id: string;
    started_at: string;
  }[];
  truncated: boolean;
  summary: {
    events: number;
    cache_hits: number;
    failures: number;
    running: number;
    model_attempts: number;
    reported_input_tokens: number | null;
    reported_output_tokens: number | null;
    known_estimated_cost_usd: number | null;
    unknown_cost_events: number;
  };
};
export function ExtractionUsage({
  knowledgeBaseId,
  sourceId,
}: {
  knowledgeBaseId: string;
  sourceId: string;
}) {
  const [open, setOpen] = useState(false);
  const data = useQuery({
    queryKey: ["extraction-usage", knowledgeBaseId, sourceId],
    queryFn: () =>
      requestJson<Usage>(
        `/knowledge-bases/${knowledgeBaseId}/sources/${sourceId}/extraction/usage`,
      ),
    enabled: open,
    refetchInterval: open ? 5000 : false,
  });
  const summary = data.data?.summary;
  return (
    <details
      className="extraction-usage"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>Extraction usage &amp; tracing</summary>
      <p>
        Vision extraction and assisted boundaries{" "}
        <HelpTooltip label="About extraction usage">
          Includes all revisions and retry attempts for this source. Cache hits
          and correction reuse make no model call. Estimates use the workspace
          model prices at call time; unknown costs are excluded from the known
          subtotal. Embeddings, native OCR and provider-specific image
          surcharges are not included. Trace IDs correlate with Langfuse when
          tracing is enabled.
        </HelpTooltip>
      </p>
      {data.isPending && open && <p role="status">Loading usage…</p>}
      {data.error && <p role="alert">{data.error.message}</p>}
      {summary && (
        <>
          <p>
            {summary.model_attempts} model attempts · {summary.cache_hits} cache
            hits · {summary.failures} failures · {summary.running} running
          </p>
          <p>
            Reported tokens: {summary.reported_input_tokens ?? "Unknown"} input
            / {summary.reported_output_tokens ?? "Unknown"} output · Known
            estimated cost:{" "}
            {summary.known_estimated_cost_usd === null
              ? "Unknown"
              : `$${summary.known_estimated_cost_usd.toFixed(6)}`}{" "}
            {summary.unknown_cost_events > 0 &&
              `(${summary.unknown_cost_events} events with unknown cost)`}
          </p>
          {!summary.events && (
            <p>
              No model extraction events recorded for this source. Native
              parsing and OCR do not make a generation call.
            </p>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Revision / attempt</th>
                  <th>Stage / page</th>
                  <th>Model</th>
                  <th>Status</th>
                  <th>Tokens in / out</th>
                  <th>Estimate USD</th>
                  <th>Duration</th>
                  <th>Trace</th>
                </tr>
              </thead>
              <tbody>
                {data.data!.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.source_revision} / {row.attempt}
                    </td>
                    <td>
                      {row.stage}
                      {row.page !== null && ` / ${row.page}`}
                    </td>
                    <td>{row.model_name ?? "No model call"}</td>
                    <td>
                      {row.status}
                      {row.error_code && <small> · {row.error_code}</small>}
                    </td>
                    <td>
                      {row.input_tokens ?? "?"} / {row.output_tokens ?? "?"}
                    </td>
                    <td>{row.estimated_cost_usd?.toFixed(6) ?? "Unknown"}</td>
                    <td>
                      {row.duration_ms === null ? "—" : `${row.duration_ms} ms`}
                    </td>
                    <td>
                      <code>{row.trace_id || "Tracing not enabled"}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.data!.truncated && (
            <p>Showing the latest 1,000 events; totals include all events.</p>
          )}
        </>
      )}
    </details>
  );
}
