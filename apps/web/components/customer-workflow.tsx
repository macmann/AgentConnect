"use client";
import { useEffect, useState } from "react";
import type { QuickAction } from "@agentconnect/schemas/bank-experience";
import { apiBase } from "./agent-client";
import { WorkflowResult } from "./workflow-result";
import { Button } from "./button";
type Run = {
  id: string;
  status: string;
  output?: unknown;
  name?: string;
  resultTitle?: string;
  resultSummary?: string;
  resultFormat?: "auto" | "text" | "json";
  progress?: { completed: number; active: string[] };
  steps?: {
    label: string;
    status: string;
    attempts?: number;
    retry_at?: string | null;
  }[];
  error_code?: string;
};
export function CustomerWorkflow({
  base,
  conversationId,
  token,
  action,
  onClose,
}: {
  base: string;
  conversationId: string;
  token: string;
  action: QuickAction | null;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<Run[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const path = `${apiBase}${base}/conversations/${conversationId}/workflows`;
  useEffect(() => {
    setRequestId(crypto.randomUUID());
  }, [action?.id]);
  async function request(suffix = "", body?: unknown) {
    const r = await fetch(path + suffix, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: "Bearer " + token,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ?? "Workflow unavailable");
    return d;
  }
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const items: Run[] = await request();
        const details = await Promise.all(
          items.slice(0, 20).map((r) => request("/" + r.id)),
        );
        if (active) {
          setRuns(details);
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    }
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [path, token]);
  return (
    <section aria-label="Conversation workflows" className="generated-block">
      {action && (
        <form
          className="generated-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget),
              values: Record<string, unknown> = {};
            for (const f of action.workflowFields ?? []) {
              const v = form.get(f.name);
              if (f.type === "checkbox") values[f.name] = v === "on";
              else if (v !== "" && v !== null)
                values[f.name] = f.type === "number" ? Number(v) : v;
            }
            setBusy(true);
            setError("");
            try {
              const r = await request("", {
                actionId: action.id,
                values,
                requestId,
              });
              setRuns((old) =>
                old.some((item) => item.id === r.id) ? old : [r, ...old],
              );
              onClose();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h4>{action.label}</h4>
          {(action.workflowFields ?? []).map((f) => (
            <label key={f.name}>
              {f.label}
              {f.type === "select" ? (
                <select
                  aria-label={f.label}
                  name={f.name}
                  required={f.required}
                >
                  <option value="">Choose an option</option>
                  {f.options?.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : f.type === "textarea" ? (
                <textarea
                  name={f.name}
                  required={f.required}
                  maxLength={4000}
                />
              ) : (
                <input
                  name={f.name}
                  type={f.type}
                  required={f.required}
                  min={f.min}
                  max={f.max}
                  maxLength={4000}
                />
              )}
            </label>
          ))}
          <p className="muted">
            Runs this published workflow with the details you provide. Inputs
            are saved with your conversation.
          </p>
          <Button disabled={busy}>
            {busy ? "Starting…" : "Start workflow"}
          </Button>
          <Button type="button" className="secondary" onClick={onClose}>
            Cancel
          </Button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {runs.map((r) => (
        <details
          key={r.id}
          open={
            !["completed", "failed", "cancelled", "rejected"].includes(r.status)
          }
        >
          <summary>
            Workflow ·{" "}
            {r.status === "waiting" ? "Waiting for staff approval" : r.status}
          </summary>
          {r.name && <h4>{r.name}</h4>}
          {r.progress && (
            <p>
              {r.progress.completed} steps completed
              {r.progress.active.length
                ? " · Working on " + r.progress.active.join(", ")
                : ""}
            </p>
          )}
          <ol>
            {r.steps?.map((s, i) => (
              <li key={i}>
                {s.label}:{" "}
                {s.retry_at ? "Retrying a temporary failure" : s.status}
                {(s.attempts ?? 0) > 1 ? ` · ${s.attempts} attempts` : ""}
              </li>
            ))}
          </ol>
          {r.status === "completed" && (
            <WorkflowResult
              output={r.output}
              title={r.resultTitle}
              summary={r.resultSummary}
              format={r.resultFormat}
            />
          )}
          {r.error_code && (
            <p role="alert">
              Unable to complete this workflow. Please contact support.
            </p>
          )}
        </details>
      ))}
    </section>
  );
}
