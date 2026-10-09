import type { AgentConfig } from "@agentconnect/schemas/agents";
import type {
  ChatMessage,
  ChatProvider,
  ProviderEvent,
} from "@agentconnect/provider-sdk";
export interface AgentRuntime {
  run(
    config: AgentConfig,
    messages: ChatMessage[],
    provider: ChatProvider,
    signal: AbortSignal,
    grounding?: string,
  ): AsyncIterable<ProviderEvent>;
}
export function renderPrompt(config: AgentConfig) {
  const p = config.prompt;
  const sections =
    p.advanced ??
    Object.entries(p)
      .filter(([key, value]) => key !== "advanced" && value)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n\n");
  return `${sections}\n\nRespond in ${config.language}.`;
}
export class SingleAgentRuntime implements AgentRuntime {
  run(
    config: AgentConfig,
    messages: ChatMessage[],
    provider: ChatProvider,
    signal: AbortSignal,
    grounding = "",
  ) {
    return provider.stream({
      system: renderPrompt(config) + grounding,
      messages: messages.slice(-config.historyWindow * 2),
      temperature: config.temperature,
      topP: config.topP,
      maxOutputTokens: config.maxOutputTokens,
      signal,
    });
  }
}
