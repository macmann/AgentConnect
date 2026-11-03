"use client";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  X,
  Search,
  Code2,
  Calculator,
  Database,
  Github,
  BookOpen,
  Plug,
  FileJson,
  ArrowLeft,
} from "lucide-react";
import { toolTemplates } from "@agentconnect/schemas/tool-templates";
import type { z } from "zod";
import type { stdioSettings } from "@agentconnect/schemas/tools";
import { requestJson } from "./agent-client";
import { Button } from "./button";
type Profile = z.infer<typeof stdioSettings>;
type Operation = {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  sideEffect: boolean;
  method?: string;
  path?: string;
};
type Inspection = {
  fingerprint: string;
  operations: Operation[];
  warnings: string[];
};
const icons = {
  brave: Search,
  financial: Calculator,
  github: Github,
  context7: BookOpen,
  code: Code2,
  postgres: Database,
};
const explainError = (message: string) =>
  ({
    TOOL_ENDPOINT_NOT_ALLOWED:
      "This service host needs to be approved in TOOL_ALLOWED_HOSTS by your administrator before it can connect.",
    MCP_STDIO_COMMAND_NOT_APPROVED:
      "Choose a server profile installed and approved by your administrator.",
    TOOL_CREDENTIAL_REQUIRED:
      "Add an API key or select an existing credential.",
    OPENAPI_INVALID_USE_VERSION_3_JSON_OR_YAML:
      "Paste a valid OpenAPI 3.0 or 3.1 specification in JSON or YAML.",
    OPENAPI_NO_SUPPORTED_OPERATIONS:
      "No supported operations were found. Use OpenAPI 3.0/3.1 with simple path/query parameters and JSON request bodies.",
    TOOL_REVIEW_CHANGED_VALIDATE_AGAIN:
      "The service capabilities changed. Go back and validate again before saving.",
    MCP_CONNECTION_FAILED:
      "Could not connect to the MCP server. Check the endpoint, credentials and selected transport.",
    MCP_NO_SUPPORTED_TOOLS:
      "The server did not return any tools with supported argument schemas.",
  })[message] || message;
