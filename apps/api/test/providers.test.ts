import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  createProvider,
  decodeSSE,
  safeTransport,
  validateEndpoint,
  type ProviderName,
  type Transport,
} from "@agentconnect/provider-sdk";
const encoder = new TextEncoder();
const input = {
  system: "Fixture system",
  messages: [{ role: "user" as const, content: "Hello" }],
  temperature: 0.5,
  topP: null,
  maxOutputTokens: 32,
  signal: new AbortController().signal,
};
function fixtureTransport(
  frames: string[],
  onRequest?: (
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ) => void,
): Transport {
  return async (url, headers, body) => {
    onRequest?.(url, headers, body);
    return {
      status: 200,
      body: (async function* () {
        for (const frame of frames) yield encoder.encode(frame);
      })(),
      close: async () => {},
    };
  };
}
async function output(
  provider: ProviderName,
  frames: string[],
  capture?: (
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ) => void,
) {
  const p = createProvider(
    {
      provider,
      modelId: "fixture-model",
      baseUrl:
        provider === "gemini"
          ? "https://generativelanguage.googleapis.com/v1beta"
          : provider === "anthropic"
            ? "https://api.anthropic.com/v1"
            : "https://api.openai.com/v1",
      apiKey: "fixture-only-not-a-credential",
      capabilities: { temperature: true, topP: true },
    },
    fixtureTransport(frames, capture),
  );
  const events = [];
  for await (const e of p.stream(input)) events.push(e);
  return events;
}
test("SSE decoder handles UTF-8 and CRLF split across arbitrary network chunks", async () => {
  const bytes = encoder.encode('event: token\r\ndata: {"text":"café"}\r\n\r\n');
  const body = (async function* () {
    for (const byte of bytes) yield new Uint8Array([byte]);
  })();
  const frames = [];
  for await (const frame of decodeSSE(body)) frames.push(frame);
  assert.deepEqual(frames, [{ event: "token", data: '{"text":"café"}' }]);
});
test("OpenAI streams text and provider-reported usage", async () => {
  let captured = false;
  const events = await output(
    "openai",
    [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ],
    (url, headers, body) => {
      assert.equal(url, "https://api.openai.com/v1/chat/completions");
      assert.ok(headers.Authorization?.startsWith("Bearer "));
      assert.equal(
        (body as { messages: { role: string }[] }).messages[0]!.role,
        "system",
      );
      captured = true;
    },
  );
  assert.ok(captured);
  assert.deepEqual(events, [
    { type: "token", text: "Hello" },
    { type: "usage", inputTokens: 8, outputTokens: 2 },
  ]);
});
test("Anthropic uses system field and messages API event protocol", async () => {
  const events = await output(
    "anthropic",
    [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":0}}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'data: {"type":"message_delta","usage":{"output_tokens":3}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ],
    (url, headers, body) => {
      assert.ok(url.endsWith("/messages"));
      assert.equal(headers["anthropic-version"], "2023-06-01");
      assert.equal((body as { system: string }).system, input.system);
    },
  );
  assert.deepEqual(events.at(-1), {
    type: "usage",
    inputTokens: 9,
    outputTokens: 3,
  });
  assert.ok(events.some((e) => e.type === "token"));
});
test("Gemini maps roles and streams candidates without credentials in URL", async () => {
  const events = await output(
    "gemini",
    [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}\n\n',
    ],
    (url, headers) => {
      assert.ok(url.includes(":streamGenerateContent?alt=sse"));
      assert.ok(!url.includes("key="));
      assert.ok(headers["x-goog-api-key"]);
    },
  );
  assert.deepEqual(events, [
    { type: "token", text: "Hello" },
    { type: "usage", inputTokens: 4, outputTokens: 2 },
  ]);
});
test("Compatible provider preserves unknown usage as unavailable", async () => {
  const events = await output("openai-compatible", [
    'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  assert.deepEqual(events, [{ type: "token", text: "Hello" }]);
});
test("Provider failures and incomplete streams are explicit and redact upstream bodies", async () => {
  const p = createProvider(
    {
      provider: "openai",
      modelId: "fixture",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "fixture-only",
      capabilities: { temperature: true, topP: true },
    },
    async () => ({
      status: 401,
      body: (async function* () {
        yield encoder.encode("sensitive upstream body");
      })(),
      close: async () => {},
    }),
  );
  await assert.rejects(
    async () => {
      for await (const e of p.stream(input)) void e;
    },
    (e) =>
      e instanceof Error &&
      e.message === "Model provider request failed" &&
      "code" in e &&
      e.code === "AUTHENTICATION_FAILED",
  );
  await assert.rejects(
    () =>
      output("openai", [
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      ]),
    (e) => e instanceof Error && "code" in e && e.code === "INCOMPLETE_STREAM",
  );
});
test("Endpoint validation blocks unapproved hosts, credentials, insecure URLs and private IPs", async () => {
  assert.throws(() =>
    validateEndpoint("https://evil.example/v1", ["api.openai.com"]),
  );
  assert.throws(() =>
    validateEndpoint("https://user:password@api.openai.com/v1", [
      "api.openai.com",
    ]),
  );
  assert.throws(() =>
    validateEndpoint("http://api.openai.com/v1", ["api.openai.com"]),
  );
  await assert.rejects(() =>
    safeTransport(["127.0.0.1"])("https://127.0.0.1", {}, {}, input.signal),
  );
});
test("Explicitly approved private transport performs real HTTP and does not follow redirects", async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const host = `127.0.0.1:${address.port}`;
  try {
    const result = await safeTransport([], [host])(
      `http://${host}/v1`,
      {},
      {},
      input.signal,
    );
    assert.equal(result.status, 302);
    await result.close();
    assert.equal(requests, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
