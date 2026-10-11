"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { requestJson, apiBase } from "./agent-client";
import { Button } from "./button";
export type Insights = {
  range: { from: string; to: string };
  summary: Record<string, number>;
  searches: Record<string, number>;
  categories: Record<string, unknown>[];
  trends: Record<string, unknown>[];
  agents: Record<string, unknown>[];
  operators: Record<string, unknown>[];
  failures: Record<string, unknown>[];
  definitions: Record<string, string>;
};
export function Table({ rows }: { rows: Record<string, unknown>[] }) {
  if (!rows.length) return <p className="muted">No data in this date range.</p>;
  const keys = Object.keys(rows[0]!);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {keys.map((k) => (
              <th key={k}>{k.replaceAll("_", " ")}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {keys.map((k) => (
                <td key={k}>{r[k] === null ? "Unavailable" : String(r[k])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function CustomerInsights({ workspaceId }: { workspaceId: string }) {
  const today = new Date().toISOString().slice(0, 10),
    initialFrom = new Date(Date.now() - 29 * 86400000)
      .toISOString()
      .slice(0, 10),
    [from, setFrom] = useState(initialFrom),
    [to, setTo] = useState(today),
    [range, setRange] = useState({
      from: initialFrom + "T00:00:00.000Z",
      to: new Date(Date.parse(today + "T00:00:00Z") + 86400000).toISOString(),
    }),
    [error, setError] = useState("");
  const query = new URLSearchParams(range).toString(),
    base = `/workspaces/${workspaceId}/operations`,
    stats = useQuery({
      queryKey: ["customer-insights", workspaceId, range],
      queryFn: () => requestJson<Insights>(base + "/insights?" + query),
    });
  return (
    <section className="customer-insights">
      <h3>Customer insights and reports</h3>
      <p className="muted">
        Reports use retained records and UTC dates. The end date below includes
        the whole day.
      </p>
      <div className="report-range">
        <label>
          From date
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          Through date
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <Button
          type="button"
          onClick={() => {
            const start = Date.parse(from + "T00:00:00Z"),
              end = Date.parse(to + "T00:00:00Z") + 86400000;
            if (
              !Number.isFinite(start) ||
              !Number.isFinite(end) ||
              end <= start ||
              end - start > 366 * 86400000
            ) {
              setError("Choose a date range of up to 366 days.");
              return;
            }
            setError("");
            setRange({
              from: new Date(start).toISOString(),
              to: new Date(end).toISOString(),
            });
          }}
        >
          Apply dates
        </Button>
        <Button
          className="secondary"
          type="button"
          disabled={!stats.data}
          onClick={async () => {
            setError("");
            try {
              const r = await fetch(
                apiBase + base + "/insights.xlsx?" + query,
                { credentials: "include" },
              );
              if (!r.ok) throw new Error("Unable to export report");
              const url = URL.createObjectURL(await r.blob()),
                a = document.createElement("a");
              a.href = url;
              a.download = "agentconnect-insights.xlsx";
              a.click();
              URL.revokeObjectURL(url);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Export Excel
        </Button>
      </div>
      {(error || stats.error) && (
        <p role="alert">{error || stats.error?.message}</p>
      )}
      {stats.isPending ? (
        <p role="status">Loading report…</p>
      ) : (
        stats.data && (
          <>
            <Table rows={[{ ...stats.data.summary, ...stats.data.searches }]} />
            {(
              [
                "categories",
                "trends",
                "agents",
                "operators",
                "failures",
              ] as const
            ).map((k) => (
              <details key={k} open={k === "trends"}>
                <summary>
                  {
                    {
                      categories: "Enquiry categories",
                      trends: "Daily conversation trends",
                      agents: "AI agent usage",
                      operators: "Operator presence utilization",
                      failures: "Failed searches and responses",
                    }[k]
                  }
                </summary>
                <Table rows={stats.data![k]} />
              </details>
            ))}
            <details>
              <summary>Metric definitions</summary>
              {Object.entries(stats.data.definitions).map(([key, value]) => (
                <p key={key}>{value}</p>
              ))}
            </details>
          </>
        )
      )}
    </section>
  );
}
