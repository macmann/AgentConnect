"use client";
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  WorkspaceSections,
  useWorkspaceSection,
  WorkspaceSaveBar,
} from "./workspace-sections";
import { Button } from "./button";
import { requestJson } from "./agent-client";
type Tool = {
  id: string;
  name: string;
  description: string;
  kind: string;
  input_schema: unknown;
  enabled: boolean;
  public_access: boolean;
  timeout_ms: number;
  revision: number;
};
type Connector = {
  id: string;
  name: string;
  url: string;
  secret_id: string | null;
  enabled: boolean;
  revision: number;
  capabilities: {
    tools?: {
      name: string;
      description?: string;
      annotations?: { readOnlyHint?: boolean };
    }[];
    resources?: unknown[];
    prompts?: unknown[];
  };
  discovered_at: string | null;
};
export interface ToolTrace {
  executionId?: string;
  id?: string;
  toolId?: string;
  name?: string;
  tool_name?: string;
  status: string;
  durationMs?: number;
  duration_ms?: number;
  result?: unknown;
  arguments?: unknown;
  error_code?: string;
  run_id?: string | null;
}
export function ToolTraces({ traces }: { traces: ToolTrace[] }) {
  if (!traces.length) return null;
  return (
    <div className="tool-traces">
      <h4>Tool executions</h4>
      {traces.map((t, i) => (
        <details key={t.executionId ?? t.id ?? i}>
          <summary>
            {t.name ?? t.tool_name} · {t.status}
            {(t.durationMs ?? t.duration_ms) != null
              ? ` · ${t.durationMs ?? t.duration_ms} ms`
              : ""}
          </summary>
          {t.error_code && <p className="error">{t.error_code}</p>}
          {t.arguments != null && (
            <pre>{JSON.stringify(t.arguments, null, 2)}</pre>
          )}
          {t.result != null && <pre>{JSON.stringify(t.result, null, 2)}</pre>}
          {t.run_id && <small>Run {t.run_id}</small>}
        </details>
      ))}
    </div>
  );
}
export function ToolStudio({
  workspaceId,
  role,
}: {
  workspaceId: string;
  role: string;
}) {
  const cache = useQueryClient();
  const manage = ["owner", "org_admin", "workspace_admin"].includes(role);
  const read = manage || ["builder", "operator"].includes(role);
  const [section, setSection] = useWorkspaceSection(
    "toolsSection",
    "registry",
    manage
      ? ["registry", "configure", "connectors", "traces"]
      : ["registry", "traces"],
  );
  const execute = manage || role === "builder";
  const tools = useQuery({
    queryKey: ["tools", workspaceId],
    queryFn: () => requestJson<Tool[]>(`/workspaces/${workspaceId}/tools`),
    enabled: read,
  });
  const connectors = useQuery({
    queryKey: ["mcp", workspaceId],
    queryFn: () =>
      requestJson<Connector[]>(`/workspaces/${workspaceId}/mcp-connectors`),
    enabled: manage,
  });
  const secrets = useQuery({
    queryKey: ["tool-secrets", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(
        `/workspaces/${workspaceId}/secrets`,
      ),
    enabled: manage,
  });
  const traces = useQuery({
    queryKey: ["tool-traces", workspaceId],
    queryFn: () =>
      requestJson<ToolTrace[]>(`/workspaces/${workspaceId}/tool-executions`),
    enabled: read,
  });
  const [kind, setKind] = useState("http"),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [url, setUrl] = useState(""),
    [secretId, setSecret] = useState(""),
    [auth, setAuth] = useState("none"),
    [parameters, setParameters] = useState(""),
    [schema, setSchema] = useState("public"),
    [table, setTable] = useState(""),
    [columns, setColumns] = useState(""),
    [publicAccess, setPublic] = useState(false),
    [ack, setAck] = useState(false),
    [connectorId, setConnector] = useState(""),
    [remoteName, setRemote] = useState(""),
    [edit, setEdit] = useState<{ id: string; revision: number } | null>(null),
    [timeout, setTimeout] = useState(5000);
  const [connectorName, setConnectorName] = useState(""),
    [connectorUrl, setConnectorUrl] = useState(""),
    [connectorSecret, setConnectorSecret] = useState("");
  const [testId, setTestId] = useState(""),
    [args, setArgs] = useState("{}"),
    [result, setResult] = useState<ToolTrace | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const split = (s: string) =>
    s
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  async function action(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
      await cache.invalidateQueries();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const selectedConnector = connectors.data?.find((c) => c.id === connectorId);
  async function save(e: FormEvent) {
    e.preventDefault();
    await action(async () => {
      const config =
        kind === "http"
          ? {
              kind,
              url,
              queryParameters: split(parameters),
              secretId: secretId || null,
              auth,
            }
          : kind === "database"
            ? {
                kind,
                secretId,
                schema,
                table,
                columns: split(columns),
                filterColumns: split(parameters),
                rowLimit: 20,
              }
            : kind === "search"
              ? { kind, secretId, provider: "brave", resultCount: 5 }
              : { kind, connectorId, remoteName };
      await requestJson(
        edit ? `/tools/${edit.id}` : `/workspaces/${workspaceId}/tools`,
        edit ? "PUT" : "POST",
        {
          name,
          description,
          config,
          publicAccess,
          enabled: true,
          timeoutMs: timeout,
          readOnlyAcknowledged: true,
          ...(edit ? { revision: edit.revision } : {}),
        },
      );
      setNotice(
        edit
          ? "Tool updated. Start a new chat to try it."
          : "Tool registered. Attach it in an agent's configuration.",
      );
      setEdit(null);
      setSection("registry");
      setName("");
      setDescription("");
      setAck(false);
    });
  }
  async function change(t: Tool, enabled: boolean) {
    await action(async () => {
      const row = await requestJson<{ config: unknown }>(`/tools/${t.id}`);
      await requestJson(`/tools/${t.id}`, "PUT", {
        name: t.name,
        description: t.description,
        config: row.config,
        enabled,
        publicAccess: t.public_access,
        timeoutMs: t.timeout_ms,
        revision: t.revision,
        readOnlyAcknowledged: true,
      });
    });
  }
  async function editTool(t: Tool) {
    await action(async () => {
      const row = await requestJson<{ config: Record<string, unknown> }>(
        `/tools/${t.id}`,
      );
      const c = row.config;
      setSection("configure");
      setEdit({ id: t.id, revision: t.revision });
      setName(t.name);
      setDescription(t.description);
      setKind(t.kind);
      setUrl(String(c.url ?? ""));
      setSecret(String(c.secretId ?? ""));
      setAuth(String(c.auth ?? "none"));
      setSchema(String(c.schema ?? "public"));
      setTable(String(c.table ?? ""));
      setColumns(((c.columns as string[]) ?? []).join(","));
      setParameters(
        (((c.queryParameters ?? c.filterColumns) as string[]) ?? []).join(","),
      );
      setConnector(String(c.connectorId ?? ""));
      setRemote(String(c.remoteName ?? ""));
      setPublic(t.public_access);
      setTimeout(t.timeout_ms);
      setAck(false);
    });
  }
  if (!read)
    return (
      <section className="panel">
        <div className="empty">
          <h3>Tool access required</h3>
          <p>
            Ask a workspace administrator for permission to view approved tools.
          </p>
        </div>
      </section>
    );
  return (
    <section className="panel tool-studio">
      <div className="panel-header">
        <div>
          <h2>Tools & MCP</h2>
          <p>
            Attach approved read-only integrations to agents and inspect their
            execution.
          </p>
        </div>
        <Button
          className="secondary"
          onClick={() => cache.invalidateQueries()}
          disabled={busy}
        >
          Refresh
        </Button>
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {tools.error && <p className="error-banner">{tools.error.message}</p>}
      <WorkspaceSections
        label="Tools sections"
        value={section}
        onChange={setSection}
        sections={[
          {
            id: "registry",
            label: "Registered tools",
            description:
              "Choose approved read-only tools to attach to your agents.",
            count: tools.data?.length,
          },
          ...(manage
            ? [
                {
                  id: "configure",
                  label: "Tool setup",
                  description:
                    "Define what this tool can read and how agents should use it.",
                },
                {
                  id: "connectors",
                  label: "MCP connectors",
                  description:
                    "Connect a server, discover its capabilities, then approve individual read-only tools.",
                  count: connectors.data?.length,
                },
              ]
            : []),
          {
            id: "traces",
            label: "Execution history",
            description: "Inspect recent tool results and failures.",
            count: traces.data?.length,
          },
        ]}
      />
      <div
        className="workspace-section-body"
        hidden={section !== "configure" || !manage}
      >
        {manage && (
          <form onSubmit={save} className="tool-form">
            <h3>{edit ? "Edit tool" : "Register tool"}</h3>
            <div className="form-grid">
              <label>
                Name
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={100}
                />
              </label>
              <label>
                Type
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="http">HTTP GET</option>
                  <option value="database">PostgreSQL read</option>
                  <option value="search">Brave web search</option>
                  <option value="mcp">MCP read-only tool</option>
                </select>
              </label>
              <label>
                Description for the agent
                <textarea
                  required
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={1500}
                />
              </label>
              <label>
                Timeout (ms)
                <input
                  type="number"
                  min={500}
                  max={15000}
                  value={timeout}
                  onChange={(e) => setTimeout(Number(e.target.value))}
                />
              </label>
              {kind !== "mcp" && (
                <label>
                  Encrypted credential
                  <select
                    value={secretId}
                    onChange={(e) => setSecret(e.target.value)}
                  >
                    <option value="">No credential</option>
                    {secrets.data?.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {kind === "http" && (
                <>
                  <label>
                    Fixed endpoint URL
                    <input
                      required
                      type="url"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                    />
                  </label>
                  <label>
                    Authentication
                    <select
                      value={auth}
                      onChange={(e) => setAuth(e.target.value)}
                    >
                      <option value="none">None</option>
                      <option value="bearer">Bearer token</option>
                      <option value="api-key">X-API-Key</option>
                    </select>
                  </label>
                  <label>
                    Allowed query parameters (comma separated)
                    <input
                      value={parameters}
                      onChange={(e) => setParameters(e.target.value)}
                      placeholder="query,category"
                    />
                  </label>
                </>
              )}
              {kind === "database" && (
                <>
                  <label>
                    Schema
                    <input
                      required
                      value={schema}
                      onChange={(e) => setSchema(e.target.value)}
                    />
                  </label>
                  <label>
                    Allowed table or view
                    <input
                      required
                      value={table}
                      onChange={(e) => setTable(e.target.value)}
                    />
                  </label>
                  <label>
                    Returned columns (comma separated)
                    <input
                      required
                      value={columns}
                      onChange={(e) => setColumns(e.target.value)}
                    />
                  </label>
                  <label>
                    Allowed equality filters (comma separated)
                    <input
                      value={parameters}
                      onChange={(e) => setParameters(e.target.value)}
                    />
                  </label>
                  <p className="muted">
                    Credential must contain a PostgreSQL connection URL for a
                    restricted read-only role. Results are limited to 20 rows.
                    Queries are constructed from this configuration.
                  </p>
                </>
              )}
              {kind === "search" && (
                <p className="muted">
                  Requires a Brave Search API key. Returns up to five results
                  with strict safe search. The agent supplies a query.
                </p>
              )}
              {kind === "mcp" && (
                <>
                  <label>
                    Connector
                    <select
                      required
                      value={connectorId}
                      onChange={(e) => {
                        setConnector(e.target.value);
                        setRemote("");
                      }}
                    >
                      <option value="">Choose discovered connector</option>
                      {connectors.data
                        ?.filter((c) => c.enabled)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Read-only capability
                    <select
                      required
                      value={remoteName}
                      onChange={(e) => setRemote(e.target.value)}
                    >
                      <option value="">Choose remote tool</option>
                      {selectedConnector?.capabilities.tools
                        ?.filter((t) => t.annotations?.readOnlyHint === true)
                        .map((t) => (
                          <option key={t.name} value={t.name}>
                            {t.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </>
              )}
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={publicAccess}
                onChange={(e) => setPublic(e.target.checked)}
              />
              Allow anonymous hosted agents to use this tool and receive its
              output
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                required
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              I verified this integration is read-only and its returned data is
              appropriate for this workspace.
            </label>
            <WorkspaceSaveBar>
              <span>Read-only tool configuration</span>
              <div className="studio-actions">
                <Button disabled={busy || !ack} type="submit">
                  {edit ? "Save tool" : "Register tool"}
                </Button>
                {edit && (
                  <Button
                    className="secondary"
                    type="button"
                    onClick={() => setEdit(null)}
                  >
                    Cancel edit
                  </Button>
                )}
              </div>
            </WorkspaceSaveBar>
            <p className="muted">
              HTTP/MCP destinations require server-approved TOOL_ALLOWED_HOSTS.
              Private endpoints require TOOL_PRIVATE_HOSTS; PostgreSQL uses
              TOOL_DATABASE_HOSTS. Changing these settings requires restarting
              the API.
            </p>
          </form>
        )}
      </div>
      <div className="workspace-section-body" hidden={section !== "registry"}>
        {tools.isPending && read ? (
          <p role="status">Loading registered tools…</p>
        ) : tools.error ? (
          <p className="muted">
            Registered tools could not be loaded. Use Refresh to try again.
          </p>
        ) : tools.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Policy</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tools.data.map((t) => (
                  <tr key={t.id}>
                    <td>
                      {t.name}
                      <small className="block muted">
                        {t.kind} · {t.description}
                      </small>
                    </td>
                    <td>
                      {t.enabled ? "Enabled" : "Disabled"} ·{" "}
                      {t.public_access ? "Public access" : "Workspace only"}
                    </td>
                    <td>
                      {execute && (
                        <Button
                          className="secondary"
                          disabled={busy || !t.enabled}
                          onClick={() => {
                            setTestId(t.id);
                            setResult(null);
                          }}
                        >
                          Test
                        </Button>
                      )}
                      {manage && (
                        <>
                          <Button
                            className="secondary"
                            disabled={busy}
                            onClick={() => editTool(t)}
                          >
                            Edit
                          </Button>
                          <Button
                            className="secondary"
                            disabled={busy}
                            onClick={() => change(t, !t.enabled)}
                          >
                            {t.enabled ? "Disable" : "Enable"}
                          </Button>
                          <Button
                            className="danger"
                            disabled={busy}
                            onClick={() =>
                              action(async () => {
                                await requestJson(`/tools/${t.id}`, "DELETE");
                              })
                            }
                          >
                            Archive
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">
            <h3>No tools registered yet</h3>
            <p>
              Attach a read-only tool when an agent needs external information.
            </p>
            {manage ? (
              <Button onClick={() => setSection("configure")}>
                Register your first tool
              </Button>
            ) : (
              <p>Ask a workspace administrator to register a tool.</p>
            )}
          </div>
        )}
        {testId && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                setResult(null);
                const data = await requestJson<ToolTrace>(
                  `/tools/${testId}/test`,
                  "POST",
                  { arguments: JSON.parse(args) },
                );
                setResult(data);
              });
            }}
          >
            <h3>Test {tools.data?.find((t) => t.id === testId)?.name}</h3>
            <details>
              <summary>Argument schema</summary>
              <pre>
                {JSON.stringify(
                  tools.data?.find((t) => t.id === testId)?.input_schema,
                  null,
                  2,
                )}
              </pre>
            </details>
            <label>
              Arguments (JSON)
              <textarea
                aria-label="Tool test arguments"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                maxLength={8000}
              />
            </label>
            <Button type="submit" disabled={busy}>
              Execute read-only test
            </Button>
            {result && <ToolTraces traces={[result]} />}
          </form>
        )}
      </div>
      <div
        className="workspace-section-body"
        hidden={section !== "connectors" || !manage}
      >
        {manage && (
          <>
            <h3>MCP connectors</h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  await requestJson(
                    `/workspaces/${workspaceId}/mcp-connectors`,
                    "POST",
                    {
                      name: connectorName,
                      url: connectorUrl,
                      secretId: connectorSecret || null,
                    },
                  );
                  setConnectorName("");
                  setConnectorUrl("");
                  setNotice(
                    "Connector registered. Discover capabilities, then register selected read-only tools.",
                  );
                });
              }}
            >
              <div className="form-grid">
                <label>
                  Server name
                  <input
                    required
                    value={connectorName}
                    onChange={(e) => setConnectorName(e.target.value)}
                    maxLength={100}
                  />
                </label>
                <label>
                  Streamable HTTP URL
                  <input
                    required
                    type="url"
                    value={connectorUrl}
                    onChange={(e) => setConnectorUrl(e.target.value)}
                  />
                </label>
                <label>
                  Bearer credential
                  <select
                    value={connectorSecret}
                    onChange={(e) => setConnectorSecret(e.target.value)}
                  >
                    <option value="">No credential</option>
                    {secrets.data?.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <Button type="submit" disabled={busy}>
                Register connector
              </Button>
            </form>
            {connectors.error && (
              <p className="error">{connectors.error.message}</p>
            )}
            {connectors.data?.map((c) => (
              <article key={c.id} className="tool-connector">
                <h4>
                  {c.name} · {c.enabled ? "Enabled" : "Disabled"}
                </h4>
                <p>{c.url}</p>
                <Button
                  disabled={busy || !c.enabled}
                  className="secondary"
                  onClick={() =>
                    action(async () => {
                      await requestJson(
                        `/mcp-connectors/${c.id}/discover`,
                        "POST",
                      );
                      setNotice(
                        "Capabilities refreshed. Only explicitly registered tools can execute.",
                      );
                    })
                  }
                >
                  Discover / test connection
                </Button>
                <Button
                  disabled={busy}
                  className="secondary"
                  onClick={() =>
                    action(async () => {
                      await requestJson(`/mcp-connectors/${c.id}`, "PUT", {
                        name: c.name,
                        url: c.url,
                        secretId: c.secret_id,
                        enabled: !c.enabled,
                        revision: c.revision,
                      });
                    })
                  }
                >
                  {c.enabled ? "Disable connector" : "Enable connector"}
                </Button>
                <details>
                  <summary>
                    Capabilities · {c.capabilities.tools?.length ?? 0} tools ·{" "}
                    {c.capabilities.resources?.length ?? 0} resources ·{" "}
                    {c.capabilities.prompts?.length ?? 0} prompts
                  </summary>
                  <pre>{JSON.stringify(c.capabilities, null, 2)}</pre>
                </details>
              </article>
            ))}
          </>
        )}
      </div>
      <div className="workspace-section-body" hidden={section !== "traces"}>
        <h3>Recent workspace traces</h3>
        {traces.data?.length === 0 && (
          <div className="empty">
            <h4>No tool executions yet</h4>
            <p>
              Test a registered tool or attach it to an agent to see execution
              results here.
            </p>
            <Button
              className="secondary"
              onClick={() => setSection("registry")}
            >
              View registered tools
            </Button>
          </div>
        )}
        {traces.error && <p className="error">{traces.error.message}</p>}
        <ToolTraces traces={traces.data ?? []} />
      </div>
    </section>
  );
}
