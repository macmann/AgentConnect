"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { requestJson } from "./agent-client";
import { Button } from "./button";
import type { ValueSchema } from "./workflow-v2-fields";
export type ActionConnectionCatalog = {
  http: {
    id: string;
    name: string;
    base_url: string;
    auth: string;
    secret_id?: string | null;
    header_name: string;
    methods: string[];
    idempotency_supported: boolean;
    scopes: string[];
    enabled: boolean;
    revision: number;
  }[];
  mcp: {
    id: string;
    name: string;
    enabled: boolean;
    operations: {
      name: string;
      description: string;
      inputSchema: ValueSchema;
      outputSchema: ValueSchema;
      sideEffect: "read" | "write" | "delete";
      riskLevel: "low" | "medium" | "high";
      idempotency: "key" | "not-required" | "unsupported";
      idempotencyArgument?: string;
      scopes: string[];
      allowed: boolean;
      annotations?: { destructiveHint?: boolean };
    }[];
  }[];
};
export function WorkflowActionConnections({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const cache = useQueryClient();
  const catalog = useQuery({
    queryKey: ["action-connections", workspaceId],
    queryFn: () =>
      requestJson<ActionConnectionCatalog>(
        `/workspaces/${workspaceId}/action-connections`,
      ),
  });
  const secrets = useQuery({
    queryKey: ["action-connection-secrets", workspaceId],
    enabled: canManage,
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(
        `/workspaces/${workspaceId}/secrets`,
      ),
  });
  const empty = {
    name: "",
    baseUrl: "",
    auth: "none",
    secretId: "",
    headerName: "X-API-Key",
    methods: ["GET"],
    idempotencySupported: false,
    scopes: "",
    enabled: true,
  };
  const [form, setForm] = useState(empty),
    [edit, setEdit] = useState<{ id: string; revision: number } | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [server, setServer] = useState(""),
    [operation, setOperation] = useState(""),
    [effect, setEffect] = useState("write"),
    [risk, setRisk] = useState("medium"),
    [allow, setAllow] = useState(false),
    [idempotencyArgument, setArgument] = useState("");
  const selected = catalog.data?.mcp
    .find((s) => s.id === server)
    ?.operations.find((o) => o.name === operation);
  async function act(fn: () => Promise<void>) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await fn();
      await catalog.refetch();
      await cache.invalidateQueries({
        queryKey: ["workflow-catalog", workspaceId],
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>Saved Action connections and MCP permissions</summary>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {catalog.error && <p role="alert">{catalog.error.message}</p>}
      {catalog.data?.http.map((c) => (
        <p key={c.id}>
          {c.name} · {c.methods.join(", ")} ·{" "}
          {c.enabled ? "enabled" : "disabled"}
          {canManage && (
            <Button
              onClick={() => {
                setEdit({ id: c.id, revision: c.revision });
                setForm({
                  name: c.name,
                  baseUrl: c.base_url,
                  auth: c.auth,
                  secretId: c.secret_id ?? "",
                  headerName: c.header_name,
                  methods: c.methods,
                  idempotencySupported: c.idempotency_supported,
                  scopes: c.scopes.join(", "),
                  enabled: c.enabled,
                });
              }}
            >
              Configure
            </Button>
          )}
        </p>
      ))}
      {!canManage ? (
        <p>
          A workspace administrator manages connection credentials and write
          permissions.
        </p>
      ) : (
        <fieldset disabled={busy}>
          <legend>
            {edit ? "Edit HTTP connection" : "New HTTP connection"}
          </legend>
          <label>
            Connection name
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            Base URL / allowed path prefix
            <input
              value={form.baseUrl}
              placeholder="https://api.example.com/invoices"
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            />
          </label>
          <label>
            Authentication
            <select
              value={form.auth}
              onChange={(e) =>
                setForm({ ...form, auth: e.target.value, secretId: "" })
              }
            >
              {["none", "bearer", "api-key", "basic"].map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
          {form.auth !== "none" && (
            <>
              <label>
                Saved encrypted secret
                <select
                  value={form.secretId}
                  onChange={(e) =>
                    setForm({ ...form, secretId: e.target.value })
                  }
                >
                  <option value="">Choose saved secret</option>
                  {secrets.data?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <a
                href={`/#${new URLSearchParams({ workspace: workspaceId, view: "Secrets" })}`}
                target="_blank"
                rel="noreferrer"
              >
                Create or rotate a secret
              </a>
            </>
          )}
          {form.auth === "api-key" && (
            <label>
              Credential header
              <input
                value={form.headerName}
                onChange={(e) =>
                  setForm({ ...form, headerName: e.target.value })
                }
              />
            </label>
          )}
          <p>Explicitly allowed HTTP methods</p>
          {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => (
            <label key={method}>
              <input
                type="checkbox"
                checked={form.methods.includes(method)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    methods: e.target.checked
                      ? [...form.methods, method]
                      : form.methods.filter((m) => m !== method),
                  })
                }
              />
              {method}
            </label>
          ))}
          <label>
            <input
              type="checkbox"
              checked={form.idempotencySupported}
              onChange={(e) =>
                setForm({ ...form, idempotencySupported: e.target.checked })
              }
            />
            Service supports the Idempotency-Key header
          </label>
          <label>
            Declared integration scopes (comma separated)
            <input
              value={form.scopes}
              onChange={(e) => setForm({ ...form, scopes: e.target.value })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            Connection enabled
          </label>
          <Button
            disabled={
              !form.name ||
              !form.baseUrl ||
              !form.methods.length ||
              (form.auth !== "none" && !form.secretId)
            }
            onClick={() =>
              void act(async () => {
                await requestJson(
                  edit
                    ? `/workflow-action-connections/${edit.id}`
                    : `/workspaces/${workspaceId}/action-connections`,
                  edit ? "PUT" : "POST",
                  {
                    ...form,
                    secretId: form.auth === "none" ? null : form.secretId,
                    scopes: form.scopes
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                    ...(edit ? { revision: edit.revision } : {}),
                  },
                );
                setForm(empty);
                setEdit(null);
                setNotice("Connection saved");
              })
            }
          >
            Save connection
          </Button>
          {edit && (
            <Button
              onClick={() => {
                setEdit(null);
                setForm(empty);
              }}
            >
              New connection
            </Button>
          )}
        </fieldset>
      )}
      {canManage && (
        <fieldset disabled={busy}>
          <legend>MCP Action permission</legend>
          <label>
            MCP server
            <select
              value={server}
              onChange={(e) => {
                setServer(e.target.value);
                setOperation("");
                setAllow(false);
              }}
            >
              <option value="">Choose existing MCP server</option>
              {catalog.data?.mcp
                .filter((s) => s.enabled)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Operation
            <select
              value={operation}
              onChange={(e) => {
                setOperation(e.target.value);
                const op = catalog.data?.mcp
                  .find((s) => s.id === server)
                  ?.operations.find((o) => o.name === e.target.value);
                setEffect(op?.sideEffect ?? "write");
                setRisk(op?.riskLevel ?? "high");
                setAllow(false);
                setArgument(op?.idempotencyArgument ?? "");
              }}
            >
              <option value="">Choose discovered operation</option>
              {catalog.data?.mcp
                .find((s) => s.id === server)
                ?.operations.map((o) => (
                  <option key={o.name} value={o.name}>
                    {o.name} · {o.allowed ? "allowed" : "not allowed"}
                  </option>
                ))}
            </select>
          </label>
          {selected && (
            <>
              <p>{selected.description}</p>
              <label>
                Side effect
                <select
                  value={effect}
                  onChange={(e) => setEffect(e.target.value)}
                >
                  {["read", "write", "delete"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                Risk
                <select value={risk} onChange={(e) => setRisk(e.target.value)}>
                  {["low", "medium", "high"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                Idempotency string argument (optional)
                <select
                  value={idempotencyArgument}
                  onChange={(e) => setArgument(e.target.value)}
                >
                  <option value="">Not supported</option>
                  {Object.entries(selected.inputSchema.properties ?? {})
                    .filter(([, s]) => s.type === "string")
                    .map(([key]) => (
                      <option key={key}>{key}</option>
                    ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={allow}
                  onChange={(e) => setAllow(e.target.checked)}
                />
                Explicitly allow this operation for workflow Actions
              </label>
              <p>This does not make the operation available to Agent Tools.</p>
              <Button
                disabled={!allow}
                onClick={() =>
                  void act(async () => {
                    await requestJson(
                      `/workspaces/${workspaceId}/mcp-action-grants`,
                      "POST",
                      {
                        connectorId: server,
                        operation,
                        sideEffect: effect,
                        riskLevel: risk,
                        allowWrites: effect !== "read" && allow,
                        ...(idempotencyArgument ? { idempotencyArgument } : {}),
                        enabled: true,
                        scopes: selected.scopes,
                      },
                    );
                    setNotice("MCP Action permission saved");
                  })
                }
              >
                Save MCP permission
              </Button>
              <Button
                onClick={() =>
                  void act(async () => {
                    await requestJson(
                      `/workspaces/${workspaceId}/mcp-action-grants`,
                      "POST",
                      {
                        connectorId: server,
                        operation,
                        sideEffect: selected.sideEffect,
                        riskLevel: selected.riskLevel,
                        allowWrites: selected.sideEffect !== "read",
                        enabled: false,
                        scopes: selected.scopes,
                      },
                    );
                    setNotice("MCP Action permission disabled");
                  })
                }
              >
                Disable permission
              </Button>
            </>
          )}
        </fieldset>
      )}
    </details>
  );
}
