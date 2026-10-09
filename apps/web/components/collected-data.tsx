"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { requestJson } from "./agent-client";
import { Button } from "./button";
type Submission = {
  id: string;
  conversation_id: string;
  block_id: string;
  agent_name: string;
  created_at: string;
  values: Record<string, unknown>;
};
export function CollectedData({ workspaceId }: { workspaceId: string }) {
  const [search, setSearch] = useState(""),
    [cursor, setCursor] = useState(""),
    [beforeId, setBeforeId] = useState(""),
    [previous, setPrevious] = useState<Submission[]>([]);
  const query = useQuery({
    queryKey: ["collected-data", workspaceId, search, cursor, beforeId],
    queryFn: () =>
      requestJson<Submission[]>(
        `/workspaces/${workspaceId}/collected-data?${new URLSearchParams({ search, ...(cursor ? { before: cursor, beforeId } : {}) })}`,
      ),
  });
  const rows = [...previous, ...(query.data ?? [])];
  function exportData() {
    const blob = new Blob([JSON.stringify(rows, null, 2)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = "collected-data.json";
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h3>Collected data</h3>
          <p>Confirmed submissions from generated forms and actions.</p>
        </div>
        <Button
          type="button"
          className="secondary"
          disabled={!rows.length}
          onClick={exportData}
        >
          Export loaded records
        </Button>
      </div>
      <div className="studio-form">
        <label>
          Search values
          <input
            value={search}
            maxLength={120}
            onChange={(e) => {
              setSearch(e.target.value);
              setCursor("");
              setBeforeId("");
              setPrevious([]);
            }}
          />
        </label>
        {query.isPending && <p role="status">Loading submissions…</p>}
        {query.error && (
          <p role="alert" className="error">
            {query.error.message}
          </p>
        )}
        {rows.map((row) => (
          <details className="generated-block" key={row.id}>
            <summary>
              {row.agent_name} · {row.block_id} ·{" "}
              {new Date(row.created_at).toLocaleString()}
            </summary>
            <p className="muted">Conversation: {row.conversation_id}</p>
            <dl>
              {Object.entries(row.values).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{String(value ?? "")}</dd>
                </div>
              ))}
            </dl>
          </details>
        ))}
        {query.data?.length === 0 && !previous.length && (
          <div className="empty">
            <h4>No submissions yet</h4>
            <p>
              Enable generative responses on an agent, ask for a form and submit
              it in the playground.
            </p>
          </div>
        )}
        {query.data?.length === 100 && (
          <Button
            type="button"
            onClick={() => {
              const last = rows.at(-1)!;
              setPrevious(rows);
              setCursor(last.created_at);
              setBeforeId(last.id);
            }}
          >
            Load more
          </Button>
        )}
      </div>
    </section>
  );
}
