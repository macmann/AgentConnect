import type { AgentConfig } from "@agentconnect/schemas/agents";
import { renderPrompt } from "@agentconnect/schemas/agent-prompt";
export { renderPrompt } from "@agentconnect/schemas/agent-prompt";
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
