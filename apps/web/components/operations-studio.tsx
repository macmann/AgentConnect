"use client";
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { permitted, type Role } from "@agentconnect/schemas/foundation";
import { requestJson } from "./agent-client";
import { Button } from "./button";
type Analytics = {
  summary: {
    runs: number;
    completed: number;
    failed: number;
    conversations: number;
    input_tokens: number | null;
    output_tokens: number | null;
    unknown_usage: number;
    average_latency_ms: number | null;
    estimated_cost_usd: number | null;
    unpriced_runs: number;
  };
  feedback: {
    reviews: number;
    likes: number;
    dislikes: number;
    corrections: number;
  };
  agents: {
    id: string;
    name: string;
    runs: number;
    failed: number;
    input_tokens: number | null;
    output_tokens: number | null;
    estimated_cost_usd: number | null;
  }[];
  workflows: {
    id: string;
    name: string;
    runs: number;
    completed: number;
    failed: number;
    average_latency_ms: number | null;
  }[];
};
type Key = {
  id: string;
  label: string;
  prefix: string;
  agent_id: string;
  scope: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};
type Hook = { id: string; name: string; url: string; enabled: boolean };
type Deployment = {
  id: string;
  name: string;
  agent_id: string;
  version_id: string;
  environment: string;
  enabled: boolean;
  version: number;
};
const cost = (value: number | null) =>
  value === null ? "Unavailable" : `$${value.toFixed(6)}`;
