import { createHash } from "node:crypto";
import {
  context,
  trace,
  SpanStatusCode,
  TraceFlags,
  type Attributes,
  type Span,
} from "@opentelemetry/api";
import type {
  ChatProvider,
  ModelConnection,
  ChatRequest,
} from "@agentconnect/provider-sdk";

export const AI_TRACER = "agentconnex-ai";
export function startObservation(
  name: string,
  type: string,
  attributes: Attributes = {},
) {
  return trace.getTracer(AI_TRACER).startSpan(name, {
    attributes: {
      "langfuse.observation.type": type,
      "langfuse.observation.metadata": JSON.stringify(attributes),
      ...attributes,
    },
  });
}
/** Never record arbitrary exception messages, provider bodies or stack traces. */
export function observationError(span: Span, error: unknown) {
  const value = error as { code?: unknown; httpStatus?: unknown } | null;
  const code =
    typeof value?.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code)
      ? value.code
      : "EXECUTION_FAILED";
  span.setStatus({ code: SpanStatusCode.ERROR, message: code });
  span.setAttributes({
    "error.code": code,
    "langfuse.observation.level": "ERROR",
    "langfuse.observation.status_message": code,
  });
  if (typeof value?.httpStatus === "number")
    span.setAttribute("http.status_code", value.httpStatus);
}
function safeContent(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[Truncated]";
  if (typeof value === "string")
    return value.replace(/\b(?:sk|pk)-[\w-]+\b/g, "[REDACTED]").slice(0, 16000);
  if (Array.isArray(value))
    return value.slice(0, 50).map((v) => safeContent(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .map(([k, v]) => [
          k,
          /password|secret|authorization|api.?key|cookie|credential|access.?token|refresh.?token/i.test(
            k,
          )
            ? "[REDACTED]"
            : safeContent(v, depth + 1),
        ]),
    );
  return value;
}
/** Content export is an explicit operator choice; bounded, with credential-field masking. */
export function observationContent(
  span: Span,
  direction: "input" | "output",
  value: unknown,
  root = false,
) {
  if (process.env.LANGFUSE_CAPTURE_CONTENT !== "true" || !span.isRecording())
    return;
  try {
    let encoded = JSON.stringify(safeContent(value));
    if (!encoded) return;
    if (encoded.length > 32000)
      encoded = JSON.stringify({
        truncated: true,
        preview: encoded.slice(0, 31000),
      });
    span.setAttribute(`langfuse.observation.${direction}`, encoded);
    if (root) span.setAttribute(`langfuse.trace.${direction}`, encoded);
  } catch {
    /* Instrumentation must not break a request. */
  }
}
export async function observe<T>(
  name: string,
  type: string,
  attributes: Attributes,
  operation: (span: Span) => Promise<T>,
  expectedInterruption?: (error: unknown) => boolean,
): Promise<T> {
  const span = startObservation(name, type, attributes);
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      return await operation(span);
    } catch (error) {
      if (expectedInterruption?.(error))
        span.setAttribute("execution.status", "waiting");
      else observationError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}
/** Stable trace across durable workflow recovery/approval, without storing new schema data. */
export function workflowTraceContext(runId: string) {
  return trace.setSpanContext(context.active(), {
    traceId: createHash("sha256")
      .update("agentconnex-workflow:" + runId)
      .digest("hex")
      .slice(0, 32),
    spanId: createHash("sha256")
      .update("agentconnex-workflow-parent:" + runId)
      .digest("hex")
      .slice(0, 16),
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
}
/** Wrap actual attempts, including planning, summaries and fallback providers. Never capture connection keys. */
export function tracedProvider(
  provider: ChatProvider,
  model: Pick<ModelConnection, "provider" | "modelId">,
): ChatProvider {
  return {
    async *stream(input: ChatRequest) {
      const span = startObservation("model.generate", "generation", {
        "model.provider": model.provider,
        "langfuse.observation.model.name": model.modelId,
        "langfuse.observation.model.parameters": JSON.stringify({
          temperature: input.temperature,
          top_p: input.topP,
          max_output_tokens: input.maxOutputTokens,
        }),
      });
      observationContent(span, "input", {
        system: input.system,
        messages: input.messages,
      });
      const active = trace.setSpan(context.active(), span);
      const iterator = context.with(active, () =>
        provider.stream(input)[Symbol.asyncIterator](),
      );
      let output = "",
        first = true,
        completed = false;
      try {
        while (true) {
          const next = await context.with(active, () => iterator.next());
          if (next.done) {
            completed = true;
            break;
          }
          const event = next.value;
          if (event.type === "token") {
            if (first && event.text) {
              span.setAttribute(
                "langfuse.observation.completion_start_time",
                new Date().toISOString(),
              );
              first = false;
            }
            if (process.env.LANGFUSE_CAPTURE_CONTENT === "true")
              output = (output + event.text).slice(0, 16000);
          } else {
            const usage: Record<string, number> = {};
            if (event.inputTokens !== null) usage.input = event.inputTokens;
            if (event.outputTokens !== null) usage.output = event.outputTokens;
            span.setAttribute(
              "langfuse.observation.usage_details",
              JSON.stringify(usage),
            );
          }
          yield event;
        }
      } catch (error) {
        observationError(span, error);
        throw error;
      } finally {
        try {
          if (!completed && iterator.return)
            await context.with(active, () => iterator.return!());
        } finally {
          span.setAttribute(
            "generation.status",
            completed
              ? "completed"
              : input.signal.aborted
                ? "cancelled"
                : "interrupted",
          );
          observationContent(span, "output", output);
          span.end();
        }
      }
    },
  };
}
