"use client";
import { useId, useState, type FormEvent } from "react";
import type { MetadataFilter } from "@agentconnect/schemas/knowledge-metadata";
import { sourceMetadataUpdate } from "@agentconnect/schemas/knowledge-metadata";
import { HelpTooltip } from "./help-tooltip";
import { Button } from "./button";
import { requestJson } from "./agent-client";

export function MetadataFields({
  value,
  onChange,
  filtering = false,
}: {
  value: MetadataFilter;
  onChange: (value: MetadataFilter) => void;
  filtering?: boolean;
}) {
  const id = useId();
  const [tagsText, setTagsText] = useState(value.tagsAll.join(", "));
  const [keyError, setKeyError] = useState("");
  const attributes = Object.entries(value.attributes);
  // Keep typing punctuation while reflecting external draft resets/discards.
  const parsedTags = tagsText
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const displayedTags =
    JSON.stringify(parsedTags) === JSON.stringify(value.tagsAll)
      ? tagsText
      : value.tagsAll.join(", ");
  return (
    <fieldset className="knowledge-metadata-fields">
      <legend>
        {filtering ? "Metadata filters" : "Source metadata"}{" "}
        <HelpTooltip label="About knowledge metadata">
          {filtering
            ? "All required tags and key/value pairs must match exactly. Matching is case-sensitive. Filters apply before vector and text search. No filters searches all eligible sources; these filters do not replace access permissions."
            : "Tags and custom fields help organize sources and narrow retrieval. Use lowercase field keys, such as product or effective_date. Changes apply immediately to current retrieval without re-embedding; publish a new release to update approved metadata."}
        </HelpTooltip>
      </legend>
      <label htmlFor={`${id}-tags`}>
        {filtering ? "Required tags" : "Tags"}
      </label>
      <input
        id={`${id}-tags`}
        value={displayedTags}
        maxLength={1100}
        placeholder="policy, retail"
        onChange={(e) => {
          setTagsText(e.target.value);
          onChange({
            ...value,
            tagsAll: e.target.value
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean),
          });
        }}
      />
      <p className="muted">
        Comma-separated tags{filtering ? "; all must match" : ""}.
      </p>
      {attributes.map(([key, fieldValue], index) => (
        <div className="knowledge-metadata-row" key={index}>
          <label>
            Field key {index + 1}
            <input
              value={key}
              placeholder="product"
              maxLength={40}
              onChange={(e) => {
                const next = e.target.value;
                if (next !== key && Object.hasOwn(value.attributes, next)) {
                  setKeyError("Field keys must be unique.");
                  return;
                }
                setKeyError("");
                onChange({
                  ...value,
                  attributes: Object.fromEntries(
                    attributes.map((pair, i) =>
                      i === index ? [next, fieldValue] : pair,
                    ),
                  ),
                });
              }}
            />
          </label>
          <label>
            Field value {index + 1}
            <input
              value={fieldValue}
              placeholder="loans"
              maxLength={200}
              onChange={(e) =>
                onChange({
                  ...value,
                  attributes: { ...value.attributes, [key]: e.target.value },
                })
              }
            />
          </label>
          <Button
            type="button"
            className="secondary"
            aria-label={`Remove metadata field ${index + 1}`}
            onClick={() =>
              onChange({
                ...value,
                attributes: Object.fromEntries(
                  attributes.filter((_, i) => i !== index),
                ),
              })
            }
          >
            Remove
          </Button>
        </div>
      ))}
      {keyError && (
        <p role="alert" className="error-banner">
          {keyError}
        </p>
      )}
      <Button
        type="button"
        className="secondary"
        disabled={attributes.length >= 20}
        onClick={() => {
          let number = attributes.length + 1;
          while (Object.hasOwn(value.attributes, `field_${number}`)) number++;
          onChange({
            ...value,
            attributes: { ...value.attributes, [`field_${number}`]: "" },
          });
        }}
      >
        Add metadata field
      </Button>
    </fieldset>
  );
}

export function SourceMetadataEditor({
  path,
  source,
  onSaved,
}: {
  path: string;
  source: {
    id: string;
    title: string;
    metadata: {
      tags?: string[];
      attributes?: Record<string, string>;
      metadataRevision?: number;
    };
  };
  onSaved: () => Promise<unknown>;
}) {
  const [value, setValue] = useState<MetadataFilter>({
    tagsAll: source.metadata.tags ?? [],
    attributes: source.metadata.attributes ?? {},
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [revision, setRevision] = useState(
    source.metadata.metadataRevision ?? 0,
  );
  const [dirty, setDirty] = useState(false);
  const incomingRevision = source.metadata.metadataRevision ?? 0;
  const refreshClean = !dirty && incomingRevision > revision;
  const visibleValue = refreshClean
    ? {
        tagsAll: source.metadata.tags ?? [],
        attributes: source.metadata.attributes ?? {},
      }
    : value;
  const visibleRevision = refreshClean ? incomingRevision : revision;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent) {
    e.preventDefault();
    const parsed = sourceMetadataUpdate.safeParse({
      tags: visibleValue.tagsAll,
      attributes: visibleValue.attributes,
      metadataRevision: visibleRevision,
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join(". "));
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await requestJson<{
        metadataRevision: number;
        tags: string[];
        attributes: Record<string, string>;
      }>(`${path}/sources/${source.id}/metadata`, "PUT", parsed.data);
      setRevision(saved.metadataRevision);
      setValue({ tagsAll: saved.tags, attributes: saved.attributes });
      setDirty(false);
      await onSaved();
      setNotice(
        "Metadata saved. Published releases keep their original metadata.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save metadata");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="source-metadata-editor">
      <summary>
        Tags &amp; metadata
        {source.metadata.tags?.length
          ? ` · ${source.metadata.tags.length} tags`
          : ""}
      </summary>
      <form onSubmit={save} aria-label={`Metadata for ${source.title}`}>
        <MetadataFields
          key={reloadKey}
          value={visibleValue}
          onChange={(next) => {
            setRevision(visibleRevision);
            setValue(next);
            setDirty(true);
          }}
        />
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <div className="form-actions">
          <Button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const current = await requestJson<{
                  tags: string[];
                  attributes: Record<string, string>;
                  metadataRevision: number;
                }>(`${path}/sources/${source.id}/metadata`);
                setValue({
                  tagsAll: current.tags,
                  attributes: current.attributes,
                });
                setRevision(current.metadataRevision);
                setDirty(false);
                setReloadKey((v) => v + 1);
                setNotice("Latest metadata loaded.");
              } catch (e) {
                setError(
                  e instanceof Error ? e.message : "Unable to reload metadata",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            Reload metadata
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save metadata"}
          </Button>
        </div>
      </form>
    </details>
  );
}
