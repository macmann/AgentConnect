import {
  ProviderError,
  type ChatProvider,
  type ProviderFactory,
  type ChatRequest,
} from "@agentconnect/provider-sdk";
import type { AgentConfig } from "@agentconnect/schemas/agents";
import {
  connection,
  validateModelSet,
  type ModelSnapshot,
} from "./agent-models.js";
import { controlledProvider, tokenCount } from "./context-control.js";

export function selectRoute(c: AgentConfig, query: string, priorTurns: number) {
  const rule = c.modelRouting;
  const normalized = (value: string) =>
    value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  return rule.enabled &&
    rule.lightModelId &&
    query.length <= rule.maxQueryCharacters &&
    (!rule.firstTurnOnly || priorTurns === 0) &&
    rule.phrases.some((p) => normalized(p) === normalized(query))
    ? rule.lightModelId
    : c.modelId;
}

export function eligibleForFailover(error: unknown, rateLimit: boolean) {
  if (!(error instanceof ProviderError)) return false;
  if (error.code === "RATE_LIMITED")
    return rateLimit && error.details?.providerCode !== "insufficient_quota";
  return (
    error.code === "NETWORK_ERROR" ||
    error.code === "FIRST_TOKEN_TIMEOUT" ||
    (error.code === "PROVIDER_HTTP_ERROR" &&
      !!error.httpStatus &&
      error.httpStatus >= 500)
  );
}

/** A attempt is retried only before a nonempty token. Never replay partially emitted output. */
export async function* timedStream(
  provider: ChatProvider,
  input: ChatRequest,
  timeoutMs: number,
) {
  const local = new AbortController();
  let timedOut = false;
  const signal = AbortSignal.any([input.signal, local.signal]);
  const timer = setTimeout(() => {
    timedOut = true;
    local.abort();
  }, timeoutMs);
  timer.unref();
  try {
    for await (const event of provider.stream({ ...input, signal })) {
      if (event.type === "token" && event.text.length) clearTimeout(timer);
      yield event;
    }
  } catch (error) {
    if (timedOut && !input.signal.aborted)
      throw new ProviderError("FIRST_TOKEN_TIMEOUT", true);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function routedProvider(
  c: AgentConfig,
  primary: ModelSnapshot,
  query: string,
  priorTurns: number,
  workspaceId: string,
  organizationId: string,
  factory: ProviderFactory,
) {
  validateModelSet(c, primary);
  const selected = selectRoute(c, query, priorTurns);
  const candidates = [
    primary,
    ...primary.alternatives.map((m) => ({ ...m, alternatives: [] })),
  ];
  const order = [
    ...new Set([
      selected,
      ...(selected !== primary.id ? [primary.id] : []),
      ...c.modelRouting.fallbackModelIds,
    ]),
  ];
  const meters: ReturnType<typeof controlledProvider>[] = [];
  const meterModels: string[] = [];
  const attempts: {
    modelId: string;
    provider: string;
    outcome: string;
    code?: string;
  }[] = [];
  return {
    usage: () => ({
      estimated: meters.reduce((n, m) => n + m.usage().estimated, 0),
      reported: meters.reduce((n, m) => n + m.usage().reported, 0),
      inputTokens: meters.reduce((n, m) => n + m.usage().inputTokens, 0),
      outputTokens: meters.reduce((n, m) => n + m.usage().outputTokens, 0),
      calls: meters.reduce((n, m) => n + m.usage().calls, 0),
      requests: meters.flatMap((m, i) =>
        m.usage().requests.map((r) => ({ ...r, modelId: meterModels[i]! })),
      ),
      modelUsage: meters.map((m, i) => ({
        modelId: meterModels[i]!,
        inputTokens: m.usage().inputTokens,
        outputTokens: m.usage().outputTokens,
        estimated: m.usage().estimatedCalls > 0,
      })),
      routing: { selectedModelId: selected, attempts },
    }),
    provider: {
      async *stream(input) {
        for (let index = 0; index < order.length; index++) {
          input.signal.throwIfAborted();
          const model = candidates.find((m) => m.id === order[index])!;
          let emitted = false;
          const attempt: (typeof attempts)[number] = {
            modelId: model.id,
            provider: model.provider,
            outcome: "running",
          };
          attempts.push(attempt);
          try {
            // Even without opt-in optimization, each routed model must fit this exact request.
            if (order.length > 1 || c.modelRouting.enabled) {
              const measured =
                tokenCount(input.system, c.contextControls.tokenizer) +
                input.messages.reduce(
                  (n, m) =>
                    n + tokenCount(m.content, c.contextControls.tokenizer) + 4,
                  3,
                );
              if (
                input.maxOutputTokens > model.maxOutputTokens ||
                measured + input.maxOutputTokens > model.contextWindow
              )
                throw new ProviderError("CONTEXT_LIMIT");
            }
            const meter = controlledProvider(
              factory(await connection(model, workspaceId, organizationId)),
              c,
              model,
            );
            meters.push(meter);
            meterModels.push(model.id);
            const stream =
              order.length > 1 || c.modelRouting.enabled
                ? timedStream(
                    meter.provider,
                    input,
                    c.modelRouting.firstTokenTimeoutMs,
                  )
                : meter.provider.stream(input);
            // Usage from a failed pre-token attempt must not become the answer's usage.
            let usage:
              import("@agentconnect/provider-sdk").ProviderEvent | undefined;
            for await (const event of stream) {
              if (event.type === "usage") usage = event;
              else {
                if (event.text.length) emitted = true;
                yield event;
              }
            }
            if (usage) yield usage;
            attempt.outcome = "completed";
            return;
          } catch (error) {
            attempt.outcome = "failed";
            attempt.code =
              error instanceof ProviderError ? error.code : "MODEL_UNAVAILABLE";
            const lightDoesNotFit =
              model.id === c.modelRouting.lightModelId &&
              error instanceof ProviderError &&
              error.code === "CONTEXT_LIMIT";
            if (
              input.signal.aborted ||
              emitted ||
              index === order.length - 1 ||
              (!lightDoesNotFit &&
                !eligibleForFailover(error, c.modelRouting.fallbackOnRateLimit))
            )
              throw error;
          }
        }
      },
    } as ChatProvider,
  };
}

export function modelUsageCost(
  usage: { modelId: string; inputTokens: number; outputTokens: number }[],
  prices: {
    model_id: string;
    input_usd_per_million: number;
    output_usd_per_million: number;
  }[],
) {
  let input = 0,
    output = 0,
    inputCost = 0,
    outputCost = 0;
  for (const call of usage) {
    const price = prices.find((p) => p.model_id === call.modelId);
    if (!price) return null;
    input += call.inputTokens;
    output += call.outputTokens;
    inputCost += call.inputTokens * Number(price.input_usd_per_million);
    outputCost += call.outputTokens * Number(price.output_usd_per_million);
  }
  return {
    cost: (inputCost + outputCost) / 1000000,
    inputRate: input ? inputCost / input : 0,
    outputRate: output ? outputCost / output : 0,
  };
}
