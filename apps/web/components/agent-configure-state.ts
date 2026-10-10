import { agentInput } from "@agentconnect/schemas/agents";
import type { Draft, Model } from "./agent-studio";
export const configureSections = [
  "overview",
  "prompt",
  "knowledge",
  "tools",
  "behavior",
  "experience",
  "advanced",
] as const;
export type ConfigureSection = (typeof configureSections)[number];
export type StudioStage = "configure" | "playground" | "publish";
export type KnowledgeOption = {
  id: string;
  name: string;
  public_access: boolean;
  source_count: number;
  ready_count: number;
  failed_count?: number;
  indexing_count?: number;
};
export type ToolOption = {
  id: string;
  name: string;
  enabled: boolean;
  public_access: boolean;
  type?: string;
  kind?: string;
};
export type ConfigureIssue = {
  field: string;
  label: string;
  section: ConfigureSection;
  message: string;
};
const labels: Record<string, string> = {
  name: "Agent name",
  description: "Internal description",
  publicDescription: "Public description",
  modelId: "Model",
  maxOutputTokens: "Maximum output tokens",
  temperature: "Temperature",
  topP: "Top-P",
  historyWindow: "Conversation memory",
  topK: "Retrieved passages",
  minScore: "Minimum relevance",
  maxCalls: "Maximum tool calls",
  knowledgeBaseIds: "Attached knowledge",
  toolIds: "Attached tools",
  conversationStarters: "Conversation starters",
};
export function fieldSection(field: string): ConfigureSection {
  if (field.startsWith("config.prompt")) return "prompt";
  if (field.startsWith("config.rag")) return "knowledge";
  if (field.startsWith("config.tools")) return "tools";
  if (
    /generative|welcomeMessage|fallbackResponse|conversationStarters/.test(
      field,
    )
  )
    return "experience";
  if (/temperature|topP|maxOutputTokens|historyWindow/.test(field))
    return "behavior";
  return "overview";
}
export function configureIssues(
  draft: Draft,
  models?: Model[],
): ConfigureIssue[] {
  const parsed = agentInput.safeParse(draft);
  const issues: ConfigureIssue[] = parsed.success
    ? []
    : parsed.error.issues.map((i) => {
        const field = i.path.join("."),
          key = String(i.path.at(-1));
        return {
          field,
          label: labels[key] ?? key,
          section: fieldSection(field),
          message: i.message,
        };
      });
  const model = models?.find((m) => m.id === draft.config.modelId);
  if (models && !model)
    issues.push({
      field: "config.modelId",
      label: "Model",
      section: "overview",
      message: "Select a registered workspace model.",
    });
  if (
    model &&
    (draft.config.maxOutputTokens > model.max_output_tokens ||
      draft.config.maxOutputTokens >= model.context_window)
  )
    issues.push({
      field: "config.maxOutputTokens",
      label: "Maximum output tokens",
      section: "behavior",
      message: `Use at most ${Math.min(model.max_output_tokens, model.context_window - 1).toLocaleString()} tokens for this model.`,
    });
  return issues.filter(
    (i, index, a) => a.findIndex((v) => v.field === i.field) === index,
  );
}
export type ReadinessItem = {
  label: string;
  state: "ready" | "warning" | "optional" | "loading";
  section: ConfigureSection;
  detail: string;
};
export function agentReadiness(
  draft: Draft,
  models: Model[] | undefined,
  knowledge: KnowledgeOption[] | undefined,
  tools: ToolOption[] | undefined,
): ReadinessItem[] {
  const prompt = draft.config.prompt,
    usable =
      prompt.advanced !== null
        ? !!prompt.advanced.trim()
        : [prompt.role, prompt.objective, prompt.instructions].some((v) =>
            v.trim(),
          );
  const kbs = draft.config.rag.knowledgeBaseIds,
    tids = draft.config.tools.toolIds;
  const knowledgeReady =
    knowledge &&
    kbs.every((id) => knowledge.some((k) => k.id === id && k.ready_count > 0));
  const toolsReady =
    tools && tids.every((id) => tools.some((t) => t.id === id && t.enabled));
  const invalid = configureIssues(draft, models);
  return [
    {
      label: "Model",
      section: "overview",
      state: !models
        ? "loading"
        : models.some((m) => m.id === draft.config.modelId)
          ? "ready"
          : "warning",
      detail: !models
        ? "Model registry not loaded"
        : models.some((m) => m.id === draft.config.modelId)
          ? "Registered workspace model"
          : "Select a model",
    },
    {
      label: "Prompt",
      section: "prompt",
      state: usable ? "ready" : "warning",
      detail: usable
        ? "Instructions configured"
        : "Add usable agent instructions",
    },
    {
      label: "Knowledge",
      section: "knowledge",
      state: !kbs.length
        ? "optional"
        : !knowledge
          ? "loading"
          : knowledgeReady
            ? "ready"
            : "warning",
      detail: !kbs.length
        ? "Optional · none attached"
        : !knowledge
          ? "Checking sources"
          : knowledgeReady
            ? `${kbs.length} attached · ready sources available`
            : "An attachment is unavailable or has no ready sources",
    },
    {
      label: "Tools",
      section: "tools",
      state: !tids.length
        ? "optional"
        : !tools
          ? "loading"
          : toolsReady
            ? "ready"
            : "warning",
      detail: !tids.length
        ? "Optional · none attached"
        : !tools
          ? "Checking tools"
          : toolsReady
            ? `${tids.length} attached · enabled`
            : "An attached tool is disabled or unavailable",
    },
    {
      label: "Configuration",
      section: invalid[0]?.section ?? "overview",
      state: invalid.length ? "warning" : "ready",
      detail: invalid.length
        ? `${invalid.length} settings need attention`
        : "Required settings validate",
    },
  ];
}
export function studioURL(
  agent: string | undefined,
  stage: StudioStage,
  section: ConfigureSection,
  replace = false,
) {
  const p = new URLSearchParams(window.location.hash.slice(1));
  if (agent) p.set("agent", agent);
  else p.delete("agent");
  p.set("stage", stage);
  p.set("section", section);
  window.history[replace ? "replaceState" : "pushState"]({}, "", `#${p}`);
  window.dispatchEvent(new Event("agent-studio:navigated"));
}
export function requestAgentLeave() {
  return window.dispatchEvent(
    new Event("agent-studio:before-leave", { cancelable: true }),
  );
}
