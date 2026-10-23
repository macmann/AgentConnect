"use client";
import { useState } from "react";
import { bulkMetadataUpdate } from "@agentconnect/schemas/knowledge-metadata";
import { MetadataFields } from "./knowledge-metadata";
import { requestJson } from "./agent-client";
import { Button } from "./button";
import { HelpTooltip } from "./help-tooltip";
export type TaggingOptions = { enabled: boolean; modelId: string | null };
export type TaggingModel = { id: string; name: string };
export function AITaggingOptions({
  value,
  onChange,
  models,
}: {
  value: TaggingOptions;
  onChange: (v: TaggingOptions) => void;
  models: TaggingModel[];
}) {
  return (
    <div className="metadata-ai-options">
      <div className="setting-label-row">
        <label className="checkbox-label">
          <input
            type="checkbox"
            role="switch"
            checked={value.enabled}
            onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
          />
          Suggest metadata with AI
        </label>
        <HelpTooltip>
          Optional. After ingestion, a bounded document excerpt is sent to the
          selected workspace model. One background model call per file may incur
          provider cost. AI suggests product, language, document type and tags.
          Nothing is applied until you review it. Shared upload metadata remains
          authoritative until you approve a change.
        </HelpTooltip>
      </div>
      {value.enabled && (
        <label>
          AI tagging model
          <select
            value={value.modelId ?? ""}
            onChange={(e) =>
              onChange({ ...value, modelId: e.target.value || null })
            }
            required
          >
            <option value="">Select a model</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {value.enabled && !models.length && (
        <p className="muted">
          Register a chat model in Models before requesting AI suggestions.
        </p>
      )}
    </div>
  );
}
export function TaggingRequest({
  path,
  sourceIds,
  models,
  onQueued,
}: {
  path: string;
  sourceIds: string[];
  models: TaggingModel[];
  onQueued: () => Promise<unknown>;
}) {
  const [options, setOptions] = useState<TaggingOptions>({
    enabled: false,
    modelId: null,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="metadata-ai-request">
      <AITaggingOptions value={options} onChange={setOptions} models={models} />
      {options.enabled && (
        <Button
          type="button"
          disabled={busy || !options.modelId || !sourceIds.length}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await requestJson(path + "/metadata-suggestions", "POST", {
                sourceIds,
                modelId: options.modelId,
              });
              await onQueued();
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "Unable to queue suggestions",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy
            ? "Queuing…"
            : `Generate suggestions for ${sourceIds.length} ${sourceIds.length === 1 ? "source" : "sources"}`}
        </Button>
      )}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
    </div>
  );
}
export type TaggingJob = {
  id: string;
  source_id: string;
  status: string;
  error_code: string | null;
  metadata_revision: number | null;
  suggestion: { tags: string[]; attributes: Record<string, string> } | null;
};
export function SuggestionReview({
  path,
  job,
  onSaved,
}: {
  path: string;
  job: TaggingJob;
  onSaved: () => Promise<unknown>;
}) {
  const [tags, setTags] = useState(job.suggestion?.tags ?? []),
    [attributes, setAttributes] = useState(job.suggestion?.attributes ?? {}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function review(action: "apply" | "reject") {
    setBusy(true);
    setError("");
    try {
      await requestJson(
        `${path}/metadata-suggestions/${job.id}/review`,
        "POST",
        {
          action,
          metadataRevision: job.metadata_revision ?? 0,
          tags,
          attributes,
        },
      );
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to review suggestions");
    } finally {
      setBusy(false);
    }
  }
  if (job.status === "pending_review" && job.suggestion)
    return (
      <details className="source-metadata-editor">
        <summary>Review AI metadata suggestions</summary>
        <p className="muted">
          Choose the suggested values to apply. Existing tags and unrelated
          fields are preserved; selected fields replace their current values.
        </p>
        <div className="metadata-suggestion-values">
          {job.suggestion.tags.map((tag) => (
            <label className="checkbox-label" key={tag}>
              <input
                type="checkbox"
                checked={tags.includes(tag)}
                onChange={(e) =>
                  setTags(
                    e.target.checked
                      ? [...tags, tag]
                      : tags.filter((t) => t !== tag),
                  )
                }
              />
              Add tag: {tag}
            </label>
          ))}
          {Object.entries(job.suggestion.attributes).map(([key, value]) => (
            <label className="checkbox-label" key={key}>
              <input
                type="checkbox"
                checked={Object.hasOwn(attributes, key)}
                onChange={(e) => {
                  const next = { ...attributes };
                  if (e.target.checked) next[key] = value;
                  else delete next[key];
                  setAttributes(next);
                }}
              />
              Set {key}: {value}
            </label>
          ))}
        </div>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <Button
            type="button"
            disabled={busy}
            onClick={() => void review("apply")}
          >
            Apply reviewed suggestions
          </Button>
          <Button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void review("reject")}
          >
            Reject suggestions
          </Button>
        </div>
      </details>
    );
  return (
    <p className="muted" role="status">
      AI tagging:{" "}
      {job.status === "queued"
        ? "waiting for ingestion / worker"
        : job.status.replaceAll("_", " ")}
      {job.error_code ? ` · ${job.error_code}` : ""}
    </p>
  );
}
export type BulkSource = {
  id: string;
  title: string;
  metadata: { metadataRevision?: number };
};
type BulkPreview = {
  changes: {
    id: string;
    title: string;
    before: { tags: string[]; attributes: Record<string, string> };
    after: { tags: string[]; attributes: Record<string, string> };
  }[];
};
export function BulkMetadataEditor({
  path,
  sources,
  onSaved,
  models,
}: {
  path: string;
  sources: BulkSource[];
  onSaved: () => Promise<unknown>;
  models: TaggingModel[];
}) {
  const [value, setValue] = useState({
      tagsAll: [] as string[],
      attributes: {} as Record<string, string>,
    }),
    [removeTags, setRemoveTags] = useState(""),
    [removeKeys, setRemoveKeys] = useState("");
  const [preview, setPreview] = useState<BulkPreview | null>(null),
    [fingerprint, setFingerprint] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const payload = {
    sources: sources.map((s) => ({
      id: s.id,
      metadataRevision: s.metadata.metadataRevision ?? 0,
    })),
    addTags: value.tagsAll,
    removeTags: removeTags
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    setAttributes: value.attributes,
    removeAttributes: removeKeys
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
  const current = JSON.stringify(payload);
  async function submit(dryRun: boolean) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const parsed = bulkMetadataUpdate.safeParse({ ...payload, dryRun });
      if (!parsed.success)
        throw new Error(parsed.error.issues.map((i) => i.message).join(". "));
      const result = await requestJson<BulkPreview>(
        path + "/metadata/bulk",
        "POST",
        parsed.data,
      );
      if (dryRun) {
        setPreview(result);
        setFingerprint(current);
      } else {
        setPreview(null);
        setNotice(`Metadata updated for ${sources.length} sources.`);
        await onSaved();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to update metadata");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="metadata-bulk-editor" aria-label="Bulk metadata editor">
      <h4>{sources.length} sources selected</h4>
      <p className="muted">
        Add/remove tags or set/remove specific fields. Other metadata and
        indexed content stay unchanged.
      </p>
      <MetadataFields value={value} onChange={setValue} />
      <div className="form-grid">
        <label>
          Remove tags
          <input
            value={removeTags}
            onChange={(e) => setRemoveTags(e.target.value)}
            placeholder="Comma-separated tags"
          />
        </label>
        <label>
          Remove field keys
          <input
            value={removeKeys}
            onChange={(e) => setRemoveKeys(e.target.value)}
            placeholder="Comma-separated field keys"
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="form-actions">
        <Button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void submit(true)}
        >
          Preview bulk changes
        </Button>
        <Button
          type="button"
          disabled={busy || !preview || fingerprint !== current}
          onClick={() => void submit(false)}
        >
          Apply to {sources.length} sources
        </Button>
      </div>
      {preview && fingerprint === current && (
        <details className="metadata-bulk-preview" open>
          <summary>Review changes for {preview.changes.length} sources</summary>
          <ul>
            {preview.changes.map((c) => (
              <li key={c.id}>
                <strong>{c.title}</strong>
                <p>
                  Tags: {c.before.tags.join(", ") || "None"} →{" "}
                  {c.after.tags.join(", ") || "None"}
                </p>
                <p>
                  Fields:{" "}
                  {Object.entries(c.before.attributes)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(", ") || "None"}{" "}
                  →{" "}
                  {Object.entries(c.after.attributes)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(", ") || "None"}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}
      <details className="source-metadata-editor">
        <summary>AI suggestions for selected sources</summary>
        <TaggingRequest
          path={path}
          sourceIds={sources.map((s) => s.id)}
          models={models}
          onQueued={onSaved}
        />
      </details>
    </section>
  );
}