export function OperationsStudio({
  workspaceId,
  role,
}: {
  workspaceId: string;
  role: string;
}) {
  const cache = useQueryClient(),
    base = `/workspaces/${workspaceId}/operations`;
  const canAudit = permitted(role as Role, "audit:view");
  const [auditAction, setAuditAction] = useState("");
  const audit = useQuery({
    queryKey: ["operations-audit", workspaceId, auditAction],
    queryFn: () =>
      requestJson<
        {
          id: string;
          action: string;
          actor: string;
          entity_id: string | null;
          created_at: string;
        }[]
      >(
        `${base}/audit${auditAction ? `?action=${encodeURIComponent(auditAction)}` : ""}`,
      ),
    enabled: canAudit,
  });
  const canView = permitted(role as Role, "operations:view"),
    canManage = permitted(role as Role, "operations:manage");
  const [tab, setTab] = useState("Analytics"),
    [days, setDays] = useState(30),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [oneTime, setOneTime] = useState("");
  const stats = useQuery({
    queryKey: ["operations", workspaceId, days],
    queryFn: () => requestJson<Analytics>(`${base}/analytics?days=${days}`),
    enabled: canView,
  });
  const models = useQuery({
    queryKey: ["models", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(
        `/workspaces/${workspaceId}/models`,
      ),
    enabled: canManage,
  });
  const agents = useQuery({
    queryKey: ["agents", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(
        `/workspaces/${workspaceId}/agents`,
      ),
    enabled: canManage,
  });
  const prices = useQuery({
    queryKey: ["prices", workspaceId],
    queryFn: () =>
      requestJson<
        {
          model_id: string;
          name: string;
          input_usd_per_million: string;
          output_usd_per_million: string;
        }[]
      >(`${base}/prices`),
    enabled: canView,
  });
  const keys = useQuery({
    queryKey: ["api-keys", workspaceId],
    queryFn: () => requestJson<Key[]>(`${base}/api-keys`),
    enabled: canManage,
  });
  const hooks = useQuery({
    queryKey: ["webhooks", workspaceId],
    queryFn: () => requestJson<Hook[]>(`${base}/webhooks`),
    enabled: canManage,
  });
  const deliveries = useQuery({
    queryKey: ["webhook-deliveries", workspaceId],
    queryFn: () =>
      requestJson<
        {
          id: string;
          webhook_id: string;
          status: string;
          attempts: number;
          http_status: number | null;
          error_code: string | null;
        }[]
      >(`${base}/webhook-deliveries`),
    enabled: canManage,
    refetchInterval: tab === "Webhooks" ? 10000 : false,
  });
  const members = useQuery({
    queryKey: ["members", workspaceId],
    queryFn: () =>
      requestJson<
        {
          id: string;
          name: string;
          email: string;
          role: string;
          workspace_id: string | null;
        }[]
      >(`/workspaces/${workspaceId}/members`),
    enabled: canManage,
  });
  const deployments = useQuery({
    queryKey: ["operations-deployments", workspaceId],
    queryFn: () => requestJson<Deployment[]>(`${base}/deployments`),
    enabled: canView,
  });
  async function mutate(task: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
      await cache.invalidateQueries();
      setNotice(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function form(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    return new FormData(event.currentTarget);
  }
  if (!canView)
    return (
      <section className="panel">
        <div className="empty">
          <h3>Operations access required</h3>
          <p>Ask an administrator for an analyst, operator or builder role.</p>
        </div>
      </section>
    );
  const activeError =
    tab === "Analytics"
      ? stats.error
      : tab === "Pricing"
        ? prices.error
        : tab === "API keys"
          ? keys.error
          : tab === "Webhooks"
            ? hooks.error
            : tab === "Members"
              ? members.error
              : deployments.error;
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h3>Workspace operations</h3>
          <p>Review usage, manage access and connect your published work.</p>
        </div>
        <Button
          type="button"
          className="secondary"
          onClick={() => {
            void cache.invalidateQueries();
          }}
        >
          Refresh
        </Button>
      </div>
      <div
        className="studio-tabs"
        role="tablist"
        aria-label="Operations sections"
      >
        {[
          "Analytics",
          "Pricing",
          ...(canManage ? ["API keys", "Webhooks", "Members"] : []),
          "Deployments",
          ...(canAudit ? ["Audit"] : []),
        ].map((t) => (
          <button
            type="button"
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? "active" : ""}
            onClick={() => {
              setTab(t);
              setError("");
              setNotice("");
              setOneTime("");
            }}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="studio-form operations-content">
        {(error || activeError) && (
          <p className="error-banner" role="alert">
            {error || activeError?.message}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {oneTime && (
          <div className="operations-secret" role="status">
            <strong>Copy this secret now. It is displayed only once.</strong>
            <code>{oneTime}</code>
            <Button
              type="button"
              className="secondary"
              onClick={() => setOneTime("")}
            >
              Dismiss secret
            </Button>
          </div>
        )}
        {tab === "Analytics" && (
          <>
            <label className="operations-period">
              Reporting period
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                <option value={7}>Last 7 days</option>
                <option value={30}>Last 30 days</option>
                <option value={90}>Last 90 days</option>
              </select>
            </label>
            {stats.isPending ? (
              <p role="status">Loading analytics…</p>
            ) : (
              stats.data && (
                <>
                  <div className="operations-metrics">
                    {[
                      ["Conversations", stats.data.summary.conversations],
                      ["Agent runs", stats.data.summary.runs],
                      ["Completed runs", stats.data.summary.completed],
                      ["Failed runs", stats.data.summary.failed],
                      [
                        "Input tokens",
                        stats.data.summary.input_tokens ?? "Unknown",
                      ],
                      [
                        "Output tokens",
                        stats.data.summary.output_tokens ?? "Unknown",
                      ],
                      [
                        "Average latency",
                        stats.data.summary.average_latency_ms === null
                          ? "Unavailable"
                          : `${Math.round(stats.data.summary.average_latency_ms)} ms`,
                      ],
                      [
                        "Estimated model cost",
                        cost(stats.data.summary.estimated_cost_usd),
                      ],
                    ].map(([label, value]) => (
                      <div className="operations-metric" key={label}>
                        <span>{label}</span>
                        <strong>{value}</strong>
                      </div>
                    ))}
                  </div>
                  <p className="muted">
                    {stats.data.summary.unpriced_runs} runs lack complete
                    pricing or usage. {stats.data.summary.unknown_usage} runs
                    have unknown provider usage. Cost covers priced agent runs
                    and excludes workflow, embedding and tool charges.
                  </p>
                  <h4>Feedback</h4>
                  <p>
                    {stats.data.feedback.likes} likes ·{" "}
                    {stats.data.feedback.dislikes} dislikes ·{" "}
                    {stats.data.feedback.corrections} corrections ·{" "}
                    {stats.data.feedback.reviews} review records
                  </p>
                  <h4>Agent usage</h4>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Agent</th>
                          <th>Runs</th>
                          <th>Failures</th>
                          <th>Estimated cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats.data.agents.map((a) => (
                          <tr key={a.id}>
                            <td>{a.name}</td>
                            <td>{a.runs}</td>
                            <td>{a.failed}</td>
                            <td>{cost(a.estimated_cost_usd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!stats.data.agents.length && (
                    <p className="empty">
                      Run an agent in the playground to see usage here.
                    </p>
                  )}
                  <h4>Workflow outcomes</h4>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Workflow</th>
                          <th>Runs</th>
                          <th>Completed</th>
                          <th>Failed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats.data.workflows.map((w) => (
                          <tr key={w.id}>
                            <td>{w.name}</td>
                            <td>{w.runs}</td>
                            <td>{w.completed}</td>
                            <td>{w.failed}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )
            )}
          </>
        )}
        {tab === "Pricing" && (
          <>
            <h4>Model cost estimates</h4>
            <p className="muted">
              Enter USD rates per million tokens from your provider. Rates are
              saved on agent runs at completion; changing prices does not
              rewrite historical estimates.
            </p>
            {canManage && (
              <form
                className="form-grid"
                onSubmit={(e) => {
                  const f = form(e);
                  void mutate(
                    () =>
                      requestJson(`${base}/prices`, "PUT", {
                        modelId: f.get("modelId"),
                        inputUsdPerMillion: Number(f.get("input")),
                        outputUsdPerMillion: Number(f.get("output")),
                      }),
                    "Pricing saved",
                  );
                }}
              >
                <label>
                  Model
                  <select name="modelId" required>
                    {models.data?.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Input USD / million tokens
                  <input
                    name="input"
                    type="number"
                    min={0}
                    max={10000}
                    step="0.000001"
                    required
                  />
                </label>
                <label>
                  Output USD / million tokens
                  <input
                    name="output"
                    type="number"
                    min={0}
                    max={10000}
                    step="0.000001"
                    required
                  />
                </label>
                <Button disabled={busy || !models.data?.length}>
                  Save pricing
                </Button>
              </form>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Input USD / million</th>
                    <th>Output USD / million</th>
                  </tr>
                </thead>
                <tbody>
                  {prices.data?.map((p) => (
                    <tr key={p.model_id}>
                      <td>{p.name}</td>
                      <td>{p.input_usd_per_million}</td>
                      <td>{p.output_usd_per_million}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {prices.data?.length === 0 && (
              <p className="empty">
                No pricing configured. Unknown costs are shown as unavailable.
              </p>
            )}
          </>
        )}
        {tab === "API keys" && (
          <>
            <h4>Agent API keys</h4>
            <p className="muted">
              Each key can execute one agent in this workspace. Keys use the
              issuer’s current permissions, expire automatically and can be
              revoked. Send it as a Bearer token to POST /agents/:agentId/chat.
              The endpoint is rate limited.
            </p>
            <form
              className="form-grid"
              onSubmit={(e) => {
                const f = form(e);
                setOneTime("");
                void mutate(async () => {
                  const result = await requestJson<{ key: string }>(
                    `${base}/api-keys`,
                    "POST",
                    {
                      label: f.get("label"),
                      agentId: f.get("agentId"),
                      expiresInDays: Number(f.get("days")),
                    },
                  );
                  setOneTime(result.key);
                }, "API key created");
              }}
            >
              <label>
                Key label
                <input name="label" required maxLength={100} />
              </label>
              <label>
                Agent
                <select name="agentId" required>
                  {agents.data?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Expires in days
                <input
                  name="days"
                  type="number"
                  min={1}
                  max={365}
                  defaultValue={30}
                  required
                />
              </label>
              <Button disabled={busy || !agents.data?.length}>
                Create API key
              </Button>
            </form>
            {keys.data?.map((k) => (
              <div className="version-row" key={k.id}>
                <div>
                  <strong>{k.label}</strong>
                  <small>
                    {k.prefix}… · {k.scope} · expires{" "}
                    {new Date(k.expires_at).toLocaleDateString()} · last used{" "}
                    {k.last_used_at
                      ? new Date(k.last_used_at).toLocaleString()
                      : "Never"}
                  </small>
                </div>
                {k.revoked_at ? (
                  <span>Revoked</span>
                ) : (
                  <Button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Revoke ${k.label}? Applications using this key will lose access.`,
                        )
                      )
                        void mutate(
                          () =>
                            requestJson(`${base}/api-keys/${k.id}`, "DELETE"),
                          "Key revoked",
                        );
                    }}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </>
        )}
        {tab === "Webhooks" && (
          <>
            <h4>Signed run notifications</h4>
            <p className="muted">
              Receive agent.run.finished events without chat content. Endpoints
              need HTTPS and server hostname approval. Deliveries retry
              transient failures up to five attempts.
            </p>
            <form
              className="form-grid"
              onSubmit={(e) => {
                const f = form(e);
                setOneTime("");
                void mutate(async () => {
                  const result = await requestJson<{ signingSecret: string }>(
                    `${base}/webhooks`,
                    "POST",
                    { name: f.get("name"), url: f.get("url") },
                  );
                  setOneTime(result.signingSecret);
                }, "Webhook registered");
              }}
            >
              <label>
                Webhook name
                <input name="name" required maxLength={100} />
              </label>
              <label>
                Webhook URL
                <input
                  name="url"
                  type="url"
                  required
                  placeholder="https://your-service.example/events"
                />
              </label>
              <Button disabled={busy}>Register webhook</Button>
            </form>
            {hooks.data?.map((h) => (
              <div className="version-row" key={h.id}>
                <div>
                  <strong>{h.name}</strong>
                  <small>{h.url}</small>
                </div>
                <Button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    void mutate(
                      () =>
                        requestJson(`${base}/webhooks/${h.id}`, "PUT", {
                          enabled: !h.enabled,
                        }),
                      h.enabled ? "Webhook disabled" : "Webhook enabled",
                    );
                  }}
                >
                  {h.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Rotate this webhook’s signing secret? Update your receiver before the next delivery.",
                      )
                    )
                      void mutate(async () => {
                        const result = await requestJson<{
                          signingSecret: string;
                        }>(`${base}/webhooks/${h.id}/rotate`, "POST");
                        setOneTime(result.signingSecret);
                      }, "Signing secret rotated");
                  }}
                >
                  Rotate secret
                </Button>
              </div>
            ))}
            <h4>Recent deliveries</h4>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Event ID</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>HTTP / error</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.data?.map((d) => (
                    <tr key={d.id}>
                      <td>{d.id.slice(0, 8)}</td>
                      <td>
                        {d.status}
                        {d.status === "failed" && (
                          <button
                            type="button"
                            className="text-button"
                            disabled={busy}
                            onClick={() => {
                              void mutate(
                                () =>
                                  requestJson(
                                    `${base}/webhook-deliveries/${d.id}/retry`,
                                    "POST",
                                  ),
                                "Delivery queued for retry",
                              );
                            }}
                          >
                            Retry delivery
                          </button>
                        )}
                      </td>
                      <td>{d.attempts}</td>
                      <td>
                        {d.http_status ?? "—"} {d.error_code}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {tab === "Members" && (
          <>
            <h4>Workspace roles</h4>
            <p className="muted">
              Organization roles are inherited. You cannot change your own role.
              Only organization administrators can change workspace
              administrators.
            </p>
            {members.error && <p className="error">{members.error.message}</p>}
            {members.data?.map((m) => (
              <div className="version-row" key={m.id}>
                <div>
                  <strong>{m.name}</strong>
                  <small>{m.email}</small>
                </div>
                {m.workspace_id ? (
                  <select
                    aria-label={`Role for ${m.name}`}
                    disabled={busy}
                    value={m.role}
                    onChange={(e) => {
                      const role = e.target.value;
                      if (
                        window.confirm(
                          `Change ${m.name} to ${role.replaceAll("_", " ")}?`,
                        )
                      )
                        void mutate(
                          () =>
                            requestJson(
                              `/workspaces/${workspaceId}/members/${m.id}/role`,
                              "PUT",
                              { role },
                            ),
                          "Member role updated",
                        );
                    }}
                  >
                    {[
                      "workspace_admin",
                      "builder",
                      "operator",
                      "analyst",
                      "viewer",
                    ].map((role) => (
                      <option key={role} value={role}>
                        {role.replaceAll("_", " ")}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span>{m.role.replaceAll("_", " ")} · inherited</span>
                )}
              </div>
            ))}
          </>
        )}
        {tab === "Audit" && (
          <>
            <h4>Workspace audit trail</h4>
            <label>
              Filter by action
              <input
                value={auditAction}
                onChange={(e) => setAuditAction(e.target.value)}
                placeholder="e.g. api_key.created"
                maxLength={100}
              />
            </label>
            {audit.error && (
              <p className="error" role="alert">
                {audit.error.message}
              </p>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>Time</th>
                    <th>Entity</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data?.map((a) => (
                    <tr key={a.id}>
                      <td>{a.action}</td>
                      <td>{a.actor}</td>
                      <td>{new Date(a.created_at).toLocaleString()}</td>
                      <td>{a.entity_id ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted">
              Latest 100 matching events. Secret values and review content are
              excluded from the audit trail.
            </p>
          </>
        )}
        {tab === "Deployments" && (
          <>
            <h4>Deployment environments</h4>
            <p className="muted">
              Assign development, staging or production and promote a published
              version. Existing conversations keep their original snapshot.
              Environment labels do not change public-chat access.
            </p>
            {deployments.data?.map((d) => (
              <DeploymentRow
                key={d.id}
                deployment={d}
                canManage={canManage}
                busy={busy}
                promote={(versionId, environment) =>
                  mutate(
                    () =>
                      requestJson(`${base}/deployments/${d.id}`, "PUT", {
                        versionId,
                        environment,
                      }),
                    "Deployment updated",
                  )
                }
              />
            ))}
            {deployments.data?.length === 0 && (
              <p className="empty">
                Publish an agent and create a hosted deployment from its Publish
                tab.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
function DeploymentRow({
  deployment: d,
  canManage,
  busy,
  promote,
}: {
  deployment: Deployment;
  canManage: boolean;
  busy: boolean;
  promote: (versionId: string, environment: string) => Promise<void>;
}) {
  const [version, setVersion] = useState(d.version_id),
    [environment, setEnvironment] = useState(d.environment);
  const versions = useQuery({
    queryKey: ["versions", d.agent_id],
    queryFn: () =>
      requestJson<{ id: string; version: number }[]>(
        `/agents/${d.agent_id}/versions`,
      ),
    enabled: canManage,
  });
  return (
    <div className="version-row">
      <div>
        <strong>{d.name}</strong>
        <small>
          v{d.version} · {d.environment} · {d.enabled ? "Active" : "Disabled"}
        </small>
      </div>
      {canManage && (
        <div className="studio-actions">
          <select
            aria-label={`Version for ${d.name}`}
            value={version}
            onChange={(e) => setVersion(e.target.value)}
          >
            {versions.data?.map((v) => (
              <option key={v.id} value={v.id}>
                Version {v.version}
              </option>
            ))}
          </select>
          <select
            aria-label={`Environment for ${d.name}`}
            value={environment}
            onChange={(e) => setEnvironment(e.target.value)}
          >
            {["development", "staging", "production"].map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
          <Button
            type="button"
            disabled={busy || !versions.data?.length}
            onClick={() => {
              if (
                window.confirm(
                  "Update this deployment for future conversations?",
                )
              )
                void promote(version, environment);
            }}
          >
            Apply
          </Button>
        </div>
      )}
    </div>
  );
}
