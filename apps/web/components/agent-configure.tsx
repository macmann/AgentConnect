"use client";
import { useRef, useState } from "react";
import { Button } from "./button";
import {
  agentReadiness,
  configureIssues,
  configureSections,
  type ConfigureSection,
  type ReadinessItem,
} from "./agent-configure-state";
import {
  OverviewSection,
  PromptSection,
  KnowledgeSection,
  ToolsSection,
  BehaviorSection,
  ExperienceSection,
  AdvancedSection,
  type SectionProps,
} from "./agent-configure-sections";
const titles: Record<ConfigureSection, string> = {
  overview: "Overview",
  prompt: "Prompt",
  knowledge: "Knowledge",
  tools: "Tools",
  behavior: "Behavior",
  experience: "Experience",
  advanced: "Advanced",
};
const descriptions: Record<ConfigureSection, string> = {
  overview:
    "The essentials: who this agent is, which model it uses and what is attached.",
  prompt: "Define the agent’s role, instructions and response style.",
  knowledge: "Ground responses in approved workspace content.",
  tools: "Choose the external information this agent can access.",
  behavior: "Set response creativity and conversation memory.",
  experience: "Shape the messages and components customers see.",
  advanced: "Inspect the compiled prompt and find technical settings.",
};
export function AgentReadiness({
  items,
  navigate,
}: {
  items: ReadinessItem[];
  navigate?: (section: ConfigureSection) => void;
}) {
  const ready = items.every(
    (i) => i.state === "ready" || i.state === "optional",
  );
  return (
    <section className="configure-readiness" aria-label="Agent readiness">
      <div className="configure-readiness-heading">
        <h4>Agent readiness</h4>
        <strong>
          {ready
            ? "Ready to test"
            : items.some((i) => i.state === "loading")
              ? "Checking configuration"
              : "Needs configuration"}
        </strong>
      </div>
      <details open={!ready}>
        <summary>View configuration checks</summary>
        <ul>
          {items.map((item) => (
            <li key={item.label}>
              <span aria-hidden="true">
                {item.state === "ready"
                  ? "✓"
                  : item.state === "warning"
                    ? "!"
                    : item.state === "loading"
                      ? "…"
                      : "○"}
              </span>
              {navigate ? (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => navigate(item.section)}
                >
                  {item.label}
                </button>
              ) : (
                <strong>{item.label}</strong>
              )}
              <span>{item.detail}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
export function AgentConfigure({
  draft,
  update,
  section,
  navigate,
  busy,
  conflict,
  canBuild,
  dirty,
  savedDraft,
  onSave,
  onDiscard,
  onArchive,
  ...options
}: Omit<SectionProps, "issues" | "navigate" | "rawPrompt"> & {
  section: ConfigureSection;
  navigate: (section: ConfigureSection) => void;
  busy: boolean;
  conflict: boolean;
  canBuild: boolean;
  dirty: boolean;
  savedDraft: string;
  onSave: (test: boolean) => Promise<boolean>;
  onDiscard: () => void;
  onArchive: () => void;
}) {
  const [validated, setValidated] = useState(false),
    heading = useRef<HTMLHeadingElement>(null),
    rawPrompt = useRef(draft.config.prompt.advanced ?? "");
  const issues = configureIssues(
      draft,
      options.modelsLoading || options.modelsError ? undefined : options.models,
    ),
    shown = validated ? issues : [];
  const readiness = agentReadiness(
    draft,
    options.modelsLoading || options.modelsError ? undefined : options.models,
    options.knowledgeLoading || options.knowledgeError
      ? undefined
      : options.knowledge,
    options.toolsLoading || options.toolsError ? undefined : options.tools,
  );
  function go(next: ConfigureSection) {
    navigate(next);
    requestAnimationFrame(() => heading.current?.focus());
  }
  async function save(test: boolean) {
    setValidated(true);
    if (issues.length) {
      go(issues[0]!.section);
      return;
    }
    await onSave(test);
  }
  const p: SectionProps = {
    draft,
    update,
    navigate: go,
    issues: shown,
    rawPrompt,
    ...options,
  };
  const Component = {
    overview: OverviewSection,
    prompt: PromptSection,
    knowledge: KnowledgeSection,
    tools: ToolsSection,
    behavior: BehaviorSection,
    experience: ExperienceSection,
    advanced: AdvancedSection,
  }[section];
  return (
    <form
      className="agent-configure"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
    >
      <div className="configure-layout">
        <nav className="configure-sidebar" aria-label="Configure sections">
          {configureSections.map((s) => (
            <button
              type="button"
              aria-label={titles[s]}
              aria-describedby={
                validated && issues.some((i) => i.section === s)
                  ? `configure-warning-${s}`
                  : undefined
              }
              aria-current={section === s ? "page" : undefined}
              className={section === s ? "active" : ""}
              key={s}
              onClick={() => go(s)}
            >
              {titles[s]}
              {validated && issues.some((i) => i.section === s) && (
                <span
                  id={`configure-warning-${s}`}
                  aria-label="Needs attention"
                >
                  !
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="configure-mobile-navigation">
          <label htmlFor="configure-section">Configure section</label>
          <select
            id="configure-section"
            value={section}
            onChange={(e) => go(e.target.value as ConfigureSection)}
          >
            {configureSections.map((s) => (
              <option value={s} key={s}>
                {titles[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="configure-main">
          <header className="configure-section-header">
            <h3 ref={heading} tabIndex={-1}>
              {titles[section]}
            </h3>
            <p>{descriptions[section]}</p>
          </header>
          {validated && issues.length > 0 && (
            <section
              className="configure-error-summary"
              role="alert"
              aria-label="Unable to save agent"
            >
              <h4>Unable to save agent</h4>
              <p>{issues.length} settings require attention:</p>
              <ul>
                {issues.map((i) => (
                  <li key={i.field}>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => {
                        go(i.section);
                        setTimeout(
                          () =>
                            document
                              .getElementById(
                                `agent-${i.field.replaceAll(".", "-")}`,
                              )
                              ?.focus(),
                          0,
                        );
                      }}
                    >
                      {i.label}: {i.message}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {section === "overview" && (
            <AgentReadiness items={readiness} navigate={go} />
          )}
          <fieldset
            disabled={!canBuild || busy}
            className="configure-fields"
            onBlurCapture={() => setValidated(true)}
          >
            <Component {...p} />
            {section === "advanced" && draft.id && canBuild && (
              <section className="configure-group">
                <h4>Archive agent</h4>
                <p className="muted">
                  Disable deployments and remove this agent from the active
                  list. Existing run history is retained.
                </p>
                <button
                  type="button"
                  className="text-button danger"
                  onClick={onArchive}
                >
                  Archive agent
                </button>
              </section>
            )}
          </fieldset>
        </div>
      </div>
      {canBuild && (
        <footer className="configure-save-bar">
          <div role="status">
            <strong>
              {conflict
                ? "Reload required"
                : busy
                  ? "Saving…"
                  : dirty
                    ? "Unsaved changes"
                    : draft.id
                      ? "Saved"
                      : "New agent"}
            </strong>
            <small>
              Draft revision {draft.revision}
              {savedDraft ? " · One save for all sections" : ""}
            </small>
          </div>
          <div className="configure-save-actions">
            <Button
              type="button"
              className="secondary"
              disabled={busy || !dirty}
              onClick={() => {
                if (
                  window.confirm(
                    "Discard unsaved changes across all Configure sections?",
                  )
                ) {
                  onDiscard();
                  setValidated(false);
                }
              }}
            >
              Discard
            </Button>
            <Button
              type="submit"
              disabled={
                busy ||
                conflict ||
                options.modelsLoading ||
                !!options.modelsError ||
                (!dirty && !!draft.id)
              }
            >
              {busy ? "Saving…" : "Save changes"}
            </Button>
            <Button
              type="button"
              className="secondary"
              disabled={
                busy ||
                conflict ||
                options.modelsLoading ||
                !!options.modelsError
              }
              onClick={() => void save(true)}
            >
              Save and test in Playground
            </Button>
          </div>
        </footer>
      )}
    </form>
  );
}
