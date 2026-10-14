"use client";
import { HelpTooltip } from "./help-tooltip";
import { useState } from "react";
export type ProcessingSettings = {
  enabled: boolean;
  llmAssisted: boolean;
  modelId: string | null;
  chunkTokens: number;
  vision?: {
    enabled: boolean;
    modelId: string | null;
    scope: "scanned" | "complex" | "all";
    languages: string;
    maxPages: number;
    maxOutputTokens: number;
  };
};
const defaultVision = {
  enabled: false,
  modelId: null as string | null,
  scope: "scanned" as const,
  languages: "auto",
  maxPages: 20,
  maxOutputTokens: 8192,
};
export const defaultProcessing: ProcessingSettings = {
  enabled: false,
  llmAssisted: false,
  modelId: null,
  chunkTokens: 500,
};
export function processingFromForm(form: FormData): ProcessingSettings {
  return {
    vision: {
      enabled: form.get("visionEnabled") === "true",
      modelId: String(form.get("visionModel") || "") || null,
      scope: String(form.get("visionScope") || "scanned") as
        "scanned" | "complex" | "all",
      languages: String(form.get("visionLanguages") || "auto"),
      maxPages: Number(form.get("visionPages") || 20),
      maxOutputTokens: Number(form.get("visionTokens") || 8192),
    },
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
    JSON.stringify(saved.vision ?? defaultVision) !==
      JSON.stringify(current.vision ?? defaultVision) ||
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
  const vision = value.vision ?? defaultVision;
  const updateVision = (
    patch: Partial<NonNullable<ProcessingSettings["vision"]>>,
  ) => setValue({ ...value, vision: { ...vision, ...patch } });
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
      <input
        type="hidden"
        name="visionEnabled"
        value={String(value.enabled && vision.enabled)}
      />
      <input type="hidden" name="visionModel" value={vision.modelId ?? ""} />
      <input type="hidden" name="visionScope" value={vision.scope} />
      <input type="hidden" name="visionLanguages" value={vision.languages} />
      <input type="hidden" name="visionPages" value={vision.maxPages} />
      <input type="hidden" name="visionTokens" value={vision.maxOutputTokens} />
      <div className="setting-label-row">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(e) => setValue({ ...value, enabled: e.target.checked })}
          />
          Enable advanced document processing
        </label>
        <HelpTooltip>
          Optional processing for complex documents and financial tables.
          Preserves original values, identifies separate tables and grouped
          headers, and builds token-aware chunks. Adds ingestion time; standard
          processing stays unchanged when off.
        </HelpTooltip>
      </div>
      {value.enabled && (
        <>
          <div className="setting-label-row">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={vision.enabled}
                onChange={(e) => updateVision({ enabled: e.target.checked })}
              />
              AI document extraction
            </label>
            <HelpTooltip>
              Send selected PDF pages or uploaded images to a vision-capable
              model before indexing. Preserves original languages and table
              headers. Requires Poppler for PDFs; does not require Tesseract.
              Model transcription may contain mistakes; review extraction before
              publishing.
            </HelpTooltip>
          </div>
          {vision.enabled && (
            <div>
              <label>
                Vision extraction model
                <select
                  required
                  aria-label="Vision extraction model"
                  value={vision.modelId ?? ""}
                  onChange={(e) =>
                    updateVision({ modelId: e.target.value || null })
                  }
                >
                  <option value="">
                    Select a vision-capable workspace model
                  </option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Pages to extract
                <select
                  value={vision.scope}
                  onChange={(e) =>
                    updateVision({
                      scope: e.target.value as typeof vision.scope,
                    })
                  }
                >
                  <option value="scanned">Scanned pages only</option>
                  <option value="complex">
                    Scanned pages and detected tables
                  </option>
                  <option value="all">All pages</option>
                </select>
              </label>
              <label>
                Document languages
                <input
                  maxLength={200}
                  value={vision.languages}
                  onChange={(e) => updateVision({ languages: e.target.value })}
                  placeholder="auto, or English, Burmese, Thai…"
                />
              </label>
              <div className="setting-label-row">
                <span>Original languages are preserved.</span>
                <HelpTooltip>
                  Automatic detection supports multilingual and mixed-script
                  documents according to the selected model. Language hints do
                  not translate content. Use a multilingual embedding model for
                  cross-language retrieval.
                </HelpTooltip>
              </div>
              <div className="form-grid">
                <label>
                  Maximum AI pages per document
                  <input
                    type="number"
                    required
                    min={1}
                    max={200}
                    value={vision.maxPages}
                    onChange={(e) =>
                      updateVision({ maxPages: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Extraction output tokens per page
                  <input
                    type="number"
                    required
                    min={1024}
                    max={1000000}
                    value={vision.maxOutputTokens}
                    onChange={(e) =>
                      updateVision({ maxOutputTokens: Number(e.target.value) })
                    }
                  />
                </label>
              </div>
              <div className="setting-label-row">
                <span>
                  Extraction is cached for unchanged documents and settings.
                </span>
                <HelpTooltip>
                  The page limit stops ingestion rather than silently skipping
                  pages. The output allowance is bounded by the registered model
                  limit. Incomplete or invalid structured output fails ingestion
                  so it can be retried; no partial source becomes searchable.
                </HelpTooltip>
              </div>
            </div>
          )}
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
          <div className="setting-label-row">
            <span>Measured with the o200k tokenizer.</span>
            <HelpTooltip>
              Wide table rows stay intact and may exceed this target. Review
              extraction warnings before publishing financial content.
            </HelpTooltip>
          </div>
          <div className="setting-label-row">
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
            <HelpTooltip>
              The selected model receives extracted document content during
              ingestion and chooses boundaries and header rows only. It cannot
              rewrite numeric values. Invalid output or provider failures fall
              back to deterministic processing with a warning. Limited to 12
              calls per ingestion job.
            </HelpTooltip>
          </div>
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
          <div className="setting-label-row">
            <span>
              After indexing, open Extraction preview on the source to check
              tables, headers, units and warnings.
            </span>
            <HelpTooltip>
              This is not a guarantee of financial accuracy.
            </HelpTooltip>
          </div>
        </>
      )}
      <div className="setting-label-row">
        <label className="checkbox-label">
          <input
            name="parentContext"
            type="checkbox"
            defaultChecked={parentContext}
          />
          Expand retrieved passages with parent context
        </label>
        <HelpTooltip>
          Separate retrieval setting: adds bounded surrounding text or table
          rows from advanced indexed chunks. May increase chat token usage and
          latency. Older standard chunks remain usable without expansion.
        </HelpTooltip>
      </div>
      <div className="setting-label-row">
        <span>Processing changes apply when ingestion starts.</span>
        <HelpTooltip>
          Existing content stays unchanged until you choose Reingest. Retrieval
          settings apply immediately; approved releases retain their original
          indexed context.
        </HelpTooltip>
      </div>
    </fieldset>
  );
}
