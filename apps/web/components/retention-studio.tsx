"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { permitted, type Role } from "@agentconnect/schemas/foundation";
import { requestJson } from "./agent-client";
import {
  WorkspaceSections,
  WorkspaceSaveBar,
  useWorkspaceSection,
  useWorkspaceLeaveGuard,
} from "./workspace-sections";
import { Button } from "./button";

const fields = [
  [
    "conversationDays",
    "conversation_days",
    "Conversations",
    "Days since last activity. Deletes messages, reviews, forms and attached files.",
  ],
  [
    "runDays",
    "run_days",
    "Runs",
    "Days after completion. Agent runs include their messages and files; workflows include checkpoints. Referenced evaluation baselines stay available.",
  ],
  [
    "artifactDays",
    "artifact_days",
    "Generated files",
    "Days since creation. Removes file downloads while keeping the message.",
  ],
  [
    "connectorDays",
    "connector_days",
    "Connector history",
    "Days after completion. Keeps connectors, imported knowledge and sync fingerprints.",
  ],
] as const;
type Settings = {
  enabled: boolean;
  revision: number;
  conversation_days: number | null;
  run_days: number | null;
  artifact_days: number | null;
  connector_days: number | null;
  next_run_at: string | null;
};
type History = {
  id: string;
  status: string;
  trigger_kind: string;
  policy_revision: number;
  counts: Record<string, number>;
  created_at: string;
  error_code: string | null;
};
type State = {
  policy: Settings;
  objects: { pending: number; blocked: number };
  history: History[];
};
type Preview = {
  revision: number;
  asOf: string;
  batchLimit: number;
  counts: Record<string, number>;
};
const countNames: Record<string, string> = {
  conversations: "Conversations",
  agentRuns: "Agent runs",
  workflowRuns: "Workflow runs",
  evaluationRuns: "Evaluation runs",
  artifacts: "Generated files",
  connectorSyncs: "Connector syncs",
  messages: "Messages",
};
export function RetentionStudio({
  workspaceId,
  role,
}: {
  workspaceId: string;
  role: Role;
}) {
  const base = `/workspaces/${workspaceId}/retention`,
    cache = useQueryClient(),
    canRead = permitted(role, "retention:read"),
    canManage = permitted(role, "retention:manage");
  const [section, setSection] = useWorkspaceSection(
    "retentionSection",
    "policy",
    canManage ? ["policy", "preview", "history"] : ["policy", "history"],
  );
  const query = useQuery({
    queryKey: ["retention", workspaceId],
    queryFn: () => requestJson<State>(base),
    enabled: canRead,
    refetchInterval: 5000,
  });
  const [draft, setDraft] = useState<Settings | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const policy = draft ?? query.data?.policy;
  const dirty =
    !!draft &&
    (draft.enabled !== query.data?.policy.enabled ||
      fields.some(([, key]) => draft[key] !== query.data?.policy[key]));
  useWorkspaceLeaveGuard(dirty);
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      await cache.invalidateQueries({ queryKey: ["retention", workspaceId] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retention request failed");
    } finally {
      setBusy(false);
    }
  }
  if (!canRead)
    return (
      <p className="empty">
        Ask a workspace administrator to review retention settings.
      </p>
    );
  if (query.isPending)
    return <p className="empty">Loading retention settings…</p>;
  if (query.error || !policy)
    return (
      <p role="alert" className="error">
        {query.error?.message ?? "Retention settings unavailable"}
      </p>
    );
  return (
    <div className="retention-studio">
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Data retention</h2>
            <p>
              Keep data for as long as you need it. Cleanup is off until an
              administrator enables it.
            </p>
          </div>
          <span className="badge">
            {query.data?.policy.enabled
              ? "Daily cleanup enabled"
              : "Cleanup paused"}
          </span>
        </div>
        {(error || notice) && (
          <p
            role={error ? "alert" : "status"}
            className={error ? "error" : "success"}
          >
            {error || notice}
          </p>
        )}
        <WorkspaceSections
          label="Retention sections"
          value={section}
          onChange={setSection}
          sections={[
            {
              id: "policy",
              label: "Retention policy",
              description:
                "Choose how long to keep data. Cleanup remains paused until explicitly enabled.",
            },
            ...(canManage
              ? [
                  {
                    id: "preview",
                    label: "Preview & cleanup",
                    description:
                      "Preview the saved policy and confirm permanent removal before running cleanup.",
                  },
                ]
              : []),
            {
              id: "history",
              label: "Cleanup history",
              description: "Review actual cleanup results and failures.",
            },
          ]}
        />
        <div hidden={section !== "policy"} className="workspace-section-body">
          <form
            className="retention-settings"
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                const body = {
                  enabled: policy.enabled,
                  revision: policy.revision,
                  ...Object.fromEntries(
                    fields.map(([input, key]) => [input, policy[key]]),
                  ),
                };
                await requestJson(base, "PUT", body);
                setDraft(null);
                setPreview(null);
                setConfirmed(false);
                setNotice("Retention settings saved.");
              });
            }}
          >
            <div className="retention-fields">
              {fields.map(([, key, label, description]) => (
                <label key={key}>
                  <strong>{label}</strong>
                  <span>{description}</span>
                  <input
                    aria-label={`${label} retention days`}
                    type="number"
                    min="1"
                    max="36500"
                    step="1"
                    placeholder="Keep indefinitely"
                    value={policy[key] ?? ""}
                    disabled={!canManage || busy}
                    onChange={(e) => {
                      setDraft({
                        ...policy,
                        [key]:
                          e.target.value === "" ? null : Number(e.target.value),
                      });
                      setPreview(null);
                      setConfirmed(false);
                    }}
                  />
                  <small>Leave blank to keep indefinitely.</small>
                </label>
              ))}
            </div>
            <label className="retention-toggle">
              <input
                type="checkbox"
                checked={policy.enabled}
                disabled={!canManage || busy}
                onChange={(e) => {
                  setDraft({ ...policy, enabled: e.target.checked });
                  setPreview(null);
                  setConfirmed(false);
                }}
              />{" "}
              Enable automatic daily cleanup
            </label>
            <p>
              Active runs and pending or active human handoffs are protected.
              Audit records and knowledge bases are retained. Shorter periods
              permanently remove more history, including content used as agent
              context.
            </p>
            {canManage ? (
              <WorkspaceSaveBar>
                <span>{dirty ? "Unsaved changes" : "Saved"} </span>
                <div className="studio-actions">
                  <Button
                    className="secondary"
                    type="button"
                    disabled={busy || !dirty}
                    onClick={() => {
                      setDraft(null);
                      setPreview(null);
                      setConfirmed(false);
                    }}
                  >
                    Discard
                  </Button>
                  <Button disabled={busy || !dirty} type="submit">
                    Save retention settings
                  </Button>
                </div>
              </WorkspaceSaveBar>
            ) : (
              <p>
                Only workspace administrators can change settings or run
                cleanup.
              </p>
            )}
          </form>
        </div>
      </section>
      {canManage && (
        <section className="panel" hidden={section !== "preview"}>
          <div className="panel-header">
            <div>
              <h3>Preview cleanup</h3>
              <p>
                Preview saved settings before running a batch. New activity can
                change eligibility.
              </p>
            </div>
            <Button
              disabled={busy || dirty || !query.data?.policy.revision}
              onClick={() =>
                void action(async () => {
                  setPreview(
                    await requestJson<Preview>(base + "/preview", "POST", {
                      revision: policy.revision,
                    }),
                  );
                  setConfirmed(false);
                })
              }
            >
              Preview next batch
            </Button>
          </div>
          {preview ? (
            <div className="retention-preview">
              <p>
                Previewed {new Date(preview.asOf).toLocaleString()}. Up to{" "}
                {preview.batchLimit} roots per category, plus their related
                data.
              </p>
              <div className="retention-counts">
                {Object.entries(preview.counts).map(([name, count]) => (
                  <div key={name}>
                    <strong>{count}</strong>
                    <span>{countNames[name] ?? name}</span>
                  </div>
                ))}
              </div>
              <label className="retention-toggle">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />{" "}
                I understand that cleanup permanently removes eligible data.
              </label>
              <Button
                disabled={
                  busy ||
                  !!draft ||
                  !confirmed ||
                  !query.data?.policy.enabled ||
                  preview.revision !== policy.revision ||
                  query.data?.history.some((r) => r.status === "queued")
                }
                onClick={() =>
                  void action(async () => {
                    await requestJson(base + "/run", "POST", {
                      revision: preview.revision,
                    });
                    setPreview(null);
                    setConfirmed(false);
                    setNotice(
                      "Cleanup queued. The worker will process it and record the result below.",
                    );
                  })
                }
              >
                Run cleanup batch
              </Button>
              {!query.data?.policy.enabled && (
                <p>Enable and save cleanup to run this policy.</p>
              )}
            </div>
          ) : (
            <p className="empty">
              Save your settings, then preview eligible data. Preview does not
              delete anything.
            </p>
          )}
        </section>
      )}
      <section className="panel" hidden={section !== "history"}>
        <div className="panel-header">
          <div>
            <h3>Cleanup status</h3>
            <p>
              Next scheduled batch:{" "}
              {query.data?.policy.next_run_at
                ? new Date(query.data.policy.next_run_at).toLocaleString()
                : "Not scheduled"}
              . Files awaiting storage deletion:{" "}
              {query.data?.objects.pending ?? 0}.
            </p>
          </div>
        </div>
        {!!query.data?.objects.blocked && (
          <p role="alert" className="error">
            {query.data.objects.blocked} file deletion jobs need administrator
            investigation because their storage references are invalid.
          </p>
        )}
        {!query.data?.history.length ? (
          <p className="empty">
            No cleanup has run yet. Completed batches will appear here and in
            the audit trail.
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Requested</th>
                  <th>Source</th>
                  <th>Policy</th>
                  <th>Status</th>
                  <th>Deleted</th>
                </tr>
              </thead>
              <tbody>
                {query.data.history.map((run) => (
                  <tr key={run.id}>
                    <td>{new Date(run.created_at).toLocaleString()}</td>
                    <td>{run.trigger_kind}</td>
                    <td>Revision {run.policy_revision}</td>
                    <td>
                      {run.status}
                      {run.error_code && ` · ${run.error_code}`}
                    </td>
                    <td>
                      {Object.entries(run.counts)
                        .filter(([, count]) => count > 0)
                        .map(
                          ([name, count]) =>
                            `${count} ${countNames[name] ?? name}`,
                        )
                        .join(", ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
