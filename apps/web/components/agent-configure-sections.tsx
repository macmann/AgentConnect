"use client";
import { BankExperienceEditor } from "./bank-experience-editor";
import { AgentKnowledgeRelease } from "./agent-knowledge-releases";
import { useState, type MutableRefObject } from "react";
import { renderPrompt } from "@agentconnect/schemas/agent-prompt";
import { blockNames } from "@agentconnect/schemas/generative";
import type { Config, Draft, Model, Prompt } from "./agent-studio";
import type {
  ConfigureIssue,
  ConfigureSection,
  KnowledgeOption,
  ToolOption,
} from "./agent-configure-state";
import {
  ConfigureField as Field,
  ConfigureGroup as Group,
} from "./agent-configure-fields";
import { AgentAttachments } from "./agent-attachments";
import { Button } from "./button";
export type SectionProps = {
  draft: Draft;
  update: (draft: Draft) => void;
  models: Model[];
  modelsLoading?: boolean;
  modelsError?: Error | null;
  retryModels?: () => void;
  issues: ConfigureIssue[];
  navigate: (section: ConfigureSection) => void;
  knowledge: KnowledgeOption[];
  tools: ToolOption[];
  knowledgeLoading: boolean;
  toolsLoading: boolean;
  knowledgeError: Error | null;
  toolsError: Error | null;
  retryKnowledge: () => void;
  retryTools: () => void;
  manage: (kind: "Knowledge" | "Tools" | "Models") => void;
  canManage: boolean;
  rawPrompt: MutableRefObject<string>;
};
function config<K extends keyof Config>(
  p: SectionProps,
  key: K,
  value: Config[K],
) {
  if (key === "rag") {
    const rag = value as Config["rag"];
    value = {
      ...rag,
      releasePins: Object.fromEntries(
        Object.entries(rag.releasePins ?? {}).filter(([id]) =>
          rag.knowledgeBaseIds.includes(id),
        ),
      ),
    } as Config[K];
  }
  p.update({ ...p.draft, config: { ...p.draft.config, [key]: value } });
}
function scalar(
  p: SectionProps,
  key: "language" | "timezone",
  label: string,
  max: number,
) {
  return (
    <Field field={`config.${key}`} label={label} issues={p.issues}>
      {(a) => (
        <input
          {...a}
          maxLength={max}
          value={p.draft.config[key]}
          onChange={(e) => config(p, key, e.target.value)}
        />
      )}
    </Field>
  );
}
export function OverviewSection(p: SectionProps) {
  const d = p.draft,
    c = d.config,
    model = p.models.find((m) => m.id === c.modelId);
  return (
    <>
      <div className="configure-summary-grid">
        {(
          [
            [
              "Knowledge",
              `${c.rag.knowledgeBaseIds.length} knowledge base${c.rag.knowledgeBaseIds.length === 1 ? "" : "s"} attached`,
              `${c.rag.mode === "hybrid" ? "Hybrid vector + text" : "Vector retrieval"} · Citations ${c.rag.requireCitations ? "enabled" : "optional"}`,
              "knowledge",
            ],
            [
              "Tools",
              `${c.tools.toolIds.length} tool${c.tools.toolIds.length === 1 ? "" : "s"} attached`,
              `Up to ${c.tools.maxCalls} calls per response`,
              "tools",
            ],
            [
              "Experience",
              c.language,
              c.welcomeMessage.trim()
                ? "Welcome message configured"
                : "No welcome message",
              "experience",
            ],
            [
              "Model",
              model?.name ?? "No available model",
              model?.provider ?? "Choose a workspace model",
              "overview",
            ],
          ] as const
        ).map(([title, value, detail, section]) => (
          <section className="configure-summary-card" key={title}>
            <h4>{title}</h4>
            <strong>{value}</strong>
            <p>{detail}</p>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                p.navigate(section);
                if (section === "overview")
                  requestAnimationFrame(() =>
                    document.getElementById("agent-config-modelId")?.focus(),
                  );
              }}
            >
              {title === "Model"
                ? "Change model"
                : `Configure ${title.toLowerCase()}`}
            </button>
          </section>
        ))}
      </div>
      <Group title="Identity">
        {(["name", "description", "publicDescription"] as const).map((key) => (
          <Field
            key={key}
            field={key}
            label={
              {
                name: "Agent name",
                description: "Internal description",
                publicDescription: "Public description",
              }[key]
            }
            issues={p.issues}
            help={
              key === "description"
                ? "For your team. Hidden from customers."
                : key === "publicDescription"
                  ? "Describes the agent on its published page."
                  : undefined
            }
          >
            {(a) =>
              key === "name" ? (
                <input
                  {...a}
                  maxLength={100}
                  value={d[key]}
                  onChange={(e) => p.update({ ...d, [key]: e.target.value })}
                />
              ) : (
                <textarea
                  {...a}
                  rows={2}
                  maxLength={2000}
                  value={d[key]}
                  onChange={(e) => p.update({ ...d, [key]: e.target.value })}
                />
              )
            }
          </Field>
        ))}
      </Group>
      <Group title="AI model">
        {p.modelsLoading && <p role="status">Loading workspace models…</p>}
        {p.modelsError && (
          <p className="error" role="alert">
            Could not load models. {p.modelsError.message}{" "}
            <Button type="button" className="secondary" onClick={p.retryModels}>
              Retry models
            </Button>
          </p>
        )}
        <div className="configure-model-row">
          <Field field="config.modelId" label="Model" issues={p.issues}>
            {(a) => (
              <select
                {...a}
                disabled={p.modelsLoading}
                value={c.modelId}
                onChange={(e) => config(p, "modelId", e.target.value)}
              >
                <option value="">Select a model</option>
                {!model && c.modelId && (
                  <option value={c.modelId}>
                    {p.modelsLoading
                      ? "Loading selected model…"
                      : "Unavailable model"}
                  </option>
                )}
                {p.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Button
            type="button"
            className="secondary"
            onClick={() => p.manage("Models")}
          >
            Manage models
          </Button>
        </div>
        {model && (
          <p className="muted">
            {model.provider} · {model.model_id} ·{" "}
            {model.context_window.toLocaleString()} context tokens
          </p>
        )}
      </Group>
      <Group title="Classification">
        <Field field="config.category" label="Category" issues={p.issues}>
          {(a) => (
            <select
              {...a}
              value={c.category}
              onChange={(e) =>
                config(p, "category", e.target.value as Config["category"])
              }
            >
              <option value="hybrid">Hybrid</option>
              <option value="structured">Structured</option>
              <option value="unstructured">Unstructured</option>
            </select>
          )}
        </Field>
      </Group>
      <Group title="Locale">
        <div className="configure-short-grid">
          {scalar(p, "language", "Language", 50)}
          {scalar(p, "timezone", "Timezone", 100)}
        </div>
      </Group>
    </>
  );
}
const promptLabels: Record<Exclude<keyof Prompt, "advanced">, string> = {
  role: "Role",
  objective: "Objective",
  instructions: "Instructions",
  constraints: "Constraints",
  tone: "Tone",
  outputFormat: "Output format",
  escalationPolicy: "Escalation instructions",
};
export function PromptSection(p: SectionProps) {
  const c = p.draft.config,
    raw = p.rawPrompt;
  const [structured, setStructured] = useState(false);
  return (
    <>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={c.prompt.advanced !== null}
          onChange={(e) => {
            if (c.prompt.advanced !== null) raw.current = c.prompt.advanced;
            config(p, "prompt", {
              ...c.prompt,
              advanced: e.target.checked ? raw.current : null,
            });
          }}
        />
        Advanced prompt mode
      </label>
      {c.prompt.advanced !== null && (
        <>
          <p className="notice">
            The raw system prompt overrides structured fields at runtime.
            Structured values are retained.
          </p>
          <Field
            field="config.prompt.advanced"
            label="System prompt"
            issues={p.issues}
          >
            {(a) => (
              <textarea
                {...a}
                rows={12}
                maxLength={24000}
                value={c.prompt.advanced!}
                onChange={(e) => {
                  raw.current = e.target.value;
                  config(p, "prompt", {
                    ...c.prompt,
                    advanced: e.target.value,
                  });
                }}
              />
            )}
          </Field>
          <Button
            type="button"
            className="secondary"
            onClick={() => setStructured(!structured)}
          >
            {structured ? "Hide" : "Show"} retained structured fields
          </Button>
        </>
      )}
      {(c.prompt.advanced === null || structured) && (
        <Group title="Structured instructions">
          {(
            Object.keys(promptLabels) as Exclude<keyof Prompt, "advanced">[]
          ).map((key) => (
            <Field
              key={key}
              field={`config.prompt.${key}`}
              label={promptLabels[key]}
              issues={p.issues}
              help={
                key === "escalationPolicy"
                  ? "Prompt guidance only. Human handoff rules are configured in Human Support → Handoff policy."
                  : key === "instructions"
                    ? "Describe what the agent should do and how it should respond."
                    : undefined
              }
            >
              {(a) => (
                <textarea
                  {...a}
                  rows={key === "instructions" ? 6 : 3}
                  maxLength={
                    key === "instructions"
                      ? 12000
                      : key === "tone"
                        ? 1000
                        : ["outputFormat", "escalationPolicy"].includes(key)
                          ? 2000
                          : 4000
                  }
                  value={c.prompt[key]}
                  onChange={(e) =>
                    config(p, "prompt", { ...c.prompt, [key]: e.target.value })
                  }
                />
              )}
            </Field>
          ))}
        </Group>
      )}
      <PromptPreview draft={p.draft} />
    </>
  );
}
export function PromptPreview({ draft }: { draft: Draft }) {
  return (
    <details className="configure-details">
      <summary>Preview compiled prompt</summary>
      <p className="muted">
        Agent instructions and response language only. Runtime grounding and
        internal safeguards are added separately.
      </p>
      <pre className="configure-prompt-preview">
        {renderPrompt(draft.config)}
      </pre>
    </details>
  );
}
function UsagePolicy(p: SectionProps & { kind: "rag" | "tools" }) {
  const policy = p.draft.config[p.kind];
  const mode = policy.usageMode ?? (p.kind === "rag" ? "always" : "automatic");
  return (
    <Group title={p.kind === "rag" ? "Knowledge usage" : "Tool usage"}>
      <Field
        field={`config.${p.kind}.usageMode`}
        label="Usage policy"
        issues={p.issues}
      >
        {(a) => (
          <select
            {...a}
            value={mode}
            onChange={(e) =>
              config(p, p.kind, {
                ...policy,
                usageMode: e.target.value as
                  "automatic" | "always" | "disabled",
              })
            }
          >
            <option value="automatic">Automatic — only when relevant</option>
            <option value="always">Always — required for every message</option>
            <option value="disabled">
              Disabled — keep attachments without using them
            </option>
          </select>
        )}
      </Field>
      <Field
        field={`config.${p.kind}.usageInstructions`}
        label="Usage instructions"
        issues={p.issues}
        help="Describe when to use and when to skip. Automatic selection follows these instructions; Always requires usage and Disabled skips it. Instructions guide model decisions and do not override access permissions."
      >
        {(a) => (
          <textarea
            {...a}
            maxLength={4000}
            rows={4}
            value={policy.usageInstructions ?? ""}
            placeholder={
              p.kind === "rag"
                ? "Search for product policies. Skip greetings and general conversation."
                : "Use search for current information. Skip greetings and questions answerable directly."
            }
            onChange={(e) =>
              config(p, p.kind, {
                ...policy,
                usageInstructions: e.target.value,
              })
            }
          />
        )}
      </Field>
      <p className="muted">
        {mode === "disabled"
          ? "Attachments remain configured. No retrieval or tool planning runs."
          : p.kind === "rag"
            ? "Automatic adds a model decision before retrieval. Required retrieval still fails if no relevant sources are found."
            : "The planner chooses relevant read-only tools. Always requires at least one call; it does not call every attached tool."}
      </p>
    </Group>
  );
}
export function KnowledgeSection(p: SectionProps) {
  const c = p.draft.config;
  return (
    <>
      <Group title="Approved knowledge and answer policy">
        <label>
          Answer policy
          <select
            aria-label="Answer policy"
            value={p.draft.config.answerPolicy?.mode ?? "standard"}
            onChange={(e) => {
              const grounded = e.target.value === "grounded";
              const c = p.draft.config;
              p.update({
                ...p.draft,
                config: {
                  ...c,
                  answerPolicy: {
                    mode: grounded ? "grounded" : "standard",
                    noAnswerResponse:
                      c.answerPolicy?.noAnswerResponse ??
                      "I couldn't find approved guidance. Please clarify or connect with customer care.",
                    offerHumanOnNoAnswer:
                      c.answerPolicy?.offerHumanOnNoAnswer ?? true,
                  },
                  rag: {
                    ...c.rag,
                    ...(grounded
                      ? {
                          contentMode: "approved" as const,
                          usageMode: "always" as const,
                          requireCitations: true,
                        }
                      : {}),
                  },
                  ...(grounded
                    ? {
                        generative: {
                          enabled: false,
                          allowedBlocks: c.generative?.allowedBlocks ?? [
                            ...blockNames,
                          ],
                          allowPublicForms:
                            c.generative?.allowPublicForms ?? false,
                        },
                      }
                    : {}),
                },
              });
            }}
          >
            <option value="standard">Standard — existing model behavior</option>
            <option value="grounded">
              Approved knowledge only — answer, clarify or escalate
            </option>
          </select>
        </label>
        <p className="muted">
          Grounded mode retrieves published knowledge and validates a complete
          text response before showing it. It does not use tools or rich
          components for factual answers. Citations do not independently prove
          every claim.
        </p>
        <label>
          Knowledge content
          <select
            aria-label="Knowledge content"
            value={p.draft.config.rag.contentMode ?? "current"}
            onChange={(e) =>
              config(p, "rag", {
                ...p.draft.config.rag,
                contentMode: e.target.value as "current" | "approved",
              })
            }
          >
            <option value="current">
              Current sources (approval still enforced by governed bases)
            </option>
            <option value="approved">Published reviewed releases only</option>
          </select>
        </label>
        {p.draft.config.rag.knowledgeBaseIds.map((id) => (
          <AgentKnowledgeRelease
            key={id}
            baseId={id}
            name={
              p.knowledge.find((k) => k.id === id)?.name ?? "Knowledge base"
            }
            value={p.draft.config.rag.releasePins?.[id]}
            onChange={(value) => {
              const pins = { ...p.draft.config.rag.releasePins };
              if (value) pins[id] = value;
              else delete pins[id];
              config(p, "rag", { ...p.draft.config.rag, releasePins: pins });
            }}
          />
        ))}
        {p.draft.config.answerPolicy?.mode === "grounded" && (
          <>
            <label>
              No-answer response
              <textarea
                value={p.draft.config.answerPolicy.noAnswerResponse}
                maxLength={1000}
                onChange={(e) =>
                  config(p, "answerPolicy", {
                    ...p.draft.config.answerPolicy!,
                    noAnswerResponse: e.target.value,
                  })
                }
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={p.draft.config.answerPolicy.offerHumanOnNoAnswer}
                onChange={(e) =>
                  config(p, "answerPolicy", {
                    ...p.draft.config.answerPolicy!,
                    offerHumanOnNoAnswer: e.target.checked,
                  })
                }
              />
              Offer customer care when approved knowledge cannot answer
            </label>
            <p className="muted">
              Offers respect the current human-support policy and require
              customer confirmation.
            </p>
          </>
        )}
      </Group>

      <AgentAttachments
        kind="knowledge"
        items={p.knowledge}
        selected={c.rag.knowledgeBaseIds}
        loading={p.knowledgeLoading}
        error={p.knowledgeError}
        onRetry={p.retryKnowledge}
        onNavigate={() => p.manage("Knowledge")}
        canManage={p.canManage}
        onToggle={(id, checked) =>
          config(p, "rag", {
            ...c.rag,
            knowledgeBaseIds: checked
              ? [...c.rag.knowledgeBaseIds, id]
              : c.rag.knowledgeBaseIds.filter((v) => v !== id),
          })
        }
      />
      <UsagePolicy {...p} kind="rag" />
      <Group title="Retrieval">
        <Field field="config.rag.mode" label="Retrieval mode" issues={p.issues}>
          {(a) => (
            <select
              {...a}
              value={c.rag.mode}
              onChange={(e) =>
                config(p, "rag", {
                  ...c.rag,
                  mode: e.target.value as "vector" | "hybrid",
                })
              }
            >
              <option value="hybrid">Hybrid vector + text</option>
              <option value="vector">Vector similarity</option>
            </select>
          )}
        </Field>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={c.rag.requireCitations}
            onChange={(e) =>
              config(p, "rag", { ...c.rag, requireCitations: e.target.checked })
            }
          />
          Require citations
        </label>
      </Group>
      <details
        className="configure-details"
        open={p.issues.some((i) => /topK|minScore/.test(i.field)) || undefined}
      >
        <summary>Advanced retrieval settings</summary>
        <div className="configure-short-grid">
          {(["topK", "minScore"] as const).map((key) => (
            <Field
              field={`config.rag.${key}`}
              key={key}
              label={
                key === "topK" ? "Retrieved passages" : "Minimum relevance"
              }
              help={
                key === "minScore"
                  ? "Ignore retrieved passages below this similarity threshold."
                  : "Maximum passages included in retrieval context."
              }
              issues={p.issues}
            >
              {(a) => (
                <input
                  {...a}
                  type="number"
                  min={key === "topK" ? 1 : 0}
                  max={key === "topK" ? 10 : 1}
                  step={key === "topK" ? 1 : 0.01}
                  value={Number.isNaN(c.rag[key]) ? "" : c.rag[key]}
                  onChange={(e) =>
                    config(p, "rag", {
                      ...c.rag,
                      [key]:
                        e.target.value === "" ? NaN : Number(e.target.value),
                    })
                  }
                />
              )}
            </Field>
          ))}
        </div>
      </details>
    </>
  );
}
export function ToolsSection(p: SectionProps) {
  const c = p.draft.config;
  return (
    <>
      <AgentAttachments
        kind="tools"
        items={p.tools}
        selected={c.tools.toolIds}
        loading={p.toolsLoading}
        error={p.toolsError}
        onRetry={p.retryTools}
        onNavigate={() => p.manage("Tools")}
        canManage={p.canManage}
        onToggle={(id, checked) =>
          config(p, "tools", {
            ...c.tools,
            toolIds: checked
              ? [...c.tools.toolIds, id]
              : c.tools.toolIds.filter((v) => v !== id),
          })
        }
      />
      <UsagePolicy {...p} kind="tools" />
      <details
        className="configure-details"
        open={
          p.issues.some((i) => i.field === "config.tools.maxCalls") || undefined
        }
      >
        <summary>Advanced tool settings</summary>
        <Field
          field="config.tools.maxCalls"
          label="Maximum tool calls per response"
          issues={p.issues}
        >
          {(a) => (
            <input
              {...a}
              type="number"
              min={1}
              max={5}
              value={Number.isNaN(c.tools.maxCalls) ? "" : c.tools.maxCalls}
              onChange={(e) =>
                config(p, "tools", {
                  ...c.tools,
                  maxCalls:
                    e.target.value === "" ? NaN : Number(e.target.value),
                })
              }
            />
          )}
        </Field>
      </details>
    </>
  );
}
export function BehaviorSection(p: SectionProps) {
  const c = p.draft.config,
    m = p.models.find((m) => m.id === c.modelId),
    presets = [
      { name: "Precise", value: 0.2 },
      { name: "Balanced", value: 0.5 },
      { name: "Creative", value: 0.8 },
    ],
    custom = !presets.some((v) => v.value === c.temperature) || c.topP !== null;
  return (
    <>
      <Group title="Response creativity">
        <p className="muted">
          Choose a starting point. Exact advanced values are preserved until you
          change them.
        </p>
        {m && !m.capabilities.temperature ? (
          <p className="notice">
            This model does not support temperature. The configured value is
            retained but is not sent to the provider.
          </p>
        ) : null}
        <div className="configure-presets">
          {presets.map((v) => (
            <button
              type="button"
              key={v.name}
              aria-pressed={c.temperature === v.value}
              disabled={m?.capabilities.temperature === false}
              onClick={() => config(p, "temperature", v.value)}
            >
              {v.name}
            </button>
          ))}
        </div>
        <p className="muted">
          {custom
            ? "Advanced customization active"
            : "Creativity preset active"}{" "}
          · Temperature {String(c.temperature)}
          {c.topP !== null ? ` · Top-P ${c.topP}` : ""}
        </p>
      </Group>
      <Group title="Conversation memory">
        <Field
          field="config.historyWindow"
          label="Conversation memory (turns)"
          help="Number of recent conversation turns provided to the model."
          issues={p.issues}
        >
          {(a) => (
            <input
              {...a}
              type="number"
              min={1}
              max={50}
              value={Number.isNaN(c.historyWindow) ? "" : c.historyWindow}
              onChange={(e) =>
                config(
                  p,
                  "historyWindow",
                  e.target.value === "" ? NaN : Number(e.target.value),
                )
              }
            />
          )}
        </Field>
      </Group>
      <details
        className="configure-details"
        open={
          p.issues.some((i) =>
            /temperature|topP|maxOutputTokens/.test(i.field),
          ) || undefined
        }
      >
        <summary>Advanced model settings</summary>
        <div className="configure-short-grid">
          <Field
            field="config.temperature"
            label="Temperature"
            help={
              m?.capabilities.temperature === false
                ? "Unsupported by this model; retained, not sent."
                : "Exact creativity value from 0 to 1."
            }
            issues={p.issues}
          >
            {(a) => (
              <input
                {...a}
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={Number.isNaN(c.temperature) ? "" : c.temperature}
                onChange={(e) =>
                  config(
                    p,
                    "temperature",
                    e.target.value === "" ? NaN : Number(e.target.value),
                  )
                }
              />
            )}
          </Field>
          <Field
            field="config.topP"
            label="Top-P (optional)"
            help={
              m?.capabilities.topP === false
                ? "Unsupported by this model; retained, not sent."
                : "Leave empty to use the provider default. Valid values are greater than 0 and at most 1."
            }
            issues={p.issues}
          >
            {(a) => (
              <input
                {...a}
                type="number"
                min={0.01}
                max={1}
                step={0.01}
                value={c.topP ?? ""}
                onChange={(e) =>
                  config(
                    p,
                    "topP",
                    e.target.value === "" ? null : Number(e.target.value),
                  )
                }
              />
            )}
          </Field>
          <Field
            field="config.maxOutputTokens"
            label="Maximum output tokens"
            help="Larger responses may increase latency and model cost. The model’s output and context limits apply."
            issues={p.issues}
          >
            {(a) => (
              <input
                {...a}
                type="number"
                min={1}
                max={
                  m
                    ? Math.min(m.max_output_tokens, m.context_window - 1)
                    : 2000000
                }
                value={Number.isNaN(c.maxOutputTokens) ? "" : c.maxOutputTokens}
                onChange={(e) =>
                  config(
                    p,
                    "maxOutputTokens",
                    e.target.value === "" ? NaN : Number(e.target.value),
                  )
                }
              />
            )}
          </Field>
        </div>
      </details>
    </>
  );
}
export function ExperienceSection(p: SectionProps) {
  const c = p.draft.config;
  return (
    <>
      <Group title="Customer messages">
        {(["welcomeMessage", "fallbackResponse"] as const).map((key) => (
          <Field
            key={key}
            field={`config.${key}`}
            label={
              key === "welcomeMessage" ? "Welcome message" : "Fallback response"
            }
            help={
              key === "fallbackResponse"
                ? "Shown when the configured model or runtime is unavailable. This is separate from retrieval relevance settings."
                : "The opening message shown to customers."
            }
            issues={p.issues}
          >
            {(a) => (
              <textarea
                {...a}
                rows={3}
                maxLength={2000}
                value={c[key]}
                onChange={(e) => config(p, key, e.target.value)}
              />
            )}
          </Field>
        ))}
        <div
          className="configure-welcome-preview"
          aria-label="Welcome message preview"
        >
          <small>Welcome preview</small>
          <p>{c.welcomeMessage || "No welcome message configured."}</p>
        </div>
      </Group>
      <BankExperienceEditor
        actions={c.quickActions ?? []}
        journeys={c.journeys ?? []}
        onChange={(quickActions, journeys) =>
          p.update({ ...p.draft, config: { ...c, quickActions, journeys } })
        }
      />
      <Group title="Conversation starters">
        <p className="muted">
          Suggested messages customers can send to start a conversation. Up to
          twenty starters.
        </p>
        {!c.conversationStarters.length && (
          <p>No conversation starters configured.</p>
        )}
        <ol className="configure-starters">
          {c.conversationStarters.map((value, i) => (
            <li key={i}>
              <Field
                field={`config.conversationStarters.${i}`}
                label={`Starter ${i + 1}`}
                issues={p.issues}
              >
                {(a) => (
                  <input
                    {...a}
                    maxLength={300}
                    value={value}
                    onChange={(e) =>
                      config(
                        p,
                        "conversationStarters",
                        c.conversationStarters.map((v, j) =>
                          j === i ? e.target.value : v,
                        ),
                      )
                    }
                  />
                )}
              </Field>
              <button
                type="button"
                className="text-button"
                aria-label={`Remove starter ${i + 1}`}
                onClick={() =>
                  config(
                    p,
                    "conversationStarters",
                    c.conversationStarters.filter((_, j) => j !== i),
                  )
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ol>
        <Button
          type="button"
          className="secondary"
          disabled={c.conversationStarters.length >= 20}
          onClick={() =>
            config(p, "conversationStarters", [...c.conversationStarters, ""])
          }
        >
          + Add starter
        </Button>
      </Group>
      <Group title="Rich responses">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={c.generative?.enabled ?? false}
            onChange={(e) =>
              config(p, "generative", {
                enabled: e.target.checked,
                allowedBlocks: c.generative?.allowedBlocks ?? [...blockNames],
                allowPublicForms: c.generative?.allowPublicForms ?? false,
              })
            }
          />
          Enable rich response components
        </label>
        <p className="muted">
          Allows supported charts, forms, tables and downloadable files.
          Submissions require confirmation.
        </p>
        {c.generative?.enabled && (
          <>
            <fieldset>
              <legend>Allowed response components</legend>
              <div className="capabilities">
                {blockNames.map((name) => (
                  <label className="checkbox-label" key={name}>
                    <input
                      type="checkbox"
                      checked={c.generative!.allowedBlocks.includes(name)}
                      disabled={
                        c.generative!.allowedBlocks.length === 1 &&
                        c.generative!.allowedBlocks.includes(name)
                      }
                      onChange={(e) =>
                        config(p, "generative", {
                          ...c.generative!,
                          allowedBlocks: e.target.checked
                            ? [...c.generative!.allowedBlocks, name]
                            : c.generative!.allowedBlocks.filter(
                                (v) => v !== name,
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
                checked={c.generative.allowPublicForms}
                onChange={(e) =>
                  config(p, "generative", {
                    ...c.generative!,
                    allowPublicForms: e.target.checked,
                  })
                }
              />
              Allow confirmed form/action submissions in public chat
            </label>
            <p className="muted">
              Public collection is off by default. Publish a new version after
              changing this setting.
            </p>
          </>
        )}
      </Group>
    </>
  );
}
export function AdvancedSection(p: SectionProps) {
  const m = p.models.find((m) => m.id === p.draft.config.modelId);
  return (
    <>
      <Group title="Technical settings">
        <p className="muted">
          Advanced controls stay with the settings they affect.
        </p>
        <div className="configure-advanced-links">
          {(
            [
              ["behavior", "Sampling & token limits"],
              ["knowledge", "Retrieval tuning"],
              ["tools", "Tool call limits"],
              ["prompt", "Raw prompt mode"],
            ] as const
          ).map(([section, label]) => (
            <Button
              type="button"
              className="secondary"
              key={section}
              onClick={() => p.navigate(section)}
            >
              {label}
            </Button>
          ))}
        </div>
      </Group>
      <PromptPreview draft={p.draft} />
      <Group title="Draft metadata">
        <dl className="configure-metadata">
          <dt>Draft revision</dt>
          <dd>{p.draft.revision}</dd>
          <dt>Schema version</dt>
          <dd>{p.draft.config.schemaVersion}</dd>
          <dt>Context window</dt>
          <dd>
            {m
              ? `${m.context_window.toLocaleString()} tokens`
              : "Model unavailable"}
          </dd>
          <dt>Model output limit</dt>
          <dd>
            {m
              ? `${m.max_output_tokens.toLocaleString()} tokens`
              : "Model unavailable"}
          </dd>
        </dl>
      </Group>
    </>
  );
}
