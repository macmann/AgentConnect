import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BatchSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { AI_TRACER } from "./ai-tracing.js";

export function langfuseSettings(env: NodeJS.ProcessEnv) {
  const keys = [
    env.LANGFUSE_PUBLIC_KEY,
    env.LANGFUSE_SECRET_KEY,
    env.LANGFUSE_BASE_URL,
  ];
  if (!keys.some(Boolean)) return undefined;
  if (!keys.every(Boolean)) throw new Error("LANGFUSE_CONFIG_INCOMPLETE");
  let url: URL;
  try {
    url = new URL(env.LANGFUSE_BASE_URL!);
  } catch {
    throw new Error("LANGFUSE_BASE_URL_INVALID");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new Error("LANGFUSE_BASE_URL_INVALID");
  return {
    publicKey: env.LANGFUSE_PUBLIC_KEY!,
    secretKey: env.LANGFUSE_SECRET_KEY!,
    baseUrl: url.href.replace(/\/$/, ""),
  };
}
export let telemetry: NodeSDK | undefined;
export function initializeTelemetry(serviceName: string) {
  if (telemetry) return telemetry;
  let settings: ReturnType<typeof langfuseSettings>;
  try {
    settings = langfuseSettings(process.env);
  } catch (error) {
    console.warn(
      JSON.stringify({
        msg: "Langfuse disabled: check server environment configuration",
        code: (error as Error).message,
      }),
    );
  }
  const processors: SpanProcessor[] = [];
  if (settings) {
    processors.push(
      new LangfuseSpanProcessor({
        ...settings,
        mediaUploadEnabled: false,
        shouldExportSpan: ({ otelSpan }) =>
          [AI_TRACER, "agentconnect-runtime"].includes(
            otelSpan.instrumentationScope.name,
          ),
      }),
    );
    console.info(
      JSON.stringify({
        msg: "Langfuse tracing enabled",
        captureContent: process.env.LANGFUSE_CAPTURE_CONTENT === "true",
      }),
    );
  }
  if (
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  )
    processors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
  telemetry = processors.length
    ? new NodeSDK({
        serviceName: process.env.OTEL_SERVICE_NAME ?? serviceName,
        spanProcessors: processors,
        instrumentations:
          process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
          process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
            ? [
                getNodeAutoInstrumentations({
                  "@opentelemetry/instrumentation-fs": { enabled: false },
                }),
              ]
            : [],
      })
    : undefined;
  telemetry?.start();
  return telemetry;
}
export async function shutdownTelemetry() {
  try {
    await telemetry?.shutdown();
  } catch {
    console.warn(
      JSON.stringify({
        msg: "Telemetry shutdown failed",
        code: "TELEMETRY_SHUTDOWN_FAILED",
      }),
    );
  }
}
