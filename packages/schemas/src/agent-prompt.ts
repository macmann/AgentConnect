import type { AgentConfig } from "./agents.js";

// Shared by the runtime and the configuration preview. Runtime security/grounding is separate.
export function renderPrompt(
  config: Pick<AgentConfig, "prompt" | "language"> &
    Partial<Pick<AgentConfig, "languageMode">>,
) {
  const p = config.prompt;
  const sections =
    p.advanced ??
    Object.entries(p)
      .filter(([key, value]) => key !== "advanced" && value)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n\n");
  const language = config.language.trim() || "English";
  const policy =
    config.languageMode === "auto"
      ? `Response language policy: Respond in the language of the latest user message. If the user explicitly requests a response language, use that language. Re-evaluate the language each turn; do not keep using an earlier language after the user switches. For mixed-language messages, use the dominant language of the actual question. If the message has no clear language (such as only numbers or an emoji), use the most recent meaningful user message's language; if none is available, use ${language}. The language of reference passages, tool results, previous assistant messages and examples must not determine the response language. Apply this to customer-facing prose and rich-response labels, while preserving JSON keys, schema discriminator values, citations, identifiers and proper names. Translate supported facts without changing their meaning or adding unsupported claims.`
      : `Respond in ${language}.`;
  return `${sections}\n\n${policy}`;
}
