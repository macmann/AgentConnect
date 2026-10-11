"use client";
import { useState } from "react";
export type ProcessingSettings = {
  enabled: boolean;
  llmAssisted: boolean;
  modelId: string | null;
  chunkTokens: number;
};
export const defaultProcessing: ProcessingSettings = {
  enabled: false,
  llmAssisted: false,
  modelId: null,
  chunkTokens: 500,
};
export function processingFromForm(form: FormData): ProcessingSettings {
  return {
    enabled: form.get("advancedEnabled") === "true",
    llmAssisted: form.get("advancedLlm") === "true",
    modelId: String(form.get("advancedModel") || "") || null,
    chunkTokens: Number(form.get("advancedTokens") || 500),
  };
}
export function processingChanged(
  stored: ProcessingSettings | undefined,
  current: ProcessingSettings,
) {
  const saved = stored ?? defaultProcessing;
  return (
    saved.enabled !== current.enabled ||
    (current.enabled &&
      (saved.chunkTokens !== current.chunkTokens ||
        saved.llmAssisted !== current.llmAssisted ||
        (current.llmAssisted && saved.modelId !== current.modelId)))
  );
}
export function AdvancedKnowledgeSettings({
  initial = defaultProcessing,
  parentContext = false,
  models,
}: {
  initial?: ProcessingSettings;
  parentContext?: boolean;
  models: { id: string; name: string }[];
}) {
  const [value, setValue] = useState(initial);
  return (
    <fieldset className="studio-form">
      <legend>Advanced knowledge processing</legend>
      <input
        type="hidden"
        name="advancedEnabled"
        value={String(value.enabled)}
      />
      <input
        type="hidden"
        name="advancedLlm"
        value={String(value.llmAssisted)}
      />
      <input type="hidden" name="advancedModel" value={value.modelId ?? ""} />
      <input type="hidden" name="advancedTokens" value={value.chunkTokens} />
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => setValue({ ...value, enabled: e.target.checked })}
        />
        Enable advanced document processing
      </label>
      <p className="muted">
        Optional processing for complex documents and financial tables.
        Preserves original values, identifies separate tables and grouped
        headers, and builds token-aware chunks. Adds ingestion time; standard
        processing stays unchanged when off.
      </p>
      {value.enabled && (
        <>
          <label>
            Target chunk size (tokens)
            <input
              aria-label="Target chunk size (tokens)"
              type="number"
              min={100}
              max={1500}
              required
              value={value.chunkTokens}
              onChange={(e) =>
                setValue({ ...value, chunkTokens: Number(e.target.value) })
              }
            />
          </label>
          <p className="muted">
            Measured with the o200k tokenizer. Wide table rows stay intact and
            may exceed this target. Review extraction warnings before publishing
            financial content.
          </p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={value.llmAssisted}
              onChange={(e) =>
                setValue({ ...value, llmAssisted: e.target.checked })
              }
            />
            Use LLM-assisted boundaries
          </label>
          <p className="muted">
            The selected model receives extracted document content during
            ingestion and chooses boundaries and header rows only. It cannot
            rewrite numeric values. Invalid output or provider failures fall
            back to deterministic processing with a warning. Limited to 12 calls
            per ingestion job.
          </p>
          {value.llmAssisted && (
            <label>
              Processing model
              <select
                aria-label="Processing model"
                required
                value={value.modelId ?? ""}
                onChange={(e) =>
                  setValue({ ...value, modelId: e.target.value || null })
                }
              >
                <option value="">Select a workspace model</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              {!models.length && (
                <span className="muted">
                  No models available. Register a model in Models first.
                </span>
              )}
            </label>
          )}
          <p className="muted">
            After indexing, open Extraction preview on the source to check
            tables, headers, units and warnings. This is not a guarantee of
            financial accuracy.
          </p>
        </>
      )}
      <label className="checkbox-label">
        <input
          name="parentContext"
          type="checkbox"
          defaultChecked={parentContext}
        />
        Expand retrieved passages with parent context
      </label>
      <p className="muted">
        Separate retrieval setting: adds bounded surrounding text or table rows
        from advanced indexed chunks. May increase chat token usage and latency.
        Older standard chunks remain usable without expansion.
      </p>
      <p className="muted">
        Processing changes apply when ingestion starts. Existing content stays
        unchanged until you choose Reingest. Retrieval settings apply
        immediately; approved releases retain their original indexed context.
      </p>
    </fieldset>
  );
}
