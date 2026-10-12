// These regressions explicitly exercise metadata-only tracing regardless of local operator settings.
process.env.LANGFUSE_CAPTURE_CONTENT = "false";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
export const traceExporter = new InMemorySpanExporter();
export const traceProvider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(traceExporter)],
});
traceProvider.register();
export const capturedSpans = () => traceExporter.getFinishedSpans();
