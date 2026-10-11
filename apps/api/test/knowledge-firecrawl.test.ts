import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { crawlFirecrawl } from "../src/knowledge-firecrawl.js";
import { config } from "../src/config.js";
import { websiteInput } from "@agentconnect/schemas/knowledge";
import { KnowledgeError, parseHTML } from "@agentconnect/rag/parsers";
import type { safeHttpTransport } from "@agentconnect/provider-sdk";
const previous = config.KNOWLEDGE_ALLOWED_HOSTS;
before(() => {
  config.KNOWLEDGE_ALLOWED_HOSTS = "crawl.example.com";
});
after(() => {
  config.KNOWLEDGE_ALLOWED_HOSTS = previous;
});
const options = {
  url: "https://crawl.example.com/",
  maxPages: 3,
  maxDepth: 2,
  allowedPaths: ["/"],
  blockedPaths: ["/private"],
};
function mock(responses: { status?: number; value: unknown }[]) {
  const calls: {
    url: string;
    headers: Record<string, string>;
    body: unknown;
    method: string;
  }[] = [];
  const send: ReturnType<typeof safeHttpTransport> = async (
    url,
    headers,
    body,
    _signal,
    method = "POST",
  ) => {
    calls.push({ url, headers, body, method });
    const response = responses.shift();
    assert.ok(response, "Unexpected request");
    return {
      status: response.status ?? 200,
      body: (async function* () {
        yield Buffer.from(JSON.stringify(response.value));
      })(),
      close: async () => {},
    };
  };
  return { send, calls };
}
const page = (url = "https://crawl.example.com/help") => ({
  html: "<html><body><main><h1>Refund policy</h1><p>Refunds within 30 days.</p><table><tr><th>Product</th><th>Days</th></tr><tr><td>Card</td><td>30</td></tr></table></main></body></html>",
  metadata: { sourceURL: url, title: "Help" },
});
test("Website defaults crawl a site and validate provider credentials and budgets", () => {
  const parsed = websiteInput.parse({ url: options.url });
  assert.equal(parsed.crawler, "builtin");
  assert.equal(parsed.maxPages, 20);
  assert.equal(parsed.maxDepth, 2);
  assert.equal(
    websiteInput.safeParse({ url: options.url, crawler: "firecrawl" }).success,
    false,
  );
  assert.equal(
    websiteInput.safeParse({ url: options.url, maxPages: 101 }).success,
    false,
  );
  assert.equal(
    websiteInput.safeParse({
      url: options.url,
      secretId: "00000000-0000-4000-8000-000000000001",
    }).success,
    false,
  );
});
test("Discover navigation links but exclude navigation text from RAG", () => {
  const parsed = parseHTML(
    Buffer.from(
      '<html><body><nav><a href="/help">Navigation menu</a></nav><main>Refunds within 30 days.</main></body></html>',
    ),
    "Home",
  );
  assert.ok(parsed.links.includes("/help"));
  assert.ok(!parsed.sections[0]!.text.includes("Navigation menu"));
});
test("Firecrawl polls and paginates, preserving URL citations and table content", async () => {
  const { send, calls } = mock([
    { value: { success: true, id: "crawl-123" } },
    { value: { status: "scraping" } },
    {
      value: {
        status: "completed",
        data: [page()],
        next: "https://api.firecrawl.dev/v2/crawl/crawl-123?skip=1",
      },
    },
    {
      value: {
        status: "completed",
        data: [page("https://crawl.example.com/products")],
      },
    },
  ]);
  const result = await crawlFirecrawl(
    options,
    "fixture-key",
    new AbortController().signal,
    send,
    0,
  );
  assert.equal(result.length, 2);
  assert.equal(result[0]!.url, "https://crawl.example.com/help");
  assert.equal(result[0]!.document.title, "Help");
  assert.ok(result[0]!.document.sections[0]!.text.includes("Card"));
  const payload = calls[0]!.body as {
    limit: number;
    sitemap: string;
    crawlEntireDomain: boolean;
    maxDiscoveryDepth: number;
    allowExternalLinks: boolean;
    scrapeOptions: { formats: string[] };
  };
  assert.equal(payload.limit, 3);
  assert.equal(payload.sitemap, "skip");
  assert.equal(payload.crawlEntireDomain, true);
  assert.equal(payload.maxDiscoveryDepth, 2);
  assert.equal(payload.allowExternalLinks, false);
  assert.deepEqual(payload.scrapeOptions.formats, ["html"]);
  assert.ok(
    calls.every((call) =>
      call.url.startsWith("https://api.firecrawl.dev/v2/crawl"),
    ),
  );
  assert.ok(
    calls.every((call) => call.headers.authorization === "Bearer fixture-key"),
  );
});
for (const [name, value, code] of [
  [
    "blocked page",
    { status: "completed", data: [page("https://crawl.example.com/private")] },
    "FIRECRAWL_PAGE_OUT_OF_SCOPE",
  ],
  [
    "foreign cursor",
    { status: "completed", data: [page()], next: "https://other.example/leak" },
    "FIRECRAWL_INVALID_CURSOR",
  ],
  ["empty crawl", { status: "completed", data: [] }, "NO_WEBSITE_PAGES"],
  [
    "malformed page",
    { status: "completed", data: [{ metadata: { sourceURL: options.url } }] },
    "FIRECRAWL_INVALID_RESPONSE",
  ],
] as const)
  test(
    "Firecrawl rejects " + name + " and cancels its remote crawl",
    async () => {
      const { send, calls } = mock([
        { value: { success: true, id: "crawl-123" } },
        { value },
        { value: { success: true } },
      ]);
      await assert.rejects(
        crawlFirecrawl(
          options,
          "fixture-key",
          new AbortController().signal,
          send,
          0,
        ),
        (error: unknown) =>
          error instanceof KnowledgeError && error.code === code,
      );
      assert.equal(calls.at(-1)!.method, "DELETE");
    },
  );
test("Firecrawl errors expose stable codes without provider bodies or credentials", async () => {
  const { send } = mock([
    { status: 401, value: { error: "fixture-key secret provider body" } },
  ]);
  await assert.rejects(
    crawlFirecrawl(
      options,
      "fixture-key",
      new AbortController().signal,
      send,
      0,
    ),
    (error: unknown) =>
      error instanceof KnowledgeError &&
      error.code === "FIRECRAWL_AUTHENTICATION_FAILED" &&
      !error.message.includes("fixture-key"),
  );
});
test("Cancellation interrupts polling and cleans up the remote job", async () => {
  const controller = new AbortController();
  const { send, calls } = mock([
    { value: { success: true, id: "crawl-123" } },
    { value: { status: "scraping" } },
    { value: { success: true } },
  ]);
  const promise = crawlFirecrawl(
    options,
    "fixture-key",
    controller.signal,
    send,
    10000,
  );
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise);
  assert.equal(calls.at(-1)!.method, "DELETE");
});
