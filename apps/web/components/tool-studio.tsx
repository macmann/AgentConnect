"use client";
import { useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Plus, X, Search, Plug, Wrench } from "lucide-react";
import { Button } from "./button";
import { requestJson } from "./agent-client";
import { ToolSetupWizard } from "./tool-setup-wizard";
import { WorkflowActionConnections } from "./workflow-action-connections";
import type { ToolConfig } from "@agentconnect/schemas/tools";
type Tool = {
  id: string;
  name: string;
  description: string;
  kind: string;
  input_schema: Record<string, unknown>;
  enabled: boolean;
  public_access: boolean;
  timeout_ms: number;
  revision: number;
};
type Detail = Tool & { config: ToolConfig };
type Connector = {
  id: string;
  name: string;
  url: string;
  transport?: string;
  auth_header?: string;
  stdio?: unknown;
  secret_id: string | null;
  enabled: boolean;
  revision: number;
  capabilities: { tools?: unknown[] };
  discovered_at: string | null;
};
const kindLabel: Record<string, string> = {
  search: "Web search",
  financial: "Calculator",
  mcp: "MCP",
  api: "API",
  http: "HTTP",
  database: "Database",
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
function ToolDialog({
  title,
  description,
  children,
  onClose,
}: {
  title: string;
  description: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content tool-detail-dialog">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{description}</Dialog.Description>
          <Dialog.Close className="dialog-close" aria-label="Close dialog">
            <X size={18} />
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function ToolStudio({
  workspaceId,
  role,
  connections = false,
}: {
  workspaceId: string;
  role: string;
  connections?: boolean;
}) {
  const cache = useQueryClient(),
    manage = ["owner", "org_admin", "workspace_admin"].includes(role),
    read = manage || ["builder", "operator"].includes(role),
    execute = manage || role === "builder";
  const tools = useQuery({
    queryKey: ["tools", workspaceId],
    queryFn: () => requestJson<Tool[]>(`/workspaces/${workspaceId}/tools`),
    enabled: read,
  });
  const servers = useQuery({
    queryKey: ["mcp", workspaceId],
    queryFn: () =>
      requestJson<Connector[]>(`/workspaces/${workspaceId}/mcp-connectors`),
    enabled: manage,
  });
  const [wizard, setWizard] = useState(false),
    [query, setQuery] = useState(""),
    [kind, setKind] = useState("all"),
    [view, setView] = useState<"servers" | "traces" | "workflow" | null>(null),
    [test, setTest] = useState<Tool | null>(null),
    [edit, setEdit] = useState<Detail | null>(null),
    [args, setArgs] = useState("{}"),
    [result, setResult] = useState<ToolTrace | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const traces = useQuery({
    queryKey: ["tool-traces", workspaceId],
    queryFn: () =>
      requestJson<ToolTrace[]>(`/workspaces/${workspaceId}/tool-executions`),
    enabled: read && view === "traces",
  });
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["tools", workspaceId] }),
        cache.invalidateQueries({ queryKey: ["mcp", workspaceId] }),
        cache.invalidateQueries({ queryKey: ["tool-traces", workspaceId] }),
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function toggle(t: Tool) {
    const d = await requestJson<Detail>(`/tools/${t.id}`);
    await requestJson(`/tools/${t.id}`, "PUT", {
      name: d.name,
      description: d.description,
      config: d.config,
      revision: d.revision,
      enabled: !d.enabled,
      publicAccess: d.public_access,
      timeoutMs: d.timeout_ms,
      readOnlyAcknowledged: true,
    });
  }
  const filtered = tools.data?.filter(
    (t) =>
      (kind === "all" || t.kind === kind) &&
      `${t.name} ${t.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section className="panel tools-registry">
      <div className="tools-registry-heading">
        <div>
          <h2>{connections ? "Connections" : "Tools"}</h2>
          <p>Connect services once. Use their tools across your agents.</p>
        </div>
        {manage && (
          <Button
            onClick={() => {
              setError("");
              setWizard(true);
            }}
          >
            <Plus size={16} />
            Add tools
          </Button>
        )}
      </div>
      {!read ? (
        <p>Your role cannot view tools.</p>
      ) : (
        <>
          <div className="tools-registry-toolbar">
            <label className="tools-search">
              <Search size={16} />
              <input
                aria-label="Search tools"
                placeholder="Search tools"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <select
              aria-label="Tool type filter"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="all">All types</option>
              {Object.entries(kindLabel).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            <div className="tools-registry-secondary">
              {manage && (
                <Button
                  className="secondary"
                  onClick={() => setView("servers")}
                >
                  <Plug size={15} />
                  MCP servers
                </Button>
              )}
              <Button className="secondary" onClick={() => setView("traces")}>
                Executions
              </Button>
              {connections && manage && (
                <Button
                  className="secondary"
                  onClick={() => setView("workflow")}
                >
                  Workflow connections
                </Button>
              )}
            </div>
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {tools.isPending ? (
            <p role="status">Loading tools…</p>
          ) : tools.error ? (
            <div role="alert">
              <p>{tools.error.message}</p>
              <Button
                className="secondary"
                onClick={() => void tools.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : filtered?.length ? (
            <div className="table-wrap">
              <table className="tools-registry-table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Access</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <strong title={t.description}>{t.name}</strong>
                        <span className="tool-row-description">
                          {t.description}
                        </span>
                      </td>
                      <td>{kindLabel[t.kind] || t.kind}</td>
                      <td>
                        <span className={`badge ${t.enabled ? "" : "muted"}`}>
                          {t.enabled ? "Enabled" : "Disabled"}
                        </span>
                      </td>
                      <td>
                        {t.public_access ? "Published agents" : "Workspace"}
                      </td>
                      <td>
                        <div className="tool-row-actions">
                          {execute && (
                            <Button
                              className="secondary"
                              disabled={!t.enabled || busy}
                              onClick={() => {
                                setTest(t);
                                setArgs("{}");
                                setResult(null);
                                setError("");
                              }}
                            >
                              Test
                            </Button>
                          )}
                          {manage && (
                            <Menu.Root modal={false}>
                              <Menu.Trigger asChild>
                                <Button
                                  className="secondary icon-button"
                                  aria-label={`Actions for ${t.name}`}
                                  disabled={busy}
                                >
                                  <Ellipsis size={18} />
                                </Button>
                              </Menu.Trigger>
                              <Menu.Portal>
                                <Menu.Content
                                  className="source-actions-menu"
                                  align="end"
                                  sideOffset={4}
                                >
                                  <Menu.Item
                                    className="source-actions-item"
                                    onSelect={() =>
                                      void action(async () => {
                                        setEdit(
                                          await requestJson<Detail>(
                                            `/tools/${t.id}`,
                                          ),
                                        );
                                      })
                                    }
                                  >
                                    Edit tool
                                  </Menu.Item>
                                  <Menu.Item
                                    className="source-actions-item"
                                    onSelect={() =>
                                      void action(() => toggle(t))
                                    }
                                  >
                                    {t.enabled ? "Disable" : "Enable"}
                                  </Menu.Item>
                                  <Menu.Separator className="source-actions-separator" />
                                  <Menu.Item
                                    className="source-actions-item destructive"
                                    onSelect={() =>
                                      void action(async () => {
                                        await requestJson(
                                          `/tools/${t.id}`,
                                          "DELETE",
                                        );
                                        setNotice(`${t.name} archived.`);
                                      })
                                    }
                                  >
                                    Archive
                                  </Menu.Item>
                                </Menu.Content>
                              </Menu.Portal>
                            </Menu.Root>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">
              <Wrench size={28} />
              <h3>
                {tools.data?.length
                  ? "No matching tools"
                  : "No tools connected yet"}
              </h3>
              <p>
                {tools.data?.length
                  ? "Try another search or type filter."
                  : "Start with web search, a code execution service, or your own MCP server or API."}
              </p>
              {manage && !tools.data?.length && (
                <Button onClick={() => setWizard(true)}>
                  Add your first tools
                </Button>
              )}
            </div>
          )}
          <p className="tools-registry-help">
            Use multiple tools in Agent → Configure → Tools. Only enabled,
            attached tools are available to that agent.
          </p>
        </>
      )}
      {wizard && (
        <ToolSetupWizard
          workspaceId={workspaceId}
          onClose={() => setWizard(false)}
          onSaved={(count) => {
            setWizard(false);
            setNotice(
              `${count} tool${count === 1 ? "" : "s"} saved. Attach them in Agent → Configure → Tools.`,
            );
          }}
        />
      )}
      {edit && (
        <ToolEdit
          tool={edit}
          workspaceId={workspaceId}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            void cache.invalidateQueries({ queryKey: ["tools", workspaceId] });
            setNotice("Tool saved.");
          }}
        />
      )}
      {test && (
        <ToolDialog
          title={`Test ${test.name}`}
          description="A test executes this tool using the arguments below."
          onClose={() => {
            if (!busy) setTest(null);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                setResult(null);
                setResult(
                  await requestJson<ToolTrace>(
                    `/tools/${test.id}/test`,
                    "POST",
                    { arguments: JSON.parse(args) },
                  ),
                );
              });
            }}
          >
            <details>
              <summary>Argument schema</summary>
              <pre>{JSON.stringify(test.input_schema, null, 2)}</pre>
            </details>
            <label>
              Arguments (JSON)
              <textarea
                aria-label="Tool test arguments"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                maxLength={8000}
                rows={8}
              />
            </label>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy}>
              {busy ? "Running…" : "Run test"}
            </Button>
            {result && <ToolTraces traces={[result]} />}
          </form>
        </ToolDialog>
      )}
      {view && (
        <ToolDialog
          title={
            view === "servers"
              ? "MCP servers"
              : view === "traces"
                ? "Tool executions"
                : "Workflow connections"
          }
          description={
            view === "servers"
              ? "Manage the servers behind your registered tools."
              : view === "traces"
                ? "Recent tool calls and troubleshooting details."
                : "Manage deterministic workflow HTTP authentication and MCP Action permissions."
          }
          onClose={() => setView(null)}
        >
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {view === "servers" ? (
            <>
              {servers.error && <p role="alert">{servers.error.message}</p>}
              {!servers.data?.length && (
                <p>No MCP servers connected. Add tools to connect one.</p>
              )}
              {servers.data?.map((c) => (
                <article className="tool-server-row" key={c.id}>
                  <div>
                    <strong>{c.name}</strong>
                    <small>
                      {c.transport === "stdio" ? "STDIO" : c.url} ·{" "}
                      {c.enabled ? "Enabled" : "Disabled"} ·{" "}
                      {c.capabilities.tools?.length ?? 0} capabilities
                    </small>
                  </div>
                  <Button
                    className="secondary"
                    disabled={busy || !c.enabled}
                    onClick={() =>
                      void action(async () => {
                        await requestJson(
                          `/mcp-connectors/${c.id}/discover`,
                          "POST",
                        );
                      })
                    }
                  >
                    Refresh capabilities
                  </Button>
                  <Button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await requestJson(`/mcp-connectors/${c.id}`, "PUT", {
                          name: c.name,
                          url: c.url,
                          transport: c.transport ?? "http",
                          stdio: c.stdio ?? null,
                          authHeader: c.auth_header ?? "Authorization",
                          secretId: c.secret_id,
                          enabled: !c.enabled,
                          revision: c.revision,
                        });
                      })
                    }
                  >
                    {c.enabled ? "Disable" : "Enable"}
                  </Button>
                </article>
              ))}
            </>
          ) : view === "traces" ? (
            <>
              {traces.isPending && <p>Loading executions…</p>}
              {traces.error && <p role="alert">{traces.error.message}</p>}
              {traces.data?.length === 0 && (
                <p>
                  No executions yet. Test a tool or use an agent with attached
                  tools.
                </p>
              )}
              <ToolTraces traces={traces.data ?? []} />
            </>
          ) : (
            <WorkflowActionConnections
              workspaceId={workspaceId}
              canManage={manage}
            />
          )}
        </ToolDialog>
      )}
    </section>
  );
}
function ToolEdit({
  workspaceId,
  tool,
  onClose,
  onSaved,
}: {
  tool: Detail;
  workspaceId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const secrets = useQuery({
    queryKey: ["tool-secrets", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(
        `/workspaces/${workspaceId}/secrets`,
      ),
  });
  const [name, setName] = useState(tool.name),
    [description, setDescription] = useState(tool.description),
    [config, setConfig] = useState(tool.config),
    [timeout, setTimeout] = useState(tool.timeout_ms),
    [publicAccess, setPublic] = useState(tool.public_access),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  function field(key: string, value: unknown) {
    setConfig((c) => ({ ...c, [key]: value }) as ToolConfig);
  }
  return (
    <ToolDialog
      title={`Edit ${tool.name}`}
      description="Update this tool’s identity, connection settings, and agent access."
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          void requestJson(`/tools/${tool.id}`, "PUT", {
            name,
            description,
            config,
            enabled: tool.enabled,
            publicAccess,
            timeoutMs: timeout,
            revision: tool.revision,
            readOnlyAcknowledged: true,
          })
            .then(onSaved)
            .catch((e) => setError((e as Error).message))
            .finally(() => setBusy(false));
        }}
      >
        <fieldset disabled={busy}>
          <label>
            Tool name
            <input
              required
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Description for the agent
            <textarea
              required
              value={description}
              maxLength={1500}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          {(config.kind === "http" || config.kind === "api") && (
            <label>
              Server URL
              <input
                required
                type="url"
                value={config.url}
                onChange={(e) => field("url", e.target.value)}
              />
            </label>
          )}
          {"secretId" in config && (
            <label>
              Saved credential
              <select
                aria-label="Saved credential"
                value={config.secretId ?? ""}
                onChange={(e) => field("secretId", e.target.value || null)}
                required={
                  config.kind === "search" || config.kind === "database"
                }
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
          {(config.kind === "http" || config.kind === "api") && (
            <>
              <label>
                Authentication
                <select
                  aria-label="Authentication"
                  value={config.auth}
                  onChange={(e) => field("auth", e.target.value)}
                >
                  <option value="none">None</option>
                  <option value="bearer">Bearer token</option>
                  <option value="api-key">API key header</option>
                </select>
              </label>
              {config.auth === "api-key" && (
                <label>
                  API key header
                  <input
                    value={config.headerName}
                    onChange={(e) => field("headerName", e.target.value)}
                  />
                </label>
              )}
            </>
          )}
          {config.kind === "http" && (
            <label>
              Query parameters
              <input
                value={config.queryParameters.join(", ")}
                onChange={(e) =>
                  field(
                    "queryParameters",
                    e.target.value
                      .split(",")
                      .map((v) => v.trim())
                      .filter(Boolean),
                  )
                }
              />
            </label>
          )}
          {config.kind === "database" && (
            <>
              {(["schema", "table"] as const).map((k) => (
                <label key={k}>
                  {k}
                  <input
                    value={config[k]}
                    onChange={(e) => field(k, e.target.value)}
                  />
                </label>
              ))}
              {(["columns", "filterColumns"] as const).map((k) => (
                <label key={k}>
                  {k}
                  <input
                    value={config[k].join(", ")}
                    onChange={(e) =>
                      field(
                        k,
                        e.target.value
                          .split(",")
                          .map((v) => v.trim())
                          .filter(Boolean),
                      )
                    }
                  />
                </label>
              ))}
            </>
          )}
          {config.kind === "financial" && (
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={config.requireEvidence}
                onChange={(e) => field("requireEvidence", e.target.checked)}
              />
              Require retrieved evidence
            </label>
          )}
          {config.kind === "search" && (
            <label>
              Results per search
              <input
                type="number"
                min={1}
                max={10}
                value={config.resultCount}
                onChange={(e) => field("resultCount", Number(e.target.value))}
              />
            </label>
          )}
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
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={publicAccess}
              onChange={(e) => setPublic(e.target.checked)}
            />
            Allow anonymous published agents to use this tool
          </label>
          <details>
            <summary>Connection & parameter details</summary>
            <pre>{JSON.stringify(config, null, 2)}</pre>
          </details>
        </fieldset>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="tool-wizard-footer">
          <Button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            Save tool
          </Button>
        </div>
      </form>
    </ToolDialog>
  );
}
