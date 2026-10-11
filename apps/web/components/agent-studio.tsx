"use client";
import { WorkspaceSaveBar } from "./workspace-sections";
import { useState, useRef, useEffect, type FormEvent } from "react";
import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { Plus, ArrowUpRight, Upload, ChevronLeft } from "lucide-react";
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
import { AgentConfigure, AgentReadiness } from "./agent-configure";
import {
  agentReadiness,
  configureIssues,
  configureSections,
  studioURL,
  type ConfigureSection,
  type StudioStage,
  type KnowledgeOption,
} from "./agent-configure-state";
import { requestJson, ApiError } from "./agent-client";
export type Model = {
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
export type Prompt = {
  role: string;
  objective: string;
  instructions: string;
  constraints: string;
  tone: string;
  outputFormat: string;
  escalationPolicy: string;
  advanced: string | null;
};
export type Config = {
  generative?: {
    enabled: boolean;
    allowedBlocks: (typeof blockNames)[number][];
    allowPublicForms: boolean;
  };
  schemaVersion: 1;
  tools: {
    toolIds: string[];
    maxCalls: number;
    usageMode?: "automatic" | "always" | "disabled";
    usageInstructions?: string;
  };
  rag: {
    knowledgeBaseIds: string[];
    topK: number;
    minScore: number;
    mode: "vector" | "hybrid";
    requireCitations: boolean;
    usageMode?: "automatic" | "always" | "disabled";
    usageInstructions?: string;
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
export type Draft = {
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
          <h4>Model connection</h4>
          <p className="muted">
            Choose the exact provider model and the credential saved in this
            workspace.
          </p>
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
          </div>
          <details className="workspace-advanced-settings">
            <summary>Model limits & supported parameters</summary>
            <p className="muted">
              Use the limits and sampling capabilities supported by this
              provider model. These settings are available to every agent using
              it.
            </p>
            <div className="form-grid">
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
          </details>
          <WorkspaceSaveBar>
            <span>
              {editing
                ? "Editing model configuration"
                : "New model configuration"}
            </span>
            <div className="studio-actions">
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
            </div>
          </WorkspaceSaveBar>
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
      requestJson<KnowledgeOption[]>(
        `/workspaces/${workspaceId}/knowledge-bases`,
      ),
    enabled: canBuild,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedDraft, setSavedDraft] = useState("");
  const dirty = !!draft && JSON.stringify(draft) !== savedDraft;
  const [section, setSection] = useState<ConfigureSection>("overview");
  const [conflict, setConflict] = useState(false);
  const savedRef = useRef(savedDraft);
  savedRef.current = savedDraft;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [initialNavigation, setInitialNavigation] = useState(false);
  const sourceQueries = useQueries({
    queries: (draft?.config.rag.knowledgeBaseIds ?? [])
      .filter((id) => knowledge.data?.some((k) => k.id === id))
      .map((id) => ({
        queryKey: ["agent-knowledge-health", id],
        queryFn: () =>
          requestJson<{ status: string }[]>(`/knowledge-bases/${id}/sources`),
        refetchInterval: 10000,
      })),
  });
  const knowledgeOptions = knowledge.data?.map((k) => {
    const index = (draft?.config.rag.knowledgeBaseIds ?? [])
      .filter((id) => knowledge.data?.some((row) => row.id === id))
      .indexOf(k.id);
    const data = sourceQueries[index]?.data;
    return {
      ...k,
      ...(data
        ? {
            failed_count: data.filter((s) => s.status === "failed").length,
            indexing_count: data.filter((s) =>
              ["queued", "processing"].includes(s.status),
            ).length,
            ready_count: data.filter((s) => s.status === "ready").length,
            source_count: data.length,
          }
        : {}),
    };
  });
  const approvedLeave = useRef(false);
  function navigateAttachments(destination: "Knowledge" | "Tools" | "Models") {
    if (
      (dirty || (draft && !draft.id)) &&
      !window.confirm(
        "Leave this agent? Unsaved changes will be lost. Save your agent first to keep them.",
      )
    )
      return;
    approvedLeave.current = true;
    onNavigate(destination);
    approvedLeave.current = false;
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
      return true;
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status === 409 &&
        /Draft changed|reload before|revision/i.test(e.message)
      ) {
        setConflict(true);
        setError(
          "This agent was updated elsewhere. Reload the latest draft before saving. Your local edits are retained until you reload.",
        );
      } else setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function open(
    id: string,
    stage: StudioStage = "configure",
    nextSection: ConfigureSection = "overview",
    updateURL = true,
  ) {
    await action(async () => {
      const a = await requestJson<AgentRow>(`/agents/${id}`);
      if (
        !agents.data?.some((row) => row.id === a.id) &&
        (a as AgentRow & { workspace_id?: string }).workspace_id !== workspaceId
      )
        throw new Error("Agent unavailable in the selected workspace.");
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
      setTab(stage);
      setSection(nextSection);
      setConflict(false);
      if (updateURL) studioURL(id, stage, nextSection);
    });
  }
  async function save(test = false) {
    if (!draft || conflict || configureIssues(draft, models.data).length)
      return false;
    return action(async () => {
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
      if (test) {
        setTab("playground");
        studioURL(result.id, "playground", section);
      } else studioURL(result.id, "configure", section, true);
    });
  }
  function navigateSection(next: ConfigureSection) {
    setSection(next);
    studioURL(draft?.id, "configure", next);
  }
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: Event) => {
      if (approvedLeave.current) return;
      if (!window.confirm("Leave this agent? Unsaved changes will be lost."))
        event.preventDefault();
    };
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("agent-studio:before-leave", leave);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("agent-studio:before-leave", leave);
      window.removeEventListener("beforeunload", unload);
    };
  }, [dirty]);
  useEffect(() => {
    const restore = () => {
      const p = new URLSearchParams(window.location.hash.slice(1));
      const id = p.get("agent");
      const nextSection = configureSections.includes(
        p.get("section") as ConfigureSection,
      )
        ? (p.get("section") as ConfigureSection)
        : "overview";
      const stage = ["configure", "playground", "publish"].includes(
        p.get("stage") ?? "",
      )
        ? (p.get("stage") as StudioStage)
        : "configure";
      if (id && draftRef.current?.id !== id) {
        void open(id, stage, nextSection, false);
      } else if (draftRef.current && !id && draftRef.current.id) {
        setDraft(null);
      } else if (draftRef.current) {
        setSection(nextSection);
        const unsaved = JSON.stringify(draftRef.current) !== savedRef.current;
        setTab(unsaved || !draftRef.current.id ? "configure" : stage);
      }
      setInitialNavigation(true);
    };
    restore();
    window.addEventListener("popstate", restore);
    window.addEventListener("hashchange", restore);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener("hashchange", restore);
    };
  }, [workspaceId]);
  const readiness = draft
    ? agentReadiness(
        draft,
        models.error ? undefined : models.data,
        knowledge.error ? undefined : knowledgeOptions,
        tools.error ? undefined : tools.data,
      )
    : [];
  const ready = readiness.every(
    (i) => i.state === "ready" || i.state === "optional",
  );
  return (
    <>
      <section className={`panel${draft ? " agent-studio-panel" : ""}`}>
        <div className="panel-header">
          <div>
            <h3>{draft ? draft.name || "New agent" : "Your agents"}</h3>
            {draft && (
              <p>
                Agent Studio ·{" "}
                {draft.config.rag.knowledgeBaseIds.length
                  ? "RAG agent"
                  : "AI agent"}
              </p>
            )}
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
                studioURL(undefined, "configure", "overview");
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
                  const next = emptyDraft(models.data![0]!.id);
                  setDraft(next);
                  setSavedDraft(JSON.stringify(next));
                  setSection("overview");
                  setConflict(false);
                  studioURL(undefined, "configure", "overview");
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
          <div className="error-banner" role="alert">
            {error}
            {conflict && draft?.id && (
              <Button
                className="secondary"
                onClick={() => {
                  if (
                    window.confirm(
                      "Reload the latest draft? Your unsaved edits will be lost.",
                    )
                  )
                    void open(draft.id!);
                }}
              >
                Reload latest draft
              </Button>
            )}
          </div>
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
          (agents.isPending || !initialNavigation ? (
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
            <div
              className="studio-tabs"
              role="navigation"
              aria-label="Agent lifecycle"
            >
              {(["configure", "playground", "publish"] as const).map((t) => (
                <button
                  className={tab === t ? "active" : ""}
                  key={t}
                  aria-current={tab === t ? "page" : undefined}
                  onClick={() => {
                    setTab(t);
                    studioURL(draft.id, t, section);
                  }}
                  disabled={(!draft.id || dirty) && t !== "configure"}
                >
                  {t}
                </button>
              ))}
            </div>
            {tab === "configure" && (
              <AgentConfigure
                key={draft.id ?? "new"}
                draft={draft}
                update={setDraft}
                section={section}
                navigate={navigateSection}
                busy={busy}
                conflict={conflict}
                canBuild={canBuild}
                dirty={dirty}
                savedDraft={savedDraft}
                onSave={save}
                onDiscard={() => {
                  if (savedDraft) setDraft(JSON.parse(savedDraft));
                  else {
                    setDraft(null);
                    studioURL(undefined, "configure", "overview");
                  }
                }}
                onArchive={() => {
                  if (
                    window.confirm(
                      "Archive this agent and disable its deployments?",
                    )
                  )
                    void action(async () => {
                      await requestJson(`/agents/${draft.id}`, "DELETE");
                      setDraft(null);
                      studioURL(undefined, "configure", "overview");
                    });
                }}
                models={models.data ?? []}
                modelsLoading={models.isPending}
                modelsError={models.error}
                retryModels={() => void models.refetch()}
                knowledge={knowledgeOptions ?? []}
                tools={tools.data ?? []}
                knowledgeLoading={knowledge.isPending}
                toolsLoading={tools.isPending}
                knowledgeError={knowledge.error}
                toolsError={tools.error}
                retryKnowledge={() => {
                  void knowledge.refetch();
                  for (const q of sourceQueries) void q.refetch();
                }}
                retryTools={() => {
                  void tools.refetch();
                }}
                manage={navigateAttachments}
                canManage={["owner", "org_admin", "workspace_admin"].includes(
                  role,
                )}
              />
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
                <AgentReadiness
                  items={readiness}
                  navigate={(next) => {
                    setTab("configure");
                    navigateSection(next);
                  }}
                />
                <p className="muted">
                  Readiness checks saved configuration and workspace
                  attachments. Provider connectivity and quality gates are
                  checked when publishing.
                </p>
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
                      disabled={busy || dirty || !ready || conflict}
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