function inputSummary(schema: Record<string, unknown>) {
  const properties = (schema.properties ?? {}) as Record<
    string,
    { type?: string; properties?: Record<string, unknown>; required?: string[] }
  >;
  const required = Array.isArray(schema.required) ? schema.required : [];
  return (
    Object.entries(properties)
      .flatMap(([name, value]) =>
        value.type === "object" && value.properties
          ? Object.keys(value.properties).map(
              (key) =>
                `${name}.${key}${value.required?.includes(key) ? " *" : ""}`,
            )
          : [`${name}${required.includes(name) ? " *" : ""}`],
      )
      .slice(0, 12)
      .join(" · ") || "No inputs required"
  );
}
export function ToolSetupWizard({
  workspaceId,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  onClose: () => void;
  onSaved: (count: number) => void;
}) {
  const cache = useQueryClient();
  const [authHeader, setAuthHeader] = useState("Authorization");
  const [dbSchema, setDbSchema] = useState("public"),
    [dbTable, setDbTable] = useState(""),
    [dbColumns, setDbColumns] = useState(""),
    [dbFilters, setDbFilters] = useState("");
  const [step, setStep] = useState<"choose" | "configure" | "review">("choose"),
    [mode, setMode] = useState<"template" | "mcp" | "api">("template"),
    [templateId, setTemplate] = useState(""),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [url, setUrl] = useState(""),
    [transport, setTransport] = useState<"http" | "stdio">("http"),
    [profile, setProfile] = useState(""),
    [connectorId, setConnector] = useState(""),
    [credentialMode, setCredentialMode] = useState("new"),
    [credential, setCredential] = useState(""),
    [secretId, setSecret] = useState(""),
    [spec, setSpec] = useState(""),
    [serverUrl, setServer] = useState(""),
    [inspection, setInspection] = useState<Inspection | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [ack, setAck] = useState(false),
    [allowMutations, setMutations] = useState(false),
    [publicAccess, setPublic] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const catalog = useQuery({
    queryKey: ["tool-setup", workspaceId],
    queryFn: () =>
      requestJson<{ stdioProfiles: Profile[] }>(
        `/workspaces/${workspaceId}/tool-setup`,
      ),
  });
  const secrets = useQuery({
    queryKey: ["tool-secrets", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(
        `/workspaces/${workspaceId}/secrets`,
      ),
  });
  const connectors = useQuery({
    queryKey: ["mcp", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string; enabled: boolean }[]>(
        `/workspaces/${workspaceId}/mcp-connectors`,
      ),
  });
  const template = toolTemplates.find((t) => t.id === templateId),
    isMcp = mode === "mcp" || (mode === "template" && template?.kind === "mcp"),
    needsCredential = mode === "api" || isMcp || template?.credential;
  function choose(next: typeof mode, id = "") {
    setMode(next);
    setTemplate(id);
    const t = toolTemplates.find((t) => t.id === id);
    setName(t?.name || "");
    setDescription(t?.description || "");
    setUrl(t?.url || "");
    setAuthHeader(id === "context7" ? "CONTEXT7_API_KEY" : "Authorization");
    setStep("configure");
    setError("");
  }
  function payload() {
    return {
      mode,
      templateId: mode === "template" ? templateId : undefined,
      name,
      description,
      connectorId: isMcp && connectorId ? connectorId : undefined,
      connector:
        isMcp && !connectorId
          ? {
              name,
              url: transport === "http" ? url : "",
              transport,
              authHeader,
              stdio:
                transport === "stdio"
                  ? catalog.data?.stdioProfiles[Number(profile)]
                  : null,
            }
          : undefined,
      credential:
        needsCredential &&
        !connectorId &&
        credentialMode === "new" &&
        credential
          ? credential
          : undefined,
      secretId:
        needsCredential && !connectorId && credentialMode === "existing"
          ? secretId || null
          : null,
      database:
        template?.kind === "database"
          ? {
              schema: dbSchema,
              table: dbTable,
              columns: dbColumns
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
              filterColumns: dbFilters
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            }
          : undefined,
      spec: mode === "api" ? spec : undefined,
      serverUrl: mode === "api" && serverUrl ? serverUrl : undefined,
    };
  }
  async function inspect() {
    setBusy(true);
    setError("");
    try {
      const result = await requestJson<Inspection>(
        `/workspaces/${workspaceId}/tool-setup/inspect`,
        "POST",
        payload(),
      );
      setInspection(result);
      setSelected(result.operations.slice(0, 8).map((o) => o.id));
      setAck(false);
      setMutations(false);
      setStep("review");
    } catch (e) {
      setError(explainError((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      const result = await requestJson<{ tools: { id: string }[] }>(
        `/workspaces/${workspaceId}/tool-setup`,
        "POST",
        {
          ...payload(),
          selected,
          reviewFingerprint: inspection?.fingerprint,
          acknowledged: ack,
          allowMutations,
          publicAccess,
        },
      );
      setCredential("");
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["tools", workspaceId] }),
        cache.invalidateQueries({ queryKey: ["mcp", workspaceId] }),
        cache.invalidateQueries({ queryKey: ["tool-secrets", workspaceId] }),
        cache.invalidateQueries({
          queryKey: ["workflow-catalog", workspaceId],
        }),
        cache.invalidateQueries({
          queryKey: ["action-connections", workspaceId],
        }),
      ]);
      onSaved(result.tools.length);
    } catch (e) {
      setError(explainError((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  const hasSideEffects = inspection?.operations.some(
    (o) => selected.includes(o.id) && o.sideEffect,
  );
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content tool-setup-dialog"
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <div className="tool-dialog-heading">
            <div>
              <Dialog.Title>Add tools</Dialog.Title>
              <Dialog.Description>
                Connect a service, review its capabilities, and make it
                available to your agents.
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="dialog-close"
              aria-label="Close tool setup"
              disabled={busy}
            >
              <X size={18} />
            </Dialog.Close>
          </div>
          <ol className="tool-wizard-steps" aria-label="Setup progress">
            {["Choose", "Configure", "Review & save"].map((label, i) => (
              <li
                key={label}
                aria-current={
                  ["choose", "configure", "review"][i] === step
                    ? "step"
                    : undefined
                }
              >
                <span>{i + 1}</span>
                {label}
              </li>
            ))}
          </ol>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (step === "configure") void inspect();
              else if (step === "review") void save();
            }}
          >
            <fieldset disabled={busy} className="tool-wizard-body">
              {step === "choose" && (
                <>
                  <h3>Start with a template</h3>
                  <p className="muted">
                    Popular integrations with the connection settings already
                    filled in.
                  </p>
                  <div className="tool-template-grid">
                    {toolTemplates.map((t) => {
                      const Icon = icons[t.id];
                      return (
                        <button
                          key={t.id}
                          type="button"
                          className="tool-template-card"
                          onClick={() => choose("template", t.id)}
                        >
                          <Icon size={22} />
                          <strong>{t.name}</strong>
                          <small>{t.service}</small>
                          <span>{t.description}</span>
                        </button>
                      );
                    })}
                  </div>
                  <h3>Connect something else</h3>
                  <div className="tool-custom-options">
                    <button type="button" onClick={() => choose("mcp")}>
                      <Plug size={22} />
                      <span>
                        <strong>MCP server</strong>
                        <small>HTTP or STDIO · discover available tools</small>
                      </span>
                    </button>
                    <button type="button" onClick={() => choose("api")}>
                      <FileJson size={22} />
                      <span>
                        <strong>API / OpenAPI</strong>
                        <small>
                          Paste a specification · extract operations and
                          parameters
                        </small>
                      </span>
                    </button>
                  </div>
                </>
              )}
              {step === "configure" && (
                <>
                  <h3>
                    {template?.name ||
                      (isMcp ? "MCP connection" : "Import an API")}
                  </h3>
                  <label>
                    Tool name
                    <input
                      required
                      maxLength={100}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Customer support search"
                    />
                  </label>
                  {isMcp && (
                    <>
                      <label>
                        Connection
                        <select
                          value={connectorId}
                          onChange={(e) => setConnector(e.target.value)}
                        >
                          <option value="">New MCP connection</option>
                          {connectors.data
                            ?.filter((c) => c.enabled)
                            .map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                        </select>
                      </label>
                      {!connectorId && (
                        <>
                          <label>
                            Transport
                            <select
                              value={transport}
                              onChange={(e) =>
                                setTransport(e.target.value as typeof transport)
                              }
                            >
                              <option value="http">Streamable HTTP</option>
                              <option value="stdio">STDIO</option>
                            </select>
                          </label>
                          {transport === "http" ? (
                            <label>
                              Server URL
                              <input
                                required
                                type="url"
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                placeholder="https://service.example/mcp"
                              />
                            </label>
                          ) : (
                            <>
                              <label>
                                Installed server profile
                                <select
                                  required
                                  value={profile}
                                  onChange={(e) => setProfile(e.target.value)}
                                >
                                  <option value="">
                                    Choose an approved STDIO server
                                  </option>
                                  {catalog.data?.stdioProfiles.map((p, i) => (
                                    <option key={i} value={i}>
                                      {p.command} {p.args.join(" ")}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              {profile !== "" && (
                                <div className="tool-connection-summary">
                                  <strong>Command</strong>
                                  <code>
                                    {
                                      catalog.data?.stdioProfiles[
                                        Number(profile)
                                      ]?.command
                                    }
                                  </code>
                                  <strong>Arguments</strong>
                                  <code>
                                    {JSON.stringify(
                                      catalog.data?.stdioProfiles[
                                        Number(profile)
                                      ]?.args,
                                    )}
                                  </code>
                                </div>
                              )}
                              <p className="muted">
                                STDIO runs an installed server profile approved
                                by your administrator. Code execution servers
                                must provide their own sandbox.
                              </p>
                              {!catalog.data?.stdioProfiles.length && (
                                <p role="status">
                                  No STDIO servers are installed. An
                                  administrator can add a server using
                                  TOOL_STDIO_PROFILES.
                                </p>
                              )}
                            </>
                          )}
                        </>
                      )}
                    </>
                  )}
                  {template?.kind === "database" && (
                    <div className="form-grid">
                      <label>
                        Database schema
                        <input
                          required
                          value={dbSchema}
                          onChange={(e) => setDbSchema(e.target.value)}
                        />
                      </label>
                      <label>
                        Table or view
                        <input
                          required
                          value={dbTable}
                          onChange={(e) => setDbTable(e.target.value)}
                        />
                      </label>
                      <label>
                        Returned columns
                        <input
                          required
                          value={dbColumns}
                          onChange={(e) => setDbColumns(e.target.value)}
                          placeholder="id, name, status"
                        />
                      </label>
                      <label>
                        Filter columns (optional)
                        <input
                          value={dbFilters}
                          onChange={(e) => setDbFilters(e.target.value)}
                          placeholder="id, status"
                        />
                      </label>
                      <p className="muted">
                        Use a dedicated SELECT-only PostgreSQL login. Enter its
                        connection URL as the credential below.
                      </p>
                    </div>
                  )}
                  {mode === "api" && (
                    <>
                      <label>
                        OpenAPI specification
                        <textarea
                          required
                          rows={10}
                          value={spec}
                          onChange={(e) => setSpec(e.target.value)}
                          maxLength={300000}
                          spellCheck={false}
                          placeholder={
                            "openapi: 3.1.0\ninfo:\n  title: My API\n  version: 1.0.0\nservers:\n  - url: https://api.example.com\npaths: ..."
                          }
                        />
                      </label>
                      <small>
                        OpenAPI 3.0 / 3.1 · JSON or YAML. Parameters, required
                        fields, JSON bodies and authentication are extracted
                        automatically.
                      </small>
                      <label>
                        Server URL override (optional)
                        <input
                          type="url"
                          value={serverUrl}
                          onChange={(e) => setServer(e.target.value)}
                          placeholder="Use the specification’s server URL"
                        />
                      </label>
                    </>
                  )}
                  {isMcp && !connectorId && transport === "http" && (
                    <details>
                      <summary>Authentication settings</summary>
                      <label>
                        Credential header
                        <input
                          value={authHeader}
                          onChange={(e) => setAuthHeader(e.target.value)}
                          required
                          maxLength={63}
                        />
                      </label>
                      <small>
                        Authorization sends a bearer token. Other header names
                        send the key directly.
                      </small>
                    </details>
                  )}
                  {needsCredential && !connectorId && (
                    <div className="tool-credential-fields">
                      <label>
                        Credential
                        <select
                          value={credentialMode}
                          onChange={(e) => setCredentialMode(e.target.value)}
                        >
                          <option value="new">Add API key / token</option>
                          <option value="existing">Use saved credential</option>
                          <option value="none">No credential</option>
                        </select>
                      </label>
                      {credentialMode === "new" && (
                        <label>
                          {template?.kind === "database"
                            ? "PostgreSQL connection URL"
                            : "API key / token"}
                          <input
                            type="password"
                            autoComplete="new-password"
                            value={credential}
                            onChange={(e) => setCredential(e.target.value)}
                            maxLength={8000}
                            required={template?.credential === true}
                          />
                        </label>
                      )}
                      {credentialMode === "existing" && (
                        <label>
                          Saved credential
                          <select
                            required
                            value={secretId}
                            onChange={(e) => setSecret(e.target.value)}
                          >
                            <option value="">Choose a credential</option>
                            {secrets.data?.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <small>
                        New credentials are encrypted when you save. They are
                        never included in tool parameters.
                      </small>
                    </div>
                  )}
                  <details>
                    <summary>Description & access</summary>
                    <label>
                      Description for the agent
                      <textarea
                        maxLength={1500}
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                      />
                    </label>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={publicAccess}
                        onChange={(e) => setPublic(e.target.checked)}
                      />
                      Allow use by anonymous published agents
                    </label>
                  </details>
                </>
              )}
              {step === "review" && inspection && (
                <>
                  <h3>Review discovered tools</h3>
                  <p className="muted">
                    Choose up to 8 tools. Agents can use multiple saved tools.
                  </p>
                  <div className="tool-operation-list">
                    {inspection.operations.map((o) => (
                      <article key={o.id}>
                        <label className="tool-operation-choice">
                          <input
                            type="checkbox"
                            checked={selected.includes(o.id)}
                            disabled={
                              !selected.includes(o.id) && selected.length >= 8
                            }
                            onChange={(e) =>
                              setSelected((s) =>
                                e.target.checked
                                  ? [...s, o.id]
                                  : s.filter((id) => id !== o.id),
                              )
                            }
                          />
                          <span>
                            <strong>{o.name}</strong>
                            <small>
                              {o.method ? `${o.method} ${o.path}` : o.id}
                            </small>
                          </span>
                          <span
                            className={`badge ${o.sideEffect ? "warning" : ""}`}
                          >
                            {o.sideEffect
                              ? "Can change data / run code"
                              : "Read only"}
                          </span>
                        </label>
                        <p>{o.description}</p>
                        <p className="tool-input-summary">
                          Inputs: {inputSummary(o.inputSchema)}
                        </p>
                        <details>
                          <summary>Parameters & input schema</summary>
                          <pre>{JSON.stringify(o.inputSchema, null, 2)}</pre>
                        </details>
                      </article>
                    ))}
                  </div>
                  {inspection.warnings.length > 0 && (
                    <details className="tool-import-warnings">
                      <summary>
                        {inspection.warnings.length} unsupported operations or
                        schemas skipped
                      </summary>
                      <ul>
                        {inspection.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {hasSideEffects && (
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={allowMutations}
                        onChange={(e) => setMutations(e.target.checked)}
                      />
                      Allow selected operations to change data or execute code
                      when requested by the user.
                    </label>
                  )}
                  <label className="checkbox-row">
                    <input
                      required
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                    />
                    I reviewed the selected tools, their access, and the data
                    they return.
                  </label>
                  <p className="muted">
                    After saving, attach these tools in Agent → Configure →
                    Tools.
                  </p>
                </>
              )}
            </fieldset>
            <div className="tool-wizard-footer">
              {step !== "choose" ? (
                <Button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setStep(step === "review" ? "configure" : "choose");
                    setError("");
                  }}
                >
                  <ArrowLeft size={15} />
                  Back
                </Button>
              ) : (
                <Button type="button" className="secondary" onClick={onClose}>
                  Cancel
                </Button>
              )}
              {step === "configure" && (
                <Button type="submit" disabled={busy}>
                  {busy ? "Validating connection…" : "Validate & continue"}
                </Button>
              )}
              {step === "review" && (
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    !ack ||
                    !selected.length ||
                    (!!hasSideEffects && !allowMutations)
                  }
                >
                  {busy
                    ? "Saving…"
                    : `Save ${selected.length === 1 ? "tool" : `${selected.length} tools`}`}
                </Button>
              )}
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
