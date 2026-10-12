"use client";
import { HelpTooltip } from "./help-tooltip";
import { useState } from "react";
import { contextControls } from "@agentconnect/schemas/customer-experience";
import type { SectionProps } from "./agent-configure-sections";
import { requestJson } from "./agent-client";
import { Button } from "./button";
export function ContextControls({
  draft,
  update,
}: Pick<SectionProps, "draft" | "update">) {
  const controls = contextControls.parse(draft.config.contextControls),
    [message, setMessage] = useState(""),
    [preview, setPreview] = useState<Record<string, unknown> | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const field = <K extends keyof typeof controls>(
    key: K,
    value: (typeof controls)[K],
  ) =>
    update({
      ...draft,
      config: {
        ...draft.config,
        contextControls: { ...controls, [key]: value },
      },
    });
  return (
    <section className="configure-group">
      <h3>Token and context controls</h3>
      <p className="muted">
        Text counts use the selected tokenizer. Message framing is estimated;
        non-OpenAI providers may use a different tokenizer. Choose conservative
        counting for an upper bound.
      </p>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={controls.enabled}
          onChange={(e) => field("enabled", e.target.checked)}
        />
        Enable tokenizer-aware context budgeting
      </label>
      <label>
        Tokenizer
        <select
          value={controls.tokenizer}
          onChange={(e) =>
            field("tokenizer", e.target.value as typeof controls.tokenizer)
          }
        >
          <option value="o200k_base">OpenAI o200k_base</option>
          <option value="cl100k_base">OpenAI cl100k_base</option>
          <option value="conservative">Conservative UTF-8 upper bound</option>
        </select>
      </label>
      <div className="form-grid">
        {(
          [
            "inputBudget",
            "historyBudget",
            "knowledgeBudget",
            "summaryMaxTokens",
            "dailyTokenQuota",
          ] as const
        ).map((key) => (
          <label key={key}>
            {
              {
                inputBudget: "Input token budget",
                historyBudget: "Conversation memory budget",
                knowledgeBudget: "Knowledge passage budget",
                summaryMaxTokens: "Summary token limit",
                dailyTokenQuota:
                  "Daily tokens per customer session / workspace user",
              }[key]
            }
            <input
              type="number"
              min={
                key === "dailyTokenQuota"
                  ? 256
                  : key === "inputBudget"
                    ? 128
                    : 64
              }
              max={
                key === "summaryMaxTokens"
                  ? 2048
                  : key === "dailyTokenQuota"
                    ? 100000000
                    : 2000000
              }
              value={controls[key] ?? ""}
              onChange={(e) =>
                field(
                  key,
                  e.target.value === "" &&
                    (key === "inputBudget" || key === "dailyTokenQuota")
                    ? null
                    : Number(e.target.value),
                )
              }
            />
            {key === "dailyTokenQuota" && (
              <small>
                Blank means no quota. UTC daily quota reserves capacity before
                any model call; unused capacity returns after the run. Anonymous
                customers must start a persistent session.
              </small>
            )}
          </label>
        ))}
      </div>
      <div className="setting-label-row">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={controls.summarize}
            disabled={!controls.enabled}
            onChange={(e) => field("summarize", e.target.checked)}
          />
          Summarize older completed turns when memory exceeds its budget
        </label>
        <HelpTooltip>
          Summaries cost tokens and are treated as untrusted conversation
          memory, never as approved knowledge. Failed summarization retains
          recent turns.
        </HelpTooltip>
      </div>
      <details>
        <summary>Preview token components</summary>
        <label>
          Example user message
          <textarea
            maxLength={12000}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        <Button
          type="button"
          disabled={busy || !draft.id}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              setPreview(
                await requestJson(
                  `/agents/${draft.id}/context-preview`,
                  "POST",
                  { config: draft.config, message },
                ),
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Preview draft payload
        </Button>
        {preview && <pre>{JSON.stringify(preview, null, 2)}</pre>}
        {error && <p role="alert">{error}</p>}
        <small>
          Draft preview measures system and example input. Actual run traces
          also record history, retrieved passages, tool context and summaries.
        </small>
      </details>
    </section>
  );
}
