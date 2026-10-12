import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { context, trace } from "@opentelemetry/api";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  AI_TRACER,
  observe,
  tracedProvider,
  observationContent,
  workflowTraceContext,
} from "../src/ai-tracing.js";
import { langfuseSettings } from "../src/telemetry.js";
import { ProviderError, type ChatProvider } from "@agentconnect/provider-sdk";
const exporter = new InMemorySpanExporter();
const batches: Record<string, unknown>[] = [];
const collector = createServer(async (req, res) => {
  assert.equal(req.url, "/api/public/otel/v1/traces");
  assert.equal(
    req.headers.authorization,
    "Basic " + Buffer.from("pk-fixture:sk-fixture").toString("base64"),
  );
  let body = "";
  for await (const chunk of req) body += chunk;
  batches.push(JSON.parse(body));
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
const port = (collector.address() as { port: number }).port;
const processor = new LangfuseSpanProcessor({
  publicKey: "pk-fixture",
  secretKey: "sk-fixture",
  baseUrl: `http://127.0.0.1:${port}`,
  mediaUploadEnabled: false,
  shouldExportSpan: ({ otelSpan }) =>
    otelSpan.instrumentationScope.name === AI_TRACER,
});
let exportFailures = 0;
let rejectFixtureExports = false;
const failedExportProcessor = new SimpleSpanProcessor({
  export(spans, callback) {
    void spans;
    if (rejectFixtureExports) {
      exportFailures++;
      callback({ code: 1, error: new Error("Fixture collector unavailable") });
    } else callback({ code: 0 });
  },
  async shutdown() {},
});
const provider = new NodeTracerProvider({
  spanProcessors: [
    new SimpleSpanProcessor(exporter),
    failedExportProcessor,
    processor,
  ],
});
provider.register();
after(async () => {
  await provider.shutdown();
  await new Promise<void>((resolve) => collector.close(() => resolve()));
});
const request = () => ({
  system: "Instructions",
  messages: [{ role: "user" as const, content: "Question" }],
  temperature: 0.5,
  topP: null,
  maxOutputTokens: 100,
  signal: AbortSignal.timeout(5000),
});
const fixture: ChatProvider = {
  async *stream() {
    yield { type: "token", text: "Answer" };
    yield { type: "usage", inputTokens: 12, outputTokens: 3 };
  },
};
test("Missing configuration disables export; incomplete and invalid configuration is diagnosed without key values", () => {
  assert.equal(langfuseSettings({}), undefined);
  assert.throws(
    () => langfuseSettings({ LANGFUSE_PUBLIC_KEY: "private-value" }),
    /LANGFUSE_CONFIG_INCOMPLETE/,
  );
  assert.throws(
    () =>
      langfuseSettings({
        LANGFUSE_PUBLIC_KEY: "pk",
        LANGFUSE_SECRET_KEY: "sk",
        LANGFUSE_BASE_URL: "https://user:password@example.com",
      }),
    /LANGFUSE_BASE_URL_INVALID/,
  );
  assert.equal(
    langfuseSettings({
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
      LANGFUSE_BASE_URL: "https://jp.cloud.langfuse.com/",
    })!.baseUrl,
    "https://jp.cloud.langfuse.com",
  );
});
test("Streaming model output, usage, parent context and metadata-only export reach the Langfuse OTLP collector", async () => {
  await observe("agent.fixture", "agent", { "run.id": "fixture" }, async () => {
    const output = [];
    for await (const event of tracedProvider(fixture, {
      provider: "openai",
      modelId: "fixture-model",
    }).stream(request()))
      output.push(event);
    assert.deepEqual(output, [
      { type: "token", text: "Answer" },
      { type: "usage", inputTokens: 12, outputTokens: 3 },
    ]);
  });
  const root = exporter
    .getFinishedSpans()
    .find((s) => s.name === "agent.fixture")!;
  const model = exporter
    .getFinishedSpans()
    .find((s) => s.name === "model.generate")!;
  assert.equal(model.parentSpanContext!.spanId, root.spanContext().spanId);
  assert.equal(model.spanContext().traceId, root.spanContext().traceId);
  assert.equal(
    model.attributes["langfuse.observation.usage_details"],
    '{"input":12,"output":3}',
  );
  assert.equal(model.attributes["langfuse.observation.input"], undefined);
  trace.getTracer("unrelated-http").startSpan("secret-http-request").end();
  await provider.forceFlush();
  const payload = JSON.stringify(batches);
  assert(payload.includes("model.generate"));
  assert(payload.includes("agent.fixture"));
  assert(!payload.includes("secret-http-request"));
  assert(!payload.includes("Question"));
  assert(!payload.includes("sk-fixture"));
});
test("Content capture is opt-in, bounded and masks credential fields and key-shaped strings", async () => {
  const previous = process.env.LANGFUSE_CAPTURE_CONTENT;
  process.env.LANGFUSE_CAPTURE_CONTENT = "true";
  try {
    await observe("content.fixture", "tool", {}, async (span) => {
      observationContent(span, "input", {
        apiKey: "hidden",
        cookie: "hidden",
        message: "sk-sensitive-key",
        rows: Array(100).fill("x".repeat(20000)),
      });
    });
    const value = String(
      exporter.getFinishedSpans().find((s) => s.name === "content.fixture")!
        .attributes["langfuse.observation.input"],
    );
    assert(!value.includes("hidden"));
    assert(!value.includes("sk-sensitive-key"));
    assert(value.length <= 32000);
    assert.doesNotThrow(() => JSON.parse(value));
  } finally {
    if (previous === undefined) delete process.env.LANGFUSE_CAPTURE_CONTENT;
    else process.env.LANGFUSE_CAPTURE_CONTENT = previous;
  }
});
test("Failed model requests and early iterator close end observations and preserve provider behavior without raw errors", async () => {
  const failing: ChatProvider = {
    async *stream() {
      throw new ProviderError("AUTHENTICATION_FAILED", false, 401);
      yield { type: "token", text: "unreachable" };
    },
  };
  await assert.rejects(async () => {
    for await (const event of tracedProvider(failing, {
      provider: "openai",
      modelId: "failed",
    }).stream(request())) {
      assert.fail(JSON.stringify(event));
    }
  }, ProviderError);
  const failed = exporter
    .getFinishedSpans()
    .find((s) => s.attributes["langfuse.observation.model.name"] === "failed")!;
  assert.equal(failed.status.code, 2);
  assert.equal(failed.attributes["http.status_code"], 401);
  let closed = false;
  const streaming: ChatProvider = {
    async *stream() {
      try {
        yield { type: "token", text: "first" };
        yield { type: "token", text: "second" };
      } finally {
        closed = true;
      }
    },
  };
  for await (const event of tracedProvider(streaming, {
    provider: "openai",
    modelId: "early-close",
  }).stream(request())) {
    assert.equal(event.type, "token");
    break;
  }
  assert(closed);
  assert.equal(
    exporter
      .getFinishedSpans()
      .find(
        (s) =>
          s.attributes["langfuse.observation.model.name"] === "early-close",
      )!.attributes["generation.status"],
    "interrupted",
  );
  await assert.rejects(() =>
    observe("unsafe-error", "chain", {}, async () => {
      throw new Error("password=do-not-export");
    }),
  );
  assert(
    !JSON.stringify(
      exporter.getFinishedSpans().map((s) => s.attributes),
    ).includes("do-not-export"),
  );
});
test("Parallel workflow executions keep isolated parents and approval resumes share a durable trace ID", async () => {
  await Promise.all(
    ["workflow-a", "workflow-b"].map((id) =>
      context.with(workflowTraceContext(id), () =>
        observe(
          "workflow.fixture",
          "chain",
          { "workflow.run.id": id },
          async () => {
            await Promise.all(
              [1, 2].map((n) =>
                observe(
                  "node.fixture",
                  "chain",
                  { "workflow.run.id": id, node: n },
                  async () => {
                    await new Promise((resolve) => setTimeout(resolve, n));
                  },
                ),
              ),
            );
          },
        ),
      ),
    ),
  );
  await context.with(workflowTraceContext("workflow-a"), () =>
    observe("workflow.resume", "chain", {}, async () => {}),
  );
  const spans = exporter.getFinishedSpans();
  const roots = spans.filter((s) => s.name === "workflow.fixture");
  assert.notEqual(
    roots[0]!.spanContext().traceId,
    roots[1]!.spanContext().traceId,
  );
  for (const root of roots)
    for (const node of spans.filter(
      (s) =>
        s.name === "node.fixture" &&
        s.attributes["workflow.run.id"] === root.attributes["workflow.run.id"],
    ))
      assert.equal(node.parentSpanContext!.spanId, root.spanContext().spanId);
  assert.equal(
    spans.find((s) => s.name === "workflow.resume")!.spanContext().traceId,
    roots
      .find((s) => s.attributes["workflow.run.id"] === "workflow-a")!
      .spanContext().traceId,
  );
});

test("Collector export failures remain outside the application result and do not fail agent execution", async () => {
  const before = exportFailures;
  rejectFixtureExports = true;
  const result = await observe(
    "export.failure.fixture",
    "agent",
    {},
    async () => "normal-answer",
  );
  rejectFixtureExports = false;
  assert.equal(result, "normal-answer");
  assert(exportFailures > before);
});

test("API and worker initialization uses the supplied project environment and flushes SDK spans on shutdown", async () => {
  const script = `
    const { initializeTelemetry, shutdownTelemetry } = await import('./src/telemetry.ts');
    const { observe } = await import('./src/ai-tracing.ts');
    initializeTelemetry('agentconnex-worker');
    await observe('worker.startup.fixture', 'chain', {}, async () => {});
    await shutdownTelemetry();
  `;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LANGFUSE_PUBLIC_KEY: "pk-fixture",
        LANGFUSE_SECRET_KEY: "sk-fixture",
        LANGFUSE_BASE_URL: `http://127.0.0.1:${port}`,
        OTEL_EXPORTER_OTLP_ENDPOINT: "",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
      },
      timeout: 15000,
    },
  );
  assert(stdout.includes("Langfuse tracing enabled"));
  assert(!stdout.includes("sk-fixture"));
  assert(!stderr.includes("sk-fixture"));
  assert(JSON.stringify(batches).includes("worker.startup.fixture"));
});
