import type { AgentConfig } from "./agents.js";

// Shared by the runtime and the configuration preview. Runtime security/grounding is separate.
export function renderPrompt(config: Pick<AgentConfig, "prompt" | "language">) {
  const p = config.prompt;
  const sections =
    p.advanced ??
    Object.entries(p)
      .filter(([key, value]) => key !== "advanced" && value)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n\n");
  return `${sections}\n\nRespond in ${config.language}.`;
}
