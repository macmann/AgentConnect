"use client";
import {
  AITaggingOptions,
  BulkMetadataEditor,
  TaggingRequest,
  SuggestionReview,
  type TaggingJob,
  type TaggingOptions,
} from "./knowledge-bulk-metadata";
import { MetadataFields, SourceMetadataEditor } from "./knowledge-metadata";
import {
  metadataFilter as metadataFilterSchema,
  type MetadataFilter,
} from "@agentconnect/schemas/knowledge-metadata";
import { KnowledgeUploads, useKnowledgeUploads } from "./knowledge-uploads";
import { ExtractionUsage } from "./extraction-usage";
import { ExtractionReview, type ExtractionPage } from "./extraction-review";
import { HelpTooltip } from "./help-tooltip";
import { websiteInput } from "@agentconnect/schemas/knowledge";
import {
  AdvancedKnowledgeSettings,
  processingFromForm,
  processingChanged,
  type ProcessingSettings,
} from "./advanced-knowledge-settings";
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
  ocr_enabled: boolean;
  advanced_processing: ProcessingSettings;
  parent_context: boolean;
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
    attributes?: Record<string, string>;
    metadataRevision?: number;
    aiExtractionProgress?: {
      page: number;
      extractedPages: number;
      maxPages: number;
    };
    processing?: ProcessingSettings;
    processingWarnings?: string[];
    crawler?: string;
    maxPages?: number;
    crawlPageCount?: number;
    maxDepth?: number;
    ocrPages?: number;
    unrecognizedPages?: number;
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
  const uploads = useKnowledgeUploads(workspaceId);
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
  const [usageSource, setUsageSource] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [extraction, setExtraction] = useState<{
    sourceId: string;
    status: string;
    revision: number;
    documents: {
      id: string;
      title: string;
      ai_extraction?: {
        modelId: string;
        pages: ExtractionPage[];
      };
      extraction: {
        warnings: string[];
        tables: {
          heading: string | null;
          page: number | null;
          columns: string[];
          rowCount: number;
          preview: string;
        }[];
        llm: {
          status: string;
          calls: number;
          inputTokens: number | null;
          outputTokens: number | null;
        };
      } | null;
    }[];
  } | null>(null);
  const [sharedMetadata, setSharedMetadata] = useState<MetadataFilter>({
    tagsAll: [],
    attributes: {},
  });
  const [uploadTagging, setUploadTagging] = useState<TaggingOptions>({
    enabled: false,
    modelId: null,
  });
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [metadataFilter, setMetadataFilter] = useState<MetadataFilter>({
    tagsAll: [],
    attributes: {},
  });
  const [editing, setEditing] = useState<Source | null>(null);
  const [provider, setProvider] = useState("openai");
  const [crawler, setCrawler] = useState("builtin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [preview, setPreview] = useState<
    | {
        id: string;
        content: string;
        page: number | null;
        title: string;
        chunk_metadata?: { tokenCount?: number; tokenizer?: string };
      }[]
    | null
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
  const processingModels = useQuery({
    queryKey: ["knowledge-processing-models", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(
        `/workspaces/${workspaceId}/models`,
      ),
    enabled: canManage,
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
  const taggingJobs = useQuery({
    queryKey: ["metadata-suggestions", selected],
    queryFn: () =>
      requestJson<TaggingJob[]>(
        `/knowledge-bases/${selected}/metadata-suggestions`,
      ),
    enabled: canManage && !!selected,
    refetchInterval: (q) =>
      q.state.data?.some((j) => ["queued", "running"].includes(j.status))
        ? 2000
        : false,
  });
  async function refreshMetadata() {
    await Promise.all([sources.refetch(), taggingJobs.refetch()]);
  }
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
    if (form === "upload") {
      try {
        if (!base) throw new Error("Select a knowledge base first");
        uploads.add(
          data.getAll("file").filter((f): f is File => f instanceof File),
          { id: base.id, name: base.name },
          {
            tags: sharedMetadata.tagsAll,
            attributes: sharedMetadata.attributes,
            tagging: uploadTagging,
          },
        );
        setError("");
        setNotice(
          "Files added to the upload queue. Keep Knowledge open until transfers finish.",
        );
        setForm(null);
      } catch (error) {
        setError((error as Error).message);
      }
      return;
    }
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
            ocrEnabled: data.get("ocrEnabled") === "on",
            advancedProcessing: processingFromForm(data),
            parentContext: data.get("parentContext") === "on",
          },
        );
        setSelected(created.id);
        setTab("sources");
        setNotice("Knowledge base created");
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
        const parsed = websiteInput.safeParse({
          url: value("url").trim(),
          crawler,
          secretId:
            crawler === "firecrawl" ? value("crawlSecretId") || null : null,
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
        if (!parsed.success) {
          const labels: Record<string, string> = {
            url: "Website URL",
            secretId: "Firecrawl credential",
            maxPages: "Page limit",
            maxDepth: "Crawl depth",
            allowedPaths: "Allowed path prefixes",
            blockedPaths: "Blocked path prefixes",
          };
          throw new Error(
            parsed.error.issues
              .map(
                (i) =>
                  `${labels[String(i.path[0])] ?? "Website settings"}: ${i.message}`,
              )
              .join("; "),
          );
        }
        await requestJson(path + "/website", "POST", parsed.data);
        setNotice(
          "Website crawl queued. Once Ready, attach this knowledge base in Agent Configure → Knowledge.",
        );
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
      const parsed = metadataFilterSchema.safeParse(metadataFilter);
      if (!parsed.success)
        throw new Error(
          parsed.error.issues.map((issue) => issue.message).join(". "),
        );
      setResult(
        await requestJson<Result>(path + "/search", "POST", {
          metadataFilter: parsed.data,
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
                if (
                  !window.dispatchEvent(
                    new Event("knowledge-review:before-close", {
                      cancelable: true,
                    }),
                  )
                )
                  return;
                setSelected("");
                setForm(null);
                setResult(null);
                setPreview(null);
                setExtraction(null);
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
      <KnowledgeUploads queue={uploads} sources={sources.data ?? []} />
      {form && (
        <form className="studio-form" onSubmit={submit}>
          <div className="panel-header">
            <h3>
              {
                {
                  base: "Create knowledge base",
                  embedding: "Register embedding model",
                  upload: "Upload documents",
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
                <div className="setting-label-row">
                  <label className="checkbox-label">
                    <input type="checkbox" name="ocrEnabled" />
                    Recognize scanned PDF pages with OCR
                  </label>
                  <HelpTooltip>
                    Requires OCR_ENABLED=true and Poppler/Tesseract on the
                    worker. Supports English scans, up to 20 scanned pages per
                    document. Review recognition accuracy before publishing.
                  </HelpTooltip>
                </div>
                <AdvancedKnowledgeSettings
                  models={processingModels.data ?? []}
                />

                <div className="setting-label-row">
                  <label className="checkbox-label">
                    <input name="publicAccess" type="checkbox" /> Allow
                    knowledge in public hosted chat
                  </label>
                  <HelpTooltip>
                    Public chat can reveal retrieved passages. Leave this off
                    for internal knowledge.
                  </HelpTooltip>
                </div>
              </>
            )}
            {form === "upload" && (
              <>
                <label>
                  Document files
                  <input
                    name="file"
                    type="file"
                    multiple
                    accept=".pdf,.docx,.pptx,.xlsx,.csv,.txt,.md,.markdown,.html,.htm,.json,.png,.jpg,.jpeg,.webp"
                    required
                  />
                </label>
                <p className="muted">
                  PDF, Office documents, CSV, text, Markdown, HTML and JSON.
                  Select up to 100 files, maximum 10 MB each. Files upload
                  gradually and queue for background ingestion. Enable OCR or AI
                  extraction for scanned PDFs. Image uploads require AI
                  extraction.
                </p>
                <details className="source-metadata-editor">
                  <summary>Shared metadata for all selected files</summary>
                  <MetadataFields
                    value={sharedMetadata}
                    onChange={setSharedMetadata}
                  />
                </details>
                <AITaggingOptions
                  value={uploadTagging}
                  onChange={setUploadTagging}
                  models={processingModels.data ?? []}
                />
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
                <p className="muted">
                  Enter the main URL to discover linked pages, extract their
                  content and index it for RAG. Ingestion runs in the
                  background; data becomes searchable when the source is Ready.
                </p>
                <label>
                  Crawler
                  <select
                    aria-label="Crawler"
                    value={crawler}
                    onChange={(event) => setCrawler(event.target.value)}
                  >
                    <option value="builtin">
                      Built-in (Cheerio) — no API key
                    </option>
                    <option value="firecrawl">
                      Firecrawl — rendered websites
                    </option>
                  </select>
                </label>
                {crawler === "firecrawl" && (
                  <>
                    <label>
                      Firecrawl credential
                      <select
                        name="crawlSecretId"
                        aria-label="Firecrawl credential"
                        required
                      >
                        <option value="">Select workspace API key</option>
                        {secrets.data?.map((secret) => (
                          <option key={secret.id} value={secret.id}>
                            {secret.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="muted">
                      Save your Firecrawl API key in workspace Secrets first.
                      Firecrawl is an external service and uses your account
                      credits. It renders JavaScript and receives the starting
                      URL; use public HTTPS websites.
                    </p>
                    <a
                      className="text-button"
                      href={`/#view=Secrets&workspace=${workspaceId}`}
                    >
                      Manage workspace secrets
                    </a>
                  </>
                )}
                <div className="form-grid">
                  <label>
                    Website URL
                    <input
                      name="url"
                      type="url"
                      required
                      maxLength={1000}
                      pattern={
                        crawler === "firecrawl" ? "https://.*" : undefined
                      }
                    />
                  </label>
                  <label>
                    Page limit
                    <input
                      name="maxPages"
                      type="number"
                      min={1}
                      max={100}
                      defaultValue={20}
                      required
                    />
                  </label>
                  <label>
                    Crawl depth
                    <input
                      name="maxDepth"
                      type="number"
                      min={0}
                      max={5}
                      defaultValue={2}
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
                  Crawl only this website, within the page and depth limits.
                  Path prefixes are comma-separated (for example /help,
                  /products). Website hosts must match the exact hostname
                  (including www) approved in the API and worker
                  KNOWLEDGE_ALLOWED_HOSTS settings. Restart both after editing
                  the repository-root .env. The built-in crawler respects
                  robots.txt, follows bounded same-origin redirects and extracts
                  static HTML; use Firecrawl for rendered content.
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
                      ? "Start uploads"
                      : form === "website"
                        ? "Start website crawl"
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
                      setSelectedSourceIds([]);
                      setTab("sources");
                      setResult(null);
                      setPreview(null);
                      setExtraction(null);
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
                    if (
                      !window.dispatchEvent(
                        new Event("knowledge-review:before-close", {
                          cancelable: true,
                        }),
                      )
                    )
                      return;
                    setTab(t);
                    setForm(null);
                    setPreview(null);
                    setExtraction(null);
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
              workspaceId={workspaceId}
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
              {canManage &&
                selectedSourceIds.some((id) =>
                  sources.data?.some((s) => s.id === id),
                ) && (
                  <BulkMetadataEditor
                    path={path}
                    sources={
                      sources.data?.filter((s) =>
                        selectedSourceIds.includes(s.id),
                      ) ?? []
                    }
                    models={processingModels.data ?? []}
                    onSaved={refreshMetadata}
                  />
                )}
              {sources.data?.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {canManage && (
                          <th>
                            <input
                              type="checkbox"
                              aria-label="Select up to 100 sources"
                              checked={
                                !!sources.data?.length &&
                                sources.data
                                  .slice(0, 100)
                                  .every((s) =>
                                    selectedSourceIds.includes(s.id),
                                  )
                              }
                              onChange={(e) =>
                                setSelectedSourceIds(
                                  e.target.checked
                                    ? sources
                                        .data!.slice(0, 100)
                                        .map((s) => s.id)
                                    : [],
                                )
                              }
                            />
                          </th>
                        )}
                        <th>Source</th>
                        <th>Status</th>
                        <th>Chunks</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sources.data.map((s) => (
                        <tr key={s.id}>
                          {canManage && (
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Select source ${s.title}`}
                                checked={selectedSourceIds.includes(s.id)}
                                disabled={
                                  selectedSourceIds.length >= 100 &&
                                  !selectedSourceIds.includes(s.id)
                                }
                                onChange={(e) =>
                                  setSelectedSourceIds(
                                    e.target.checked
                                      ? [...selectedSourceIds, s.id]
                                      : selectedSourceIds.filter(
                                          (id) => id !== s.id,
                                        ),
                                  )
                                }
                              />
                            </td>
                          )}
                          <td>
                            <strong>{s.title}</strong>
                            {canManage ? (
                              <SourceMetadataEditor
                                key={s.id}
                                path={path}
                                source={s}
                                onSaved={async () => {
                                  await sources.refetch();
                                }}
                              />
                            ) : (
                              <small>{s.metadata.tags?.join(", ")}</small>
                            )}
                            {canManage && (
                              <details className="source-metadata-editor">
                                <summary>AI metadata tagging</summary>
                                <TaggingRequest
                                  path={path}
                                  sourceIds={[s.id]}
                                  models={processingModels.data ?? []}
                                  onQueued={refreshMetadata}
                                />
                                {taggingJobs.data
                                  ?.filter((j) => j.source_id === s.id)
                                  .map((j) => (
                                    <SuggestionReview
                                      key={j.id + ":" + j.status}
                                      path={path}
                                      job={j}
                                      onSaved={refreshMetadata}
                                    />
                                  ))}
                              </details>
                            )}
                            <small>
                              {s.metadata.connectorId
                                ? "S3 connector"
                                : s.kind === "website"
                                  ? `Website crawl · ${s.metadata.crawler === "firecrawl" ? "Firecrawl" : "Built-in"}`
                                  : s.kind}{" "}
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
                              {s.status === "processing" &&
                                s.metadata.aiExtractionProgress &&
                                ` · AI page ${s.metadata.aiExtractionProgress.page} (${s.metadata.aiExtractionProgress.extractedPages}/${s.metadata.aiExtractionProgress.maxPages} allowance)`}
                            </span>
                            {!!s.metadata.ocrPages && (
                              <small>
                                OCR recognized {s.metadata.ocrPages} pages ·
                                review accuracy
                              </small>
                            )}
                            {!!s.metadata.unrecognizedPages && (
                              <small className="error">
                                {s.metadata.unrecognizedPages} pages may contain
                                scanned content that was not recognized. Enable
                                OCR and reindex if needed.
                              </small>
                            )}
                            {s.error_code && (
                              <small className="error">
                                {s.error_code}
                                {s.error_code?.startsWith(
                                  "FIRECRAWL_AUTHENTICATION",
                                )
                                  ? ": Check the selected workspace Firecrawl key."
                                  : s.error_code ===
                                      "FIRECRAWL_CREDITS_REQUIRED"
                                    ? ": Add credits to your Firecrawl account."
                                    : s.error_code ===
                                        "WEBSITE_REDIRECT_BLOCKED"
                                      ? ": Redirect leaves the starting origin or has an invalid target. Use the final website URL and approve its exact host."
                                      : s.error_code ===
                                          "WEBSITE_REDIRECT_LIMIT"
                                        ? ": Redirect loop or more than five redirects. Use the direct landing-page URL."
                                        : s.error_code ===
                                            "WEBSITE_PATH_BLOCKED"
                                          ? ": A redirect target falls outside the allowed path prefixes or into a blocked path."
                                          : s.error_code === "EMPTY_DOCUMENT"
                                            ? ": Try Firecrawl for JavaScript-rendered pages."
                                            : ""}
                              </small>
                            )}
                          </td>
                          <td>
                            {s.chunk_count}
                            {s.kind === "website" &&
                              s.metadata.crawlPageCount !== undefined && (
                                <small>
                                  {s.metadata.crawlPageCount} pages indexed
                                </small>
                              )}
                          </td>
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
                              <button
                                className="text-button"
                                disabled={busy || s.status !== "ready"}
                                onClick={() => {
                                  if (
                                    !window.dispatchEvent(
                                      new Event(
                                        "knowledge-review:before-close",
                                        { cancelable: true },
                                      ),
                                    )
                                  )
                                    return;
                                  return action(async () =>
                                    setExtraction(
                                      await requestJson(
                                        path + `/sources/${s.id}/extraction`,
                                      ),
                                    ),
                                  );
                                }}
                              >
                                Extraction preview
                              </button>
                              <button
                                type="button"
                                className="text-button"
                                onClick={() =>
                                  setUsageSource({ id: s.id, title: s.title })
                                }
                              >
                                Usage &amp; traces
                              </button>
                              {!!s.metadata.processingWarnings?.length && (
                                <span className="muted">
                                  Extraction needs review
                                </span>
                              )}
                              {s.status === "ready" &&
                                processingChanged(
                                  s.metadata.processing,
                                  base.advanced_processing,
                                ) && (
                                  <span className="muted">
                                    Processing changed · Reingest to apply
                                  </span>
                                )}
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
                                          setExtraction(null);
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
              {usageSource && (
                <section className="studio-panel">
                  <div className="studio-actions">
                    <h3>{usageSource.title}</h3>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setUsageSource(null)}
                    >
                      Close usage
                    </button>
                  </div>
                  <ExtractionUsage
                    key={usageSource.id}
                    knowledgeBaseId={base.id}
                    sourceId={usageSource.id}
                  />
                </section>
              )}
              {extraction && (
                <section
                  className="chunk-preview"
                  aria-label="Extraction preview"
                >
                  <div className="panel-header">
                    <h3>Extraction preview · revision {extraction.revision}</h3>
                    <button
                      className="text-button"
                      onClick={() => {
                        if (
                          window.dispatchEvent(
                            new Event("knowledge-review:before-close", {
                              cancelable: true,
                            }),
                          )
                        )
                          setExtraction(null);
                      }}
                    >
                      Close extraction preview
                    </button>
                  </div>
                  {extraction.documents.map((d) => (
                    <div key={d.id}>
                      <h4>{d.title}</h4>
                      {d.ai_extraction && (
                        <ExtractionReview
                          key={d.id + ":" + extraction.revision}
                          knowledgeBaseId={selected}
                          sourceId={extraction.sourceId}
                          documentId={d.id}
                          revision={extraction.revision}
                          pages={d.ai_extraction.pages}
                          canEdit={canManage && extraction.status === "ready"}
                          onQueued={(message) => {
                            setExtraction(null);
                            setNotice(
                              message ??
                                "Corrections saved. Reindexing is queued; published releases remain unchanged.",
                            );
                            void cache.invalidateQueries();
                          }}
                        />
                      )}
                      {d.ai_extraction && (
                        <details>
                          <summary>
                            AI extraction · {d.ai_extraction.pages.length} pages
                          </summary>
                          <p>
                            Original-language transcription. Verify uncertain
                            content and financial values against the source
                            before publishing.
                          </p>
                          {d.ai_extraction.pages.map((p) => (
                            <section key={p.page}>
                              <h4>
                                Page {p.page} · {p.language}{" "}
                                {p.cached ? "· Cached" : ""}
                              </h4>
                              {p.warnings.map((w, i) => (
                                <p className="error" key={i}>
                                  {w}
                                </p>
                              ))}
                              {p.blocks.map((b, i) => (
                                <div key={i}>
                                  {b.heading && <h4>{b.heading}</h4>}
                                  {b.kind === "table" ? (
                                    <div className="table-wrap">
                                      <table>
                                        <tbody>
                                          {b.rows.map((r, j) => (
                                            <tr key={j}>
                                              {r.map((cell, k) =>
                                                j < b.headerRows ? (
                                                  <th key={k} scope="col">
                                                    {cell}
                                                  </th>
                                                ) : (
                                                  <td key={k}>{cell}</td>
                                                ),
                                              )}
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  ) : (
                                    <p style={{ whiteSpace: "pre-wrap" }}>
                                      {b.text}
                                    </p>
                                  )}
                                </div>
                              ))}
                            </section>
                          ))}
                        </details>
                      )}
                      {!d.extraction ? (
                        <p className="muted">
                          This source used standard processing. Enable advanced
                          processing and Reingest to see detected tables.
                          Inspect chunks to review its current text.
                        </p>
                      ) : (
                        <>
                          <p className="muted">
                            LLM assistance: {d.extraction.llm.status} ·{" "}
                            {d.extraction.llm.calls} calls · Reported usage:{" "}
                            {d.extraction.llm.inputTokens ?? "Unknown"} input /{" "}
                            {d.extraction.llm.outputTokens ?? "Unknown"} output
                            tokens
                          </p>
                          {d.extraction.warnings.length > 0 && (
                            <div role="status">
                              <strong>Review before publishing</strong>
                              <ul>
                                {d.extraction.warnings.map((w) => (
                                  <li key={w}>{w}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {!d.extraction.tables.length && (
                            <p className="muted">
                              No tables detected. Inspect chunks to review the
                              extracted narrative.
                            </p>
                          )}
                          {d.extraction.tables.map((t, i) => (
                            <details key={i}>
                              <summary>
                                {t.heading || `Table ${i + 1}`} · {t.rowCount}{" "}
                                {t.rowCount === 1 ? "row" : "rows"}
                                {t.page ? ` · page ${t.page}` : ""}
                              </summary>
                              <p className="muted">
                                Columns: {t.columns.join(" | ")}
                              </p>
                              <pre
                                style={{
                                  whiteSpace: "pre-wrap",
                                  overflowWrap: "anywhere",
                                }}
                              >
                                {t.preview}
                              </pre>
                            </details>
                          ))}
                        </>
                      )}
                    </div>
                  ))}
                  {!extraction.documents.length && (
                    <p className="muted">
                      No current extraction is available. Wait for ingestion to
                      finish.
                    </p>
                  )}
                  <p className="muted">
                    Preview is bounded to 100 tables per document and 6,000
                    characters per table. Use Inspect chunks for the indexed
                    passages. Verify financial values against the original
                    document.
                  </p>
                </section>
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
                      {c.chunk_metadata?.tokenCount !== undefined && (
                        <p className="muted">
                          {c.chunk_metadata.tokenCount} tokens ·{" "}
                          {c.chunk_metadata.tokenizer}
                        </p>
                      )}
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
                  <details className="source-metadata-editor">
                    <summary>Filter by tags &amp; metadata</summary>
                    <MetadataFields
                      value={metadataFilter}
                      onChange={setMetadataFilter}
                      filtering
                    />
                  </details>
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
                        ocrEnabled: d.get("ocrEnabled") === "on",
                        advancedProcessing: processingFromForm(d),
                        parentContext: d.get("parentContext") === "on",
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
                  <div className="setting-label-row">
                    <label className="checkbox-label">
                      <input
                        name="publicAccess"
                        type="checkbox"
                        defaultChecked={base.public_access}
                      />{" "}
                      Allow knowledge in public hosted chat
                    </label>
                    <HelpTooltip>
                      Turning this off blocks retrieval from existing public
                      deployments immediately.
                    </HelpTooltip>
                  </div>
                  <div className="setting-label-row">
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        name="ocrEnabled"
                        defaultChecked={base.ocr_enabled}
                      />
                      Recognize scanned PDF pages with OCR
                    </label>
                    <HelpTooltip>
                      Requires OCR_ENABLED=true and Poppler/Tesseract on the
                      worker. Applies to new ingestion or reindexing; existing
                      chunks do not change automatically. English OCR is limited
                      to 20 scanned pages per document.
                    </HelpTooltip>
                  </div>
                  <AdvancedKnowledgeSettings
                    key={base.revision}
                    initial={base.advanced_processing}
                    parentContext={base.parent_context}
                    models={processingModels.data ?? []}
                  />
                  {canModel && (
                    <div className="setting-label-row">
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          name="approvalRequired"
                          defaultChecked={base.approval_required}
                        />
                        Require reviewed releases for retrieval
                      </label>
                      <HelpTooltip label="About reviewed releases">
                        Source edits stay out of agent answers until a release
                        is reviewed and published.
                      </HelpTooltip>
                    </div>
                  )}
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
