"use client";
import { useState, useRef, useEffect, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  ArrowUpRight,
  Save,
  Upload,
  Trash2,
  ChevronLeft,
} from "lucide-react";
import { Button } from "./button";
import { Citations, type Citation } from "./citations";
import { ToolTraces, type ToolTrace } from "./tool-studio";
import { ChatPanel } from "./chat-panel";
import { GenerativeResponse } from "./generative-response";
import {
  blockNames,
  type RenderedBlock,
} from "@agentconnect/schemas/generative";
import { MessageReview } from "./message-review";
import { permitted, type Role } from "@agentconnect/schemas/foundation";
import { AgentAttachments } from "./agent-attachments";
import { requestJson } from "./agent-client";
type Model = {
  id: string;
  name: string;
  provider: string;
  model_id: string;
  max_output_tokens: number;
  context_window: number;
  base_url: string;
  secret_id: string | null;
  revision: number;
  capabilities: { streaming: true; temperature: boolean; topP: boolean };
};
type AgentSummary = {
  id: string;
  name: string;
  description: string;
  revision: number;
};
type Prompt = {
  role: string;
  objective: string;
  instructions: string;
  constraints: string;
  tone: string;
  outputFormat: string;
  escalationPolicy: string;
  advanced: string | null;
};
type Config = {
  generative?: {
    enabled: boolean;
    allowedBlocks: (typeof blockNames)[number][];
    allowPublicForms: boolean;
  };
  schemaVersion: 1;
  tools: { toolIds: string[]; maxCalls: number };
  rag: {
    knowledgeBaseIds: string[];
    topK: number;
    minScore: number;
    mode: "vector" | "hybrid";
    requireCitations: boolean;
  };
  category: "hybrid" | "structured" | "unstructured";
  modelId: string;
  prompt: Prompt;
  temperature: number;
  topP: number | null;
  maxOutputTokens: number;
  historyWindow: number;
  language: string;
  timezone: string;
  welcomeMessage: string;
  conversationStarters: string[];
  fallbackResponse: string;
};
type Draft = {
  id?: string;
  name: string;
  description: string;
  publicDescription: string;
  config: Config;
  revision: number;
};
type AgentRow = {
  id: string;
  name: string;
  description: string;
  public_description: string;
  draft_config: Config;
  revision: number;
};
type Version = {
  id: string;
  version: number;
  name: string;
  config: Config;
  published_at: string;
};
type Deployment = {
  id: string;
  name: string;
  version: number;
  enabled: boolean;
};
const defaultPrompt: Prompt = {
  role: "You are a helpful assistant.",
  objective: "",
  instructions: "",
  constraints: "",
  tone: "",
  outputFormat: "",
  escalationPolicy: "",
  advanced: null,
};
function emptyDraft(modelId: string): Draft {
  return {
    name: "",
    description: "",
    publicDescription: "",
    revision: 1,
    config: {
      schemaVersion: 1,
      tools: { toolIds: [], maxCalls: 3 },
      rag: {
        knowledgeBaseIds: [],
        topK: 5,
        minScore: 0.2,
        mode: "hybrid",
        requireCitations: true,
      },
      category: "hybrid",
      modelId,
      prompt: defaultPrompt,
      temperature: 0.7,
      topP: null,
      maxOutputTokens: 1024,
      historyWindow: 10,
      language: "English",
      timezone: "UTC",
      welcomeMessage: "How can I help you today?",
      conversationStarters: [],
      fallbackResponse: "The model is unavailable. Please try again later.",
    },
  };
}
export function Models({
  workspaceId,
  role,
}: {
  workspaceId: string;
  role: string;
}) {
  const cache = useQueryClient();
  const models = useQuery({
    queryKey: ["models", workspaceId],
    queryFn: () => requestJson<Model[]>(`/workspaces/${workspaceId}/models`),
  });
  const canManage = ["owner", "org_admin", "workspace_admin"].includes(role);
  const secrets = useQuery({
    queryKey: ["secrets", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(
        `/workspaces/${workspaceId}/secrets`,
      ),
    enabled: canManage,
  });
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Model | null>(null);
  const [deleting, setDeleting] = useState<Model | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (formOpen)
      formRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [formOpen, editing]);
  const [provider, setProvider] = useState("openai");
  const [credential, setCredential] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await requestJson(
        editing ? `/models/${editing.id}` : `/workspaces/${workspaceId}/models`,
        editing ? "PUT" : "POST",
        {
          ...(editing ? { revision: editing.revision } : {}),
          name: f.get("name"),
          provider,
          modelId: f.get("modelId"),
          secretId: f.get("secretId") || null,
          baseUrl:
            provider === "openai-compatible" ? f.get("baseUrl") : undefined,
          contextWindow: Number(f.get("contextWindow")),
          maxOutputTokens: Number(f.get("maxOutputTokens")),
          capabilities: {
            streaming: true,
            temperature: f.get("temperature") === "on",
            topP: f.get("topP") === "on",
          },
        },
      );
      await cache.invalidateQueries({ queryKey: ["models", workspaceId] });
      setFormOpen(false);
      setNotice(
        editing
          ? "Model updated. Published agent versions keep their existing settings."
          : "Model registered",
      );
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function deleteModel() {
    if (!deleting) return;
    setBusy(true);
    setError("");
    try {
      await requestJson(`/models/${deleting.id}`, "DELETE", {
        revision: deleting.revision,
      });
      await cache.invalidateQueries({ queryKey: ["models", workspaceId] });
      if (editing?.id === deleting.id) {
        setEditing(null);
        setFormOpen(false);
      }
      setDeleting(null);
      setNotice(
        "Model deleted from the registry. Published versions and run history are retained.",
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function testModel(model: Model) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await requestJson<{ response: string }>(
        `/models/${model.id}/test`,
        "POST",
      );
      setNotice(`Connected to ${model.name}: ${result.response}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h3>Model registry</h3>
          <p>
            Workspace-owned providers. Credentials stay encrypted on the server.
          </p>
        </div>
        {canManage && (
          <Button
            onClick={() => {
              setEditing(null);
              setProvider("openai");
              setCredential("");
              setFormOpen(!formOpen || !!editing);
              setError("");
              setNotice("");
            }}
          >
            <Plus size={15} />
            Register model
          </Button>
        )}
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {deleting && (
        <div className="notice" role="alert">
          <p>
            Delete {deleting.name} from the registry? Published versions and
            historical runs are retained. Active agent drafts must switch to
            another model first.
          </p>
          <Button className="danger" disabled={busy} onClick={deleteModel}>
            Delete model
          </Button>
          <Button
            className="secondary"
            disabled={busy}
            onClick={() => setDeleting(null)}
          >
            Cancel deletion
          </Button>
        </div>
      )}
      {formOpen && (
        <form
          ref={formRef}
          key={editing?.id ?? "new"}
          className="studio-form"
          onSubmit={create}
        >
          {editing && <h4>Edit model: {editing.name}</h4>}
          <div className="form-grid">
            <label>
              Display name
              <input
                name="name"
                required
                maxLength={100}
                defaultValue={editing?.name ?? ""}
              />
            </label>
            <label>
              Provider
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="gemini">Google Gemini</option>
                <option value="openai-compatible">OpenAI-compatible</option>
              </select>
            </label>
            <label>
              Model identifier
              <input
                name="modelId"
                defaultValue={editing?.model_id ?? ""}
                required
                placeholder="Provider model identifier"
                maxLength={150}
              />
            </label>
            <label>
              Workspace credential
              <select
                name="secretId"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                required={provider !== "openai-compatible"}
              >
                <option value="">
                  {provider === "openai-compatible"
                    ? "None (no authentication)"
                    : "Select encrypted secret"}
                </option>
                {secrets.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <small>
                For hosted providers such as DeepSeek, select the API-key secret
                saved in this workspace. Saving a secret does not select it
                automatically. Values are never returned here.
              </small>
            </label>
            {secrets.error && (
              <p className="error-banner" role="alert">
                Cannot load workspace credentials: {secrets.error.message}
              </p>
            )}
            {provider === "openai-compatible" && (
              <label>
                Base URL
                <input
                  name="baseUrl"
                  defaultValue={editing?.base_url ?? ""}
                  type="url"
                  required
                  placeholder="https://approved-host.example/v1"
                />
                <small>
                  Custom hosts require server approval through
                  MODEL_ALLOWED_HOSTS. Restart the API and worker after changing
                  that setting.
                </small>
              </label>
            )}
            <label>
              Context window
              <input
                name="contextWindow"
                type="number"
                defaultValue={editing?.context_window ?? 32768}
                min={256}
                max={2000000}
                required
              />
            </label>
            <label>
              Maximum output tokens
              <input
                name="maxOutputTokens"
                type="number"
                defaultValue={editing?.max_output_tokens ?? 4096}
                min={1}
                max={2000000}
                required
              />
            </label>
          </div>
          <div className="checkbox-row">
            <label>
              <input
                name="temperature"
                type="checkbox"
                defaultChecked={editing?.capabilities.temperature ?? true}
              />
              Supports temperature
            </label>
            <label>
              <input
                name="topP"
                type="checkbox"
                defaultChecked={editing?.capabilities.topP ?? true}
              />
              Supports top-p
            </label>
          </div>
          <Button disabled={busy} type="submit">
            {busy ? "Saving…" : editing ? "Save changes" : "Save model"}
          </Button>
          <Button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              setEditing(null);
              setFormOpen(false);
            }}
          >
            Cancel
          </Button>
        </form>
      )}
      {models.isPending ? (
        <p className="empty">Loading models…</p>
      ) : models.error ? (
        <p className="error-banner">{models.error.message}</p>
      ) : models.data?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Provider / model</th>
                <th>Context</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {models.data.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>
                    {m.provider}
                    <small className="block muted">{m.model_id}</small>
                  </td>
                  <td className="numeric">
                    {m.context_window.toLocaleString()}
                  </td>
                  <td>
                    {canManage && (
                      <>
                        <Button
                          className="secondary"
                          disabled={busy}
                          onClick={() => {
                            setEditing(m);
                            setProvider(m.provider);
                            setCredential(m.secret_id ?? "");
                            setFormOpen(true);
                            setError("");
                            setNotice("");
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          className="danger"
                          disabled={busy}
                          onClick={() => {
                            setDeleting(m);
                            setError("");
                            setNotice("");
                          }}
                        >
                          Delete
                        </Button>
                        <Button
                          className="secondary"
                          disabled={busy}
                          onClick={() => testModel(m)}
                        >
                          Test connection
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
          <h3>Connect your first model</h3>
          <p>
            Register a provider and encrypted workspace credential to enable
            agent chat.
          </p>
        </div>
      )}
    </section>
  );
}
export function AgentStudio({
  workspaceId,
  role,
  onNavigate,
}: {
  workspaceId: string;
  role: string;
  onNavigate: (destination: "Knowledge" | "Tools" | "Models") => void;
}) {
  const cache = useQueryClient();
  const canBuild = [
    "owner",
    "org_admin",
    "workspace_admin",
    "builder",
  ].includes(role);
  const agents = useQuery({
    queryKey: ["agents", workspaceId],
    queryFn: () =>
      requestJson<AgentSummary[]>(`/workspaces/${workspaceId}/agents`),
  });
  const models = useQuery({
    queryKey: ["models", workspaceId],
    queryFn: () => requestJson<Model[]>(`/workspaces/${workspaceId}/models`),
  });
  const tools = useQuery({
    queryKey: ["tools", workspaceId],
    queryFn: () =>
      requestJson<
        { id: string; name: string; enabled: boolean; public_access: boolean }[]
      >(`/workspaces/${workspaceId}/tools`),
    enabled: canBuild,
  });
  const knowledge = useQuery({
    queryKey: ["knowledge", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string; public_access: boolean }[]>(
        `/workspaces/${workspaceId}/knowledge-bases`,
      ),
    enabled: canBuild,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedDraft, setSavedDraft] = useState("");
  const dirty = !!draft?.id && JSON.stringify(draft) !== savedDraft;
  function navigateAttachments(destination: "Knowledge" | "Tools") {
    if (
      (dirty || (draft && !draft.id)) &&
      !window.confirm(
        "Leave this agent? Unsaved changes will be lost. Save your agent first to keep them.",
      )
    )
      return;
    onNavigate(destination);
  }
  const [tab, setTab] = useState<"configure" | "playground" | "publish">(
    "configure",
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [chatKey, setChatKey] = useState(0);
  const versions = useQuery({
    queryKey: ["versions", draft?.id],
    queryFn: () => requestJson<Version[]>(`/agents/${draft?.id}/versions`),
    enabled: !!draft?.id,
  });
  const deployments = useQuery({
    queryKey: ["deployments", draft?.id],
    queryFn: () =>
      requestJson<Deployment[]>(`/agents/${draft?.id}/deployments`),
    enabled: !!draft?.id,
  });
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
  async function open(id: string) {
    await action(async () => {
      const a = await requestJson<AgentRow>(`/agents/${id}`);
      const loaded: Draft = {
        id: a.id,
        name: a.name,
        description: a.description,
        publicDescription: a.public_description,
        config: {
          ...a.draft_config,
          tools: a.draft_config.tools ?? { toolIds: [], maxCalls: 3 },
          rag: a.draft_config.rag ?? {
            knowledgeBaseIds: [],
            topK: 5,
            minScore: 0.2,
            mode: "hybrid",
            requireCitations: true,
          },
        },
        revision: a.revision,
      };
      setDraft(loaded);
      setSavedDraft(JSON.stringify(loaded));
      setChatKey((k) => k + 1);
      setTab("configure");
    });
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    await action(async () => {
      const result = await requestJson<{ id: string; revision: number }>(
        draft.id ? `/agents/${draft.id}` : `/workspaces/${workspaceId}/agents`,
        draft.id ? "PUT" : "POST",
        draft,
      );
      const saved = { ...draft, id: result.id, revision: result.revision };
      setDraft(saved);
      setSavedDraft(JSON.stringify(saved));
      setChatKey((k) => k + 1);
      setNotice("Draft saved. Start a new chat to use these changes.");
    });
  }
  function configField<K extends keyof Config>(field: K, value: Config[K]) {
    if (draft)
      setDraft({ ...draft, config: { ...draft.config, [field]: value } });
  }
  function promptField(field: keyof Prompt, value: string | null) {
    if (draft)
      configField("prompt", { ...draft.config.prompt, [field]: value });
  }
  return (
    <>
      <section className="panel">
        <div className="panel-header">
          <div>
            <h3>{draft ? "Agent studio" : "Your agents"}</h3>
            <p>
              {draft
                ? `Draft revision ${draft.revision}${dirty ? " · Unsaved changes" : ""} · save before chat or publication`
                : "Create, test, version, and deploy your AI agents."}
            </p>
          </div>
          {draft ? (
            <button
              className="text-button"
              onClick={() => {
                if (
                  (dirty || !draft.id) &&
                  !window.confirm("Discard unsaved agent changes?")
                )
                  return;
                setDraft(null);
                setError("");
                setNotice("");
              }}
            >
              <ChevronLeft size={14} />
              All agents
            </button>
          ) : (
            canBuild && (
              <Button
                disabled={!models.data?.length}
                title={
                  !models.data?.length
                    ? "Register a model in Models before creating an agent."
                    : undefined
                }
                onClick={() => {
                  setDraft(emptyDraft(models.data![0]!.id));
                  setTab("configure");
                  setError("");
                  setNotice("");
                }}
              >
                <Plus size={15} />
                Create agent
              </Button>
            )
          )}
        </div>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {!draft &&
          canBuild &&
          (models.isPending ? (
            <p role="status">Loading workspace models…</p>
          ) : models.error ? (
            <p className="error-banner" role="alert">
              Cannot load workspace models: {models.error.message}
            </p>
          ) : !models.data?.length ? (
            <p className="notice" role="status">
              To enable Create agent, register a model in Models for this
              workspace.{" "}
              <button
                type="button"
                className="text-button"
                onClick={() => onNavigate("Models")}
              >
                Register a model
              </button>
            </p>
          ) : null)}
        {!draft &&
          (agents.isPending ? (
            <p className="empty">Loading agents…</p>
          ) : agents.error ? (
            <p className="error-banner">{agents.error.message}</p>
          ) : agents.data?.length ? (
            <div className="workspace-grid">
              {agents.data.map((a) => (
                <button
                  className="workspace-card"
                  key={a.id}
                  onClick={() => open(a.id)}
                >
                  <div>
                    <h4>{a.name}</h4>
                    <p>{a.description || "No description"}</p>
                  </div>
                  <ArrowUpRight size={17} />
                  <span className="workspace-footer">
                    Draft revision {a.revision}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty">
              <h3>Your next agent starts here</h3>
              <p>
                {models.data?.length
                  ? "Create an agent, define its instructions, and test it in the playground."
                  : "Register a model in Models before creating an agent."}
              </p>
            </div>
          ))}
        {draft && (
          <>
            <div className="studio-tabs">
              {(["configure", "playground", "publish"] as const).map((t) => (
                <button
                  className={tab === t ? "active" : ""}
                  key={t}
                  onClick={() => setTab(t)}
                  disabled={(!draft.id || dirty) && t !== "configure"}
                >
                  {t}
                </button>
              ))}
            </div>
            {tab === "configure" && (
              <form className="studio-form" onSubmit={save}>
                <fieldset disabled={!canBuild || busy}>
                  <div className="form-grid">
                    <label>
                      Agent name
                      <input
                        required
                        value={draft.name}
                        onChange={(e) =>
                          setDraft({ ...draft, name: e.target.value })
                        }
                        maxLength={100}
                      />
                    </label>
                    <label>
                      Model
                      <select
                        value={draft.config.modelId}
                        onChange={(e) => configField("modelId", e.target.value)}
                        required
                      >
                        {models.data?.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Internal description
                      <input
                        value={draft.description}
                        onChange={(e) =>
                          setDraft({ ...draft, description: e.target.value })
                        }
                        maxLength={2000}
                      />
                    </label>
                    <label>
                      Public description
                      <input
                        value={draft.publicDescription}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            publicDescription: e.target.value,
                          })
                        }
                        maxLength={2000}
                      />
                    </label>
                  </div>
                  <section className="agent-attachments generative-settings">
                    <h4>Generative responses</h4>
                    <p className="muted">
                      Let this agent choose charts, tables, forms and
                      downloadable files. Responses use validated components;
                      submissions require confirmation.
                    </p>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={draft.config.generative?.enabled ?? false}
                        onChange={(e) =>
                          configField("generative", {
                            enabled: e.target.checked,
                            allowedBlocks: draft.config.generative
                              ?.allowedBlocks ?? [...blockNames],
                            allowPublicForms:
                              draft.config.generative?.allowPublicForms ??
                              false,
                          })
                        }
                      />
                      Enable generative responses
                    </label>
                    {draft.config.generative?.enabled && (
                      <>
                        <fieldset>
                          <legend>Allowed response components</legend>
                          <div className="capabilities">
                            {blockNames.map((name) => (
                              <label className="checkbox-label" key={name}>
                                <input
                                  type="checkbox"
                                  checked={draft.config.generative!.allowedBlocks.includes(
                                    name,
                                  )}
                                  disabled={
                                    draft.config.generative!.allowedBlocks
                                      .length === 1 &&
                                    draft.config.generative!.allowedBlocks.includes(
                                      name,
                                    )
                                  }
                                  onChange={(e) =>
                                    configField("generative", {
                                      ...draft.config.generative!,
                                      allowedBlocks: e.target.checked
                                        ? [
                                            ...draft.config.generative!
                                              .allowedBlocks,
                                            name,
                                          ]
                                        : draft.config.generative!.allowedBlocks.filter(
                                            (b) => b !== name,
                                          ),
                                    })
                                  }
                                />
                                {name}
                              </label>
                            ))}
                          </div>
                        </fieldset>
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={draft.config.generative.allowPublicForms}
                            onChange={(e) =>
                              configField("generative", {
                                ...draft.config.generative!,
                                allowPublicForms: e.target.checked,
                              })
                            }
                          />
                          Allow confirmed form/action submissions in public chat
                        </label>
                        <p className="muted">
                          Public collection is off by default. Publish a new
                          version after changing this setting.
                        </p>
                      </>
                    )}
                  </section>
                  <AgentAttachments
                    kind="tools"
                    items={tools.data?.filter((t) => t.enabled) ?? []}
                    selected={draft.config.tools.toolIds}
                    loading={tools.isPending}
                    error={tools.error}
                    onRetry={() => {
                      void tools.refetch();
                    }}
                    onNavigate={() => navigateAttachments("Tools")}
                    canManage={[
                      "owner",
                      "org_admin",
                      "workspace_admin",
                    ].includes(role)}
                    onToggle={(id, checked) =>
                      configField("tools", {
                        ...draft.config.tools,
                        toolIds: checked
                          ? [...draft.config.tools.toolIds, id]
                          : draft.config.tools.toolIds.filter(
                              (value) => value !== id,
                            ),
                      })
                    }
                  />
                  {!!draft.config.tools.toolIds.length && (
                    <label>
                      Maximum tool calls per response
                      <input
                        type="number"
                        min={1}
                        max={5}
                        value={draft.config.tools.maxCalls}
                        onChange={(e) =>
                          configField("tools", {
                            ...draft.config.tools,
                            maxCalls: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                  )}
                  <AgentAttachments
                    kind="knowledge"
                    items={knowledge.data ?? []}
                    selected={draft.config.rag.knowledgeBaseIds}
                    loading={knowledge.isPending}
                    error={knowledge.error}
                    onRetry={() => {
                      void knowledge.refetch();
                    }}
                    onNavigate={() => navigateAttachments("Knowledge")}
                    canManage={canBuild}
                    onToggle={(id, checked) =>
                      configField("rag", {
                        ...draft.config.rag,
                        knowledgeBaseIds: checked
                          ? [...draft.config.rag.knowledgeBaseIds, id]
                          : draft.config.rag.knowledgeBaseIds.filter(
                              (value) => value !== id,
                            ),
                      })
                    }
                  />
                  {!!draft.config.rag.knowledgeBaseIds.length && (
                    <div className="form-grid">
                      <label>
                        Knowledge passages
                        <input
                          type="number"
                          min={1}
                          max={10}
                          value={draft.config.rag.topK}
                          onChange={(e) =>
                            configField("rag", {
                              ...draft.config.rag,
                              topK: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Knowledge minimum similarity
                        <input
                          type="number"
                          min={0}
                          max={1}
                          step={0.05}
                          value={draft.config.rag.minScore}
                          onChange={(e) =>
                            configField("rag", {
                              ...draft.config.rag,
                              minScore: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Knowledge retrieval mode
                        <select
                          aria-label="Knowledge retrieval mode"
                          value={draft.config.rag.mode}
                          onChange={(e) =>
                            configField("rag", {
                              ...draft.config.rag,
                              mode: e.target.value as "vector" | "hybrid",
                            })
                          }
                        >
                          <option value="hybrid">Hybrid vector + text</option>
                          <option value="vector">Vector similarity</option>
                        </select>
                      </label>
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={draft.config.rag.requireCitations}
                          onChange={(e) =>
                            configField("rag", {
                              ...draft.config.rag,
                              requireCitations: e.target.checked,
                            })
                          }
                        />{" "}
                        Require citation references
                      </label>
                    </div>
                  )}
                  <h4>Prompt configuration</h4>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={draft.config.prompt.advanced !== null}
                      onChange={(e) =>
                        promptField("advanced", e.target.checked ? "" : null)
                      }
                    />
                    Advanced prompt mode
                  </label>
                  {draft.config.prompt.advanced !== null ? (
                    <label>
                      System prompt
                      <textarea
                        value={draft.config.prompt.advanced}
                        onChange={(e) =>
                          promptField("advanced", e.target.value)
                        }
                        maxLength={24000}
                      />
                    </label>
                  ) : (
                    <div className="form-grid">
                      {(
                        [
                          "role",
                          "objective",
                          "instructions",
                          "constraints",
                          "tone",
                          "outputFormat",
                          "escalationPolicy",
                        ] as const
                      ).map((key) => (
                        <label key={key}>
                          {
                            {
                              role: "Role",
                              objective: "Objective",
                              instructions: "Instructions",
                              constraints: "Constraints",
                              tone: "Tone",
                              outputFormat: "Output format",
                              escalationPolicy: "Escalation policy",
                            }[key]
                          }
                          <textarea
                            value={draft.config.prompt[key]}
                            onChange={(e) => promptField(key, e.target.value)}
                            maxLength={
                              key === "instructions"
                                ? 12000
                                : key === "tone"
                                  ? 1000
                                  : key === "outputFormat" ||
                                      key === "escalationPolicy"
                                    ? 2000
                                    : 4000
                            }
                          />
                        </label>
                      ))}
                    </div>
                  )}
                  <div className="form-grid">
                    <label>
                      Temperature
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.1}
                        value={draft.config.temperature}
                        onChange={(e) =>
                          configField("temperature", Number(e.target.value))
                        }
                      />
                    </label>
                    <label>
                      Top-p (optional)
                      <input
                        type="number"
                        min={0.01}
                        max={1}
                        step={0.01}
                        value={draft.config.topP ?? ""}
                        onChange={(e) =>
                          configField(
                            "topP",
                            e.target.value === ""
                              ? null
                              : Number(e.target.value),
                          )
                        }
                      />
                    </label>
                    <label>
                      Maximum output tokens
                      <input
                        type="number"
                        min={1}
                        max={
                          models.data?.find(
                            (m) => m.id === draft.config.modelId,
                          )?.max_output_tokens ?? 2000000
                        }
                        value={draft.config.maxOutputTokens}
                        onChange={(e) =>
                          configField("maxOutputTokens", Number(e.target.value))
                        }
                      />
                    </label>
                    <label>
                      Conversation history (turns)
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={draft.config.historyWindow}
                        onChange={(e) =>
                          configField("historyWindow", Number(e.target.value))
                        }
                      />
                    </label>
                    <label>
                      Language
                      <input
                        value={draft.config.language}
                        onChange={(e) =>
                          configField("language", e.target.value)
                        }
                      />
                    </label>
                    <label>
                      Timezone
                      <input
                        value={draft.config.timezone}
                        onChange={(e) =>
                          configField("timezone", e.target.value)
                        }
                      />
                    </label>
                    <label>
                      Welcome message
                      <input
                        value={draft.config.welcomeMessage}
                        onChange={(e) =>
                          configField("welcomeMessage", e.target.value)
                        }
                        maxLength={2000}
                      />
                    </label>
                    <label>
                      Fallback response
                      <input
                        value={draft.config.fallbackResponse}
                        onChange={(e) =>
                          configField("fallbackResponse", e.target.value)
                        }
                        maxLength={2000}
                      />
                    </label>
                    <label>
                      Conversation starters (one per line)
                      <textarea
                        value={draft.config.conversationStarters.join("\n")}
                        onChange={(e) =>
                          configField(
                            "conversationStarters",
                            e.target.value
                              .split("\n")
                              .filter(Boolean)
                              .slice(0, 6),
                          )
                        }
                      />
                    </label>
                    <label>
                      Category
                      <select
                        value={draft.config.category}
                        onChange={(e) =>
                          configField(
                            "category",
                            e.target.value as Config["category"],
                          )
                        }
                      >
                        <option value="hybrid">Hybrid</option>
                        <option value="unstructured">Unstructured</option>
                        <option value="structured">Structured</option>
                      </select>
                      <small>
                        Choose how this agent organizes and answers questions.
                      </small>
                    </label>
                  </div>
                  {canBuild && (
                    <div className="studio-actions">
                      <Button type="submit" disabled={busy}>
                        <Save size={15} />
                        {busy ? "Saving…" : "Save draft"}
                      </Button>
                      {draft.id && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => {
                            if (
                              window.confirm(
                                "Archive this agent and disable its deployments?",
                              )
                            )
                              void action(async () => {
                                await requestJson(
                                  `/agents/${draft.id}`,
                                  "DELETE",
                                );
                                setDraft(null);
                              });
                          }}
                        >
                          <Trash2 size={14} />
                          Archive agent
                        </button>
                      )}
                    </div>
                  )}
                </fieldset>
              </form>
            )}
            {tab === "playground" && draft.id && canBuild && (
              <ChatPanel
                diagnostics
                key={`${draft.id}-${chatKey}`}
                endpoint={`/agents/${draft.id}/chat`}
                name={draft.name}
                welcomeMessage={draft.config.welcomeMessage}
                starters={draft.config.conversationStarters}
              />
            )}{" "}
            {tab === "playground" && !canBuild && (
              <p className="empty">
                Playground execution requires builder access.
              </p>
            )}
            {tab === "publish" && draft.id && (
              <div className="studio-form">
                <div className="publish-heading">
                  <div>
                    <h3>Immutable versions</h3>
                    <p className="muted">
                      A deployment keeps its published prompt and model
                      settings.
                    </p>
                  </div>
                  {canBuild && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        action(async () => {
                          const v = await requestJson<Version>(
                            `/agents/${draft.id}/publish`,
                            "POST",
                            { revision: draft.revision },
                          );
                          setNotice(`Version ${v.version} published`);
                        })
                      }
                    >
                      <Upload size={15} />
                      Publish saved draft
                    </Button>
                  )}
                </div>
                {versions.error && (
                  <p className="error">{versions.error.message}</p>
                )}
                {versions.data?.map((v) => (
                  <div className="version-row" key={v.id}>
                    <div>
                      <strong>Version {v.version}</strong>
                      <small>{new Date(v.published_at).toLocaleString()}</small>
                      <details>
                        <summary>Inspect configuration</summary>
                        <pre>{JSON.stringify(v.config, null, 2)}</pre>
                      </details>
                    </div>
                    {canBuild && (
                      <div className="studio-actions">
                        <Button
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            action(async () => {
                              await requestJson(
                                `/agents/${draft.id}/deployments`,
                                "POST",
                                {
                                  versionId: v.id,
                                  name: `${draft.name} v${v.version}`,
                                },
                              );
                              setNotice("Hosted deployment created");
                            })
                          }
                        >
                          Create hosted deployment
                        </Button>
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() =>
                            action(async () => {
                              await requestJson(
                                `/agents/${draft.id}/rollback/${v.id}`,
                                "POST",
                                { revision: draft.revision },
                              );
                              await open(draft.id!);
                              setNotice(
                                `Version ${v.version} restored into draft. Deployments are unchanged.`,
                              );
                            })
                          }
                        >
                          Restore draft
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                {!versions.data?.length && (
                  <p className="empty">
                    Publish the saved draft to create its first version.
                  </p>
                )}
                <h3 className="section-gap">Hosted deployments</h3>
                {deployments.data?.map((d) => (
                  <div className="version-row" key={d.id}>
                    <div>
                      <strong>{d.name}</strong>
                      <small>
                        Version {d.version} ·{" "}
                        {d.enabled ? "Active" : "Disabled"}
                      </small>
                    </div>
                    {d.enabled && (
                      <div className="studio-actions">
                        <a
                          href={`/chat/${d.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="button secondary"
                        >
                          Open hosted chat
                          <ArrowUpRight size={14} />
                        </a>
                        {canBuild && (
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() =>
                              action(async () => {
                                await requestJson(
                                  `/agents/${draft.id}/deployments/${d.id}`,
                                  "DELETE",
                                );
                                setNotice("Deployment disabled");
                              })
                            }
                          >
                            Disable
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {!deployments.data?.length && (
                  <p className="empty">
                    Create a deployment from a published version.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}
export function Conversations({
  workspaceId,
  role,
}: {
  workspaceId: string;
  role: string;
}) {
  const [status, setStatus] = useState(""),
    [rating, setRating] = useState(""),
    [channel, setChannel] = useState(""),
    [filterAgent, setFilterAgent] = useState(""),
    [days, setDays] = useState(30);
  const agents = useQuery({
    queryKey: ["agents", workspaceId],
    queryFn: () =>
      requestJson<AgentSummary[]>(`/workspaces/${workspaceId}/agents`),
  });
  function resetFilters() {
    setPages([]);
    setBefore("");
    setBeforeId("");
    setSelected("");
  }
  const [pages, setPages] = useState<
    { id: string; name: string; created_at: string }[]
  >([]);
  const [before, setBefore] = useState("");
  const [beforeId, setBeforeId] = useState("");
  const [selected, setSelected] = useState("");
  const conversations = useQuery({
    queryKey: [
      "conversations",
      workspaceId,
      before,
      beforeId,
      status,
      rating,
      channel,
      filterAgent,
      days,
    ],
    queryFn: () =>
      requestJson<{ id: string; name: string; created_at: string }[]>(
        `/workspaces/${workspaceId}/operations/conversations?${new URLSearchParams({ days: String(days), ...(status ? { status } : {}), ...(rating ? { rating } : {}), ...(channel ? { channel } : {}), ...(filterAgent ? { agentId: filterAgent } : {}), ...(before ? { before, beforeId } : {}) })}`,
      ),
  });
  const messages = useQuery({
    queryKey: ["conversation-messages", selected],
    queryFn: () =>
      requestJson<
        {
          id: string;
          role: string;
          content: string;
          status: string;
          citations: Citation[];
          ui_blocks: RenderedBlock[];
        }[]
      >(`/conversations/${selected}/messages`),
    enabled: !!selected,
  });
  const toolTraces = useQuery({
    queryKey: ["conversation-tools", selected],
    queryFn: () =>
      requestJson<ToolTrace[]>(`/conversations/${selected}/tool-executions`),
    enabled: !!selected,
  });
  const rows = [...pages, ...(conversations.data ?? [])];
  return (
    <section className="panel">
      <div className="panel-header">
        <h3>Conversation history</h3>
        <p>Workspace-scoped conversation records and run outcomes.</p>
      </div>
      <div className="operations-filters">
        <label>
          Agent
          <select
            value={filterAgent}
            onChange={(e) => {
              resetFilters();
              setFilterAgent(e.target.value);
            }}
          >
            <option value="">All agents</option>
            {agents.data?.map((a) => (
              <option value={a.id} key={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Run status
          <select
            value={status}
            onChange={(e) => {
              resetFilters();
              setStatus(e.target.value);
            }}
          >
            <option value="">All statuses</option>
            {["running", "completed", "failed", "cancelled"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Rating
          <select
            aria-label="Rating filter"
            value={rating}
            onChange={(e) => {
              resetFilters();
              setRating(e.target.value);
            }}
          >
            <option value="">All ratings</option>
            <option value="like">Like</option>
            <option value="dislike">Dislike</option>
          </select>
        </label>
        <label>
          Channel
          <select
            value={channel}
            onChange={(e) => {
              resetFilters();
              setChannel(e.target.value);
            }}
          >
            <option value="">All channels</option>
            <option value="playground">Playground</option>
            <option value="hosted">Hosted chat</option>
            <option value="widget">Website widget</option>
          </select>
        </label>
        <label>
          Period
          <select
            value={days}
            onChange={(e) => {
              resetFilters();
              setDays(Number(e.target.value));
            }}
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </label>
      </div>
      {conversations.isPending && (
        <p role="status" className="empty">
          Loading conversations…
        </p>
      )}
      {conversations.error && (
        <p className="error-banner">{conversations.error.message}</p>
      )}
      <div className="conversation-grid">
        <div>
          {rows.map((c) => (
            <button
              key={c.id}
              className={`conversation-row ${selected === c.id ? "selected" : ""}`}
              onClick={() => setSelected(c.id)}
            >
              <strong>{c.name}</strong>
              <small>{new Date(c.created_at).toLocaleString()}</small>
            </button>
          ))}
          {conversations.data?.length === 30 && (
            <Button
              className="secondary"
              onClick={() => {
                setPages(rows);
                const last = rows[rows.length - 1]!;
                setBefore(last.created_at);
                setBeforeId(last.id);
              }}
            >
              Load more
            </Button>
          )}
          {!rows.length && !conversations.isPending && !conversations.error && (
            <p className="empty">
              No conversations match these filters. Try a wider period or start
              a playground chat.
            </p>
          )}
        </div>
        <div className="conversation-detail">
          <ToolTraces traces={toolTraces.data ?? []} />
          {messages.isPending && selected && <p>Loading messages…</p>}
          {messages.error && <p className="error">{messages.error.message}</p>}
          {messages.data?.map((m) => (
            <div key={m.id} className={`chat-message ${m.role}`}>
              <small>
                {m.role} · {m.status}
              </small>
              <div>{m.content}</div>
              {m.ui_blocks?.length > 0 && (
                <GenerativeResponse
                  blocks={m.ui_blocks}
                  messageId={m.id}
                  interactive={false}
                />
              )}
              <Citations sources={m.citations ?? []} />
              {m.role === "assistant" && (
                <MessageReview
                  messageId={m.id}
                  conversationId={selected}
                  canReview={permitted(role as Role, "conversation:review")}
                />
              )}
            </div>
          ))}
          {!selected && (
            <p className="empty">
              Select a conversation to inspect its messages.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
