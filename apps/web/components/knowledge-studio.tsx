"use client";
import { KnowledgeReleases } from "./knowledge-releases";
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Upload,
  BookOpen,
  ChevronLeft,
  Search,
  RefreshCw,
} from "lucide-react";
import { WorkspaceSections, useWorkspaceSection } from "./workspace-sections";
import { Button } from "./button";
import { requestJson, apiBase } from "./agent-client";
import { Citations, type Citation } from "./citations";
type Base = {
  id: string;
  name: string;
  description: string;
  public_access: boolean;
  approval_required: boolean;
  published_release_id: string | null;
  revision: number;
  embedding_model_id: string;
  dimensions: number;
  source_count: number;
  ready_count: number;
};
type Embedding = {
  id: string;
  name: string;
  provider: string;
  model_id: string;
  dimensions: number;
};
type Source = {
  id: string;
  kind: string;
  title: string;
  filename: string | null;
  source_url: string | null;
  status: string;
  error_code: string | null;
  revision: number;
  chunk_count: number;
  metadata: {
    question?: string;
    answer?: string;
    tags?: string[];
    connectorId?: string;
    externalKey?: string;
  };
};
type Result = {
  query: string;
  rewrittenQuery: string | null;
  latencyMs: number;
  estimatedTokens: number;
  results: Citation[];
};
export function KnowledgeStudio({
  workspaceId,
  role,
}: {
  workspaceId: string;
  role: string;
}) {
  const [librarySection, setLibrarySection] = useWorkspaceSection(
    "knowledgeSection",
    "bases",
    ["bases", "embeddings"],
  );
  const cache = useQueryClient();
  const canManage = [
    "owner",
    "org_admin",
    "workspace_admin",
    "builder",
  ].includes(role);
  const canRead = canManage || ["operator", "analyst"].includes(role);
  const canRetrieve = canManage || role === "analyst";
  const canModel = ["owner", "org_admin", "workspace_admin"].includes(role);
  const [selected, setSelected] = useState("");
  const [tab, setTab] = useState<
    "sources" | "playground" | "releases" | "settings"
  >("sources");
  const [form, setForm] = useState<
    | "base"
    | "embedding"
    | "upload"
    | "text"
    | "qa"
    | "website"
    | "import"
    | null
  >(null);
  const [editing, setEditing] = useState<Source | null>(null);
  const [provider, setProvider] = useState("openai");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [preview, setPreview] = useState<
    { id: string; content: string; page: number | null; title: string }[] | null
  >(null);
  const bases = useQuery({
    queryKey: ["knowledge", workspaceId],
    queryFn: () =>
      requestJson<Base[]>(`/workspaces/${workspaceId}/knowledge-bases`),
    enabled: canRead,
  });
  const embeddings = useQuery({
    queryKey: ["embeddings", workspaceId],
    queryFn: () =>
      requestJson<Embedding[]>(`/workspaces/${workspaceId}/embedding-models`),
    enabled: canRead,
  });
  const secrets = useQuery({
    queryKey: ["knowledge-secrets", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(
        `/workspaces/${workspaceId}/secrets`,
      ),
    enabled: canModel,
  });
  const sources = useQuery({
    queryKey: ["knowledge-sources", selected],
    queryFn: () =>
      requestJson<Source[]>(`/knowledge-bases/${selected}/sources`),
    enabled: canRead && !!selected,
    refetchInterval: (q) =>
      q.state.data?.some((s) => ["queued", "processing"].includes(s.status))
        ? 2000
        : false,
  });
  const base = bases.data?.find((b) => b.id === selected);
  const path = `/knowledge-bases/${selected}`;
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
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const value = (name: string) => String(data.get(name) ?? "");
    const number = (name: string) => Number(data.get(name));
    await action(async () => {
      if (form === "embedding") {
        await requestJson(
          `/workspaces/${workspaceId}/embedding-models`,
          "POST",
          {
            name: value("name"),
            provider,
            modelId: value("modelId"),
            dimensions: number("dimensions"),
            secretId: value("secretId") || null,
            ...(provider === "openai-compatible"
              ? { baseUrl: value("baseUrl") }
              : {}),
          },
        );
        setNotice("Embedding model registered");
      }
      if (form === "base") {
        const created = await requestJson<{ id: string }>(
          `/workspaces/${workspaceId}/knowledge-bases`,
          "POST",
          {
            name: value("name"),
            description: value("description"),
            embeddingModelId: value("embeddingModelId"),
            chunkSize: number("chunkSize"),
            chunkOverlap: number("chunkOverlap"),
            chunkStrategy: value("chunkStrategy"),
            publicAccess: data.get("publicAccess") === "on",
          },
        );
        setSelected(created.id);
        setTab("sources");
        setNotice("Knowledge base created");
      }
      if (form === "upload") {
        const payload = new FormData();
        payload.append("file", data.get("file")!);
        const response = await fetch(apiBase + path + "/upload", {
          method: "POST",
          credentials: "include",
          body: payload,
        });
        const output = await response.json();
        if (!response.ok) throw new Error(output.error ?? "Upload failed");
        setNotice("Document queued for ingestion");
      }
      if (form === "text") {
        await requestJson(path + "/text", "POST", {
          title: value("title"),
          text: value("text"),
        });
        setNotice("Text queued for ingestion");
      }
      if (form === "qa") {
        await requestJson(
          path + (editing ? `/sources/${editing.id}/qa` : "/qa"),
          editing ? "PUT" : "POST",
          {
            question: value("question"),
            answer: value("answer"),
            tags: value("tags")
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
          },
        );
        setNotice("Q&A queued for ingestion");
      }
      if (form === "website") {
        await requestJson(path + "/website", "POST", {
          url: value("url"),
          maxPages: number("maxPages"),
          maxDepth: number("maxDepth"),
          allowedPaths: value("allowedPaths")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          blockedPaths: value("blockedPaths")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        });
        setNotice("Website queued for ingestion");
      }
      if (form === "import") {
        const file = data.get("file") as File;
        await requestJson(path + "/qa/import", "POST", {
          csv: await file.text(),
        });
        setNotice("Q&A import queued");
      }
      setForm(null);
      setEditing(null);
    });
  }
  async function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    await action(async () => {
      setResult(
        await requestJson<Result>(path + "/search", "POST", {
          query: String(data.get("query")),
          topK: Number(data.get("topK")),
          minScore: Number(data.get("minScore")),
          mode: String(data.get("mode")),
        }),
      );
    });
  }
  if (!canRead)
    return (
      <section className="panel empty">
        <h3>Knowledge access</h3>
        <p>Your workspace role does not permit reading knowledge bases.</p>
      </section>
    );
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h3>
            <BookOpen size={18} /> {base ? base.name : "Workspace knowledge"}
          </h3>
          <p>
            {base
              ? "Sources, retrieval and grounded agent answers."
              : "Turn documents and curated answers into searchable knowledge."}
          </p>
        </div>
        <div className="studio-actions">
          {selected ? (
            <button
              className="text-button"
              onClick={() => {
                setSelected("");
                setForm(null);
                setResult(null);
                setPreview(null);
              }}
            >
              <ChevronLeft size={14} /> All knowledge bases
            </button>
          ) : (
            <>
              {canModel && (
                <Button
                  className="secondary"
                  onClick={() => {
                    setForm("embedding");
                    setProvider("openai");
                  }}
                >
                  Register embedding model
                </Button>
              )}
              {canManage && (
                <Button
                  disabled={!embeddings.data?.length}
                  onClick={() => setForm("base")}
                >
                  <Plus size={15} /> Create knowledge base
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {bases.error && <p className="error-banner">{bases.error.message}</p>}
      {embeddings.error && (
        <p className="error-banner">{embeddings.error.message}</p>
      )}
      {form && (
        <form className="studio-form" onSubmit={submit}>
          <div className="panel-header">
            <h3>
              {
                {
                  base: "Create knowledge base",
                  embedding: "Register embedding model",
                  upload: "Upload document",
                  text: "Add manual text",
                  qa: editing ? "Edit Q&A" : "Add Q&A",
                  website: "Ingest website",
                  import: "Import Q&A CSV",
                }[form]
              }
            </h3>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setForm(null);
                setEditing(null);
              }}
            >
              Cancel
            </button>
          </div>
          <fieldset disabled={busy}>
            {form === "embedding" && (
              <>
                <div className="form-grid">
                  <label>
                    Embedding display name
                    <input name="name" required maxLength={100} />
                  </label>
                  <label>
                    Embedding provider
                    <select
                      aria-label="Embedding provider"
                      value={provider}
                      onChange={(e) => setProvider(e.target.value)}
                    >
                      <option value="openai">OpenAI</option>
                      <option value="gemini">Google Gemini</option>
                      <option value="openai-compatible">
                        OpenAI-compatible
                      </option>
                    </select>
                  </label>
                  <label>
                    Embedding model identifier
                    <input name="modelId" required maxLength={150} />
                  </label>
                  <label>
                    Embedding dimensions
                    <input
                      name="dimensions"
                      type="number"
                      min={1}
                      max={2000}
                      defaultValue={1536}
                      required
                    />
                  </label>
                  <label>
                    Embedding credential
                    <select
                      aria-label="Embedding credential"
                      name="secretId"
                      required={provider !== "openai-compatible"}
                    >
                      <option value="">
                        {provider === "openai-compatible"
                          ? "None (local server)"
                          : "Select encrypted secret"}
                      </option>
                      {secrets.data?.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {provider === "openai-compatible" && (
                    <label>
                      Embedding base URL
                      <input name="baseUrl" type="url" required />
                    </label>
                  )}
                </div>
                <p className="muted">
                  Use a model available to your provider account. Dimensions
                  must match every returned vector. Knowledge bases keep this
                  model fixed.
                </p>
              </>
            )}
            {form === "base" && (
              <>
                <div className="form-grid">
                  <label>
                    Knowledge base name
                    <input name="name" required maxLength={100} />
                  </label>
                  <label>
                    Embedding model
                    <select
                      aria-label="Embedding model"
                      name="embeddingModelId"
                      required
                    >
                      {embeddings.data?.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} · {m.dimensions} dimensions
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Description
                    <input name="description" maxLength={2000} />
                  </label>
                  <label>
                    Chunk strategy
                    <select aria-label="Chunk strategy" name="chunkStrategy">
                      <option value="recursive">Recursive text</option>
                      <option value="page">Page boundaries</option>
                      <option value="heading">Heading boundaries</option>
                    </select>
                  </label>
                  <label>
                    Chunk size (characters)
                    <input
                      name="chunkSize"
                      type="number"
                      min={200}
                      max={4000}
                      defaultValue={1600}
                      required
                    />
                  </label>
                  <label>
                    Overlap (characters)
                    <input
                      name="chunkOverlap"
                      type="number"
                      min={0}
                      max={1000}
                      defaultValue={200}
                      required
                    />
                  </label>
                </div>
                <label className="checkbox-label">
                  <input name="publicAccess" type="checkbox" /> Allow knowledge
                  in public hosted chat
                </label>
                <p className="muted">
                  Public chat can reveal retrieved passages. Leave this off for
                  internal knowledge.
                </p>
              </>
            )}
            {form === "upload" && (
              <>
                <label>
                  Document file
                  <input
                    name="file"
                    type="file"
                    accept=".pdf,.docx,.pptx,.xlsx,.csv,.txt,.md,.markdown,.html,.htm,.json"
                    required
                  />
                </label>
                <p className="muted">
                  PDF, Office documents, CSV, text, Markdown, HTML and JSON.
                  Maximum 10 MB. Scanned PDFs need an OCR pipeline.
                </p>
              </>
            )}
            {form === "text" && (
              <>
                <label>
                  Source title
                  <input name="title" required maxLength={200} />
                </label>
                <label>
                  Knowledge text
                  <textarea name="text" rows={8} required maxLength={200000} />
                </label>
              </>
            )}
            {form === "qa" && (
              <>
                <label>
                  Question
                  <input
                    name="question"
                    defaultValue={editing?.metadata.question ?? ""}
                    maxLength={2000}
                    required
                  />
                </label>
                <label>
                  Answer
                  <textarea
                    name="answer"
                    defaultValue={editing?.metadata.answer ?? ""}
                    rows={6}
                    maxLength={20000}
                    required
                  />
                </label>
                <label>
                  Tags (comma separated)
                  <input
                    name="tags"
                    defaultValue={editing?.metadata.tags?.join(", ") ?? ""}
                  />
                </label>
              </>
            )}
            {form === "website" && (
              <>
                <div className="form-grid">
                  <label>
                    Website URL
                    <input name="url" type="url" required maxLength={1000} />
                  </label>
                  <label>
                    Page limit
                    <input
                      name="maxPages"
                      type="number"
                      min={1}
                      max={20}
                      defaultValue={1}
                      required
                    />
                  </label>
                  <label>
                    Crawl depth
                    <input
                      name="maxDepth"
                      type="number"
                      min={0}
                      max={3}
                      defaultValue={0}
                      required
                    />
                  </label>
                  <label>
                    Allowed path prefixes
                    <input name="allowedPaths" defaultValue="/" required />
                  </label>
                  <label>
                    Blocked path prefixes
                    <input name="blockedPaths" />
                  </label>
                </div>
                <p className="muted">
                  Only approved server destinations are fetched. Crawls stay on
                  this origin, respect robots.txt and block redirects.
                </p>
              </>
            )}
            {form === "import" && (
              <>
                <label>
                  Q&A CSV file
                  <input name="file" type="file" accept=".csv" required />
                </label>
                <p className="muted">
                  Columns: question, answer, tags. Separate tags with |. Import
                  up to 100 rows; all rows are validated before creation.
                </p>
              </>
            )}
            <Button disabled={busy} type="submit">
              {busy
                ? "Saving…"
                : form === "embedding"
                  ? "Save embedding model"
                  : form === "base"
                    ? "Save knowledge base"
                    : form === "upload"
                      ? "Upload and ingest"
                      : "Queue ingestion"}
            </Button>
          </fieldset>
        </form>
      )}
      {!selected && !form && (
        <WorkspaceSections
          label="Knowledge sections"
          value={librarySection}
          onChange={setLibrarySection}
          sections={[
            {
              id: "bases",
              label: "Knowledge bases",
              description:
                "Organize approved content for grounded agent answers.",
              count: bases.data?.length,
            },
            {
              id: "embeddings",
              label: "Embedding models",
              description:
                "Configure the models that turn source content into searchable vectors.",
              count: embeddings.data?.length,
            },
          ]}
        />
      )}
      {!selected && !form && (
        <>
          <div
            className="workspace-section-body"
            hidden={librarySection !== "bases"}
          >
            {bases.isPending ? (
              <p className="empty">Loading knowledge bases…</p>
            ) : bases.data?.length ? (
              <div className="workspace-grid">
                {bases.data.map((k) => (
                  <button
                    key={k.id}
                    className="workspace-card"
                    onClick={() => {
                      setSelected(k.id);
                      setTab("sources");
                      setResult(null);
                      setPreview(null);
                    }}
                  >
                    <div>
                      <h4>{k.name}</h4>
                      <p>{k.description || "Searchable workspace knowledge"}</p>
                    </div>
                    <span className="workspace-footer">
                      {k.ready_count}/{k.source_count} sources ready ·{" "}
                      {k.public_access ? "Public chat enabled" : "Internal"}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty">
                <BookOpen size={30} />
                <h3>Your knowledge starts here</h3>
                <p>
                  Register an embedding model, create a knowledge base, and add
                  your first source.
                </p>
                {canModel && !embeddings.data?.length && (
                  <Button
                    onClick={() => {
                      setForm("embedding");
                      setProvider("openai");
                    }}
                  >
                    Add your first embedding model
                  </Button>
                )}
                {canManage && !!embeddings.data?.length && (
                  <Button onClick={() => setForm("base")}>
                    Create your first knowledge base
                  </Button>
                )}
              </div>
            )}
          </div>
          <div
            className="workspace-section-body"
            hidden={librarySection !== "embeddings"}
          >
            <h3>Embedding models</h3>
            {embeddings.data?.length === 0 && (
              <div className="empty">
                <h4>No embedding models yet</h4>
                <p>
                  Register an embedding model before creating your first
                  knowledge base.
                </p>
                {canModel ? (
                  <Button
                    onClick={() => {
                      setForm("embedding");
                      setProvider("openai");
                    }}
                  >
                    Add embedding model
                  </Button>
                ) : (
                  <p>
                    Ask a workspace administrator to register an embedding
                    model.
                  </p>
                )}
              </div>
            )}
            {embeddings.data?.map((m) => (
              <div className="version-row" key={m.id}>
                <div>
                  <strong>{m.name}</strong>
                  <small>
                    {m.provider} · {m.model_id} · {m.dimensions} dimensions
                  </small>
                </div>
                {canModel && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        await requestJson(
                          `/workspaces/${workspaceId}/embedding-models/${m.id}/test`,
                          "POST",
                        );
                        setNotice("Embedding connection succeeded");
                      })
                    }
                  >
                    Test embedding connection
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {selected && base && (
        <>
          <div className="studio-tabs">
            {(["sources", "playground", "releases", "settings"] as const).map(
              (t) => (
                <button
                  key={t}
                  onClick={() => {
                    setTab(t);
                    setForm(null);
                    setPreview(null);
                  }}
                  className={tab === t ? "active" : ""}
                >
                  {t === "playground" ? "Retrieval playground" : t}
                </button>
              ),
            )}
          </div>
          {tab === "releases" && (
            <KnowledgeReleases
              key={selected}
              baseId={selected}
              role={role}
              sources={sources.data ?? []}
              publishedId={base.published_release_id}
            />
          )}
          {tab === "sources" && (
            <>
              <div className="knowledge-toolbar">
                {canManage && (
                  <>
                    <Button
                      className="secondary"
                      onClick={() => setForm("upload")}
                    >
                      <Upload size={15} /> Upload document
                    </Button>
                    <Button
                      className="secondary"
                      onClick={() => setForm("text")}
                    >
                      Add text
                    </Button>
                    <Button
                      className="secondary"
                      onClick={() => {
                        setEditing(null);
                        setForm("qa");
                      }}
                    >
                      Add Q&A
                    </Button>
                    <Button
                      className="secondary"
                      onClick={() => setForm("website")}
                    >
                      Ingest website
                    </Button>
                    <Button
                      className="secondary"
                      onClick={() => setForm("import")}
                    >
                      Import Q&A CSV
                    </Button>
                  </>
                )}
                <a className="text-button" href={apiBase + path + "/qa/export"}>
                  Export Q&A CSV
                </a>
              </div>
              {sources.error && (
                <p className="error-banner">{sources.error.message}</p>
              )}
              {sources.data?.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Source</th>
                        <th>Status</th>
                        <th>Chunks</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sources.data.map((s) => (
                        <tr key={s.id}>
                          <td>
                            <strong>{s.title}</strong>
                            <small>
                              {s.metadata.connectorId ? "S3 connector" : s.kind}{" "}
                              · revision {s.revision}
                            </small>
                            {s.metadata.connectorId && (
                              <small>
                                Managed source: {s.metadata.externalKey}. Sync
                                can restore a deleted file while the connector
                                is active.
                              </small>
                            )}
                          </td>
                          <td>
                            <span className={"source-status " + s.status}>
                              {s.status}
                            </span>
                            {s.error_code && (
                              <small className="error">{s.error_code}</small>
                            )}
                          </td>
                          <td>{s.chunk_count}</td>
                          <td>
                            <div className="studio-actions">
                              <button
                                className="text-button"
                                disabled={busy || !s.chunk_count}
                                onClick={() =>
                                  action(async () =>
                                    setPreview(
                                      await requestJson(
                                        path + `/sources/${s.id}/chunks`,
                                      ),
                                    ),
                                  )
                                }
                              >
                                Inspect chunks
                              </button>
                              {canManage && (
                                <>
                                  <button
                                    className="text-button"
                                    disabled={
                                      busy ||
                                      s.status === "processing" ||
                                      s.status === "queued"
                                    }
                                    onClick={() =>
                                      action(async () => {
                                        await requestJson(
                                          path + `/sources/${s.id}/reingest`,
                                          "POST",
                                        );
                                        setNotice(
                                          "Source queued for reingestion",
                                        );
                                      })
                                    }
                                  >
                                    <RefreshCw size={13} /> Reingest
                                  </button>
                                  {s.kind === "qa" && (
                                    <button
                                      className="text-button"
                                      onClick={() => {
                                        setEditing(s);
                                        setForm("qa");
                                      }}
                                    >
                                      Edit Q&A
                                    </button>
                                  )}
                                  <button
                                    className="text-button danger"
                                    disabled={busy}
                                    onClick={() => {
                                      if (
                                        window.confirm(
                                          "Remove this source and its searchable chunks?",
                                        )
                                      )
                                        void action(async () => {
                                          await requestJson(
                                            path + `/sources/${s.id}`,
                                            "DELETE",
                                          );
                                          setPreview(null);
                                        });
                                    }}
                                  >
                                    Remove
                                  </button>
                                </>
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
                  <h3>Add your first source</h3>
                  <p>
                    Documents become searchable after the ingestion worker
                    finishes.
                  </p>
                </div>
              )}
              {preview && (
                <div className="chunk-preview">
                  <div className="panel-header">
                    <h3>Extracted chunks</h3>
                    <button
                      className="text-button"
                      onClick={() => setPreview(null)}
                    >
                      Close preview
                    </button>
                  </div>
                  {preview.map((c) => (
                    <details key={c.id}>
                      <summary>
                        {c.title}
                        {c.page ? ` · Page ${c.page}` : ""}
                      </summary>
                      <p className="source-snippet">{c.content}</p>
                    </details>
                  ))}
                </div>
              )}
            </>
          )}
          {tab === "playground" &&
            (canRetrieve ? (
              <div className="studio-form">
                <form onSubmit={search}>
                  <label>
                    Retrieval query
                    <textarea
                      name="query"
                      required
                      maxLength={4000}
                      placeholder="Find a policy, fact or curated answer…"
                    />
                  </label>
                  <div className="form-grid">
                    <label>
                      Retrieval mode
                      <select name="mode" aria-label="Retrieval mode">
                        <option value="hybrid">Hybrid vector + text</option>
                        <option value="vector">Vector similarity</option>
                      </select>
                    </label>
                    <label>
                      Top K
                      <input
                        name="topK"
                        type="number"
                        min={1}
                        max={10}
                        defaultValue={5}
                      />
                    </label>
                    <label>
                      Minimum similarity
                      <input
                        name="minScore"
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        defaultValue={0.2}
                      />
                    </label>
                  </div>
                  <Button type="submit" disabled={busy}>
                    <Search size={15} /> Search knowledge
                  </Button>
                </form>
                {result && (
                  <div className="retrieval-results">
                    <p className="muted">
                      {result.results.length} passages · {result.latencyMs} ms ·
                      about {result.estimatedTokens} context tokens
                    </p>
                    <p>Query: {result.query}</p>
                    {!result.results.length ? (
                      <p className="empty">
                        No relevant passages. Check source status or adjust the
                        query and threshold.
                      </p>
                    ) : (
                      <Citations
                        sources={result.results}
                        label="Retrieved passages"
                      />
                    )}
                  </div>
                )}
              </div>
            ) : (
              <p className="empty">
                Retrieval testing requires builder or analyst access.
              </p>
            ))}
          {tab === "settings" && (
            <div className="studio-form">
              <p>
                Embedding space: {base.dimensions} dimensions. Model and chunk
                configuration are fixed; create a new knowledge base to change
                them.
              </p>
              {canManage ? (
                <form
                  key={base.revision}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const d = new FormData(e.currentTarget);
                    void action(async () => {
                      await requestJson(path, "PUT", {
                        name: String(d.get("name")),
                        description: String(d.get("description")),
                        publicAccess: d.get("publicAccess") === "on",
                        ...(canModel
                          ? {
                              approvalRequired:
                                d.get("approvalRequired") === "on",
                            }
                          : {}),
                        revision: base.revision,
                      });
                      setNotice("Knowledge settings saved");
                    });
                  }}
                >
                  <label>
                    Knowledge name
                    <input
                      name="name"
                      defaultValue={base.name}
                      required
                      maxLength={100}
                    />
                  </label>
                  <label>
                    Knowledge description
                    <input
                      name="description"
                      defaultValue={base.description}
                      maxLength={2000}
                    />
                  </label>
                  <label className="checkbox-label">
                    <input
                      name="publicAccess"
                      type="checkbox"
                      defaultChecked={base.public_access}
                    />{" "}
                    Allow knowledge in public hosted chat
                  </label>
                  <p className="muted">
                    Turning this off blocks retrieval from existing public
                    deployments immediately.
                  </p>
                  {canModel && (
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        name="approvalRequired"
                        defaultChecked={base.approval_required}
                      />
                      Require reviewed releases for retrieval
                    </label>
                  )}
                  <p className="muted">
                    When review is required, source edits stay out of agent
                    answers until a release is reviewed and published.
                  </p>
                  <Button type="submit" disabled={busy}>
                    Save knowledge settings
                  </Button>
                  <button
                    type="button"
                    className="text-button danger"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Archive this knowledge base and remove its searchable content? Attached agents will need another knowledge base.",
                        )
                      )
                        void action(async () => {
                          await requestJson(path, "DELETE");
                          setSelected("");
                        });
                    }}
                  >
                    Archive knowledge base
                  </button>
                </form>
              ) : (
                <p>
                  Public hosted chat access:{" "}
                  {base.public_access ? "Enabled" : "Disabled"}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
