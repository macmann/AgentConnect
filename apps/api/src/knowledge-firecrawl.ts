import { safeHttpTransport } from "@agentconnect/provider-sdk";
import { KnowledgeError, parseHTML } from "@agentconnect/rag/parsers";
import { setTimeout as delay } from "node:timers/promises";
import type { CrawlConfig } from "./knowledge-websites.js";
import { validateWebsite } from "./knowledge-websites.js";

const origin = "https://api.firecrawl.dev";
const transport = safeHttpTransport(["api.firecrawl.dev"], []);
const prefix = (path: string) =>
  "^/?" + path.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$");
// The transport seam is for protocol tests, never a user-controlled API URL.
export async function crawlFirecrawl(
  options: CrawlConfig,
  apiKey: string,
  signal: AbortSignal,
  send = transport,
  pause = 2000,
) {
  const root = validateWebsite(options.url);
  if (
    root.protocol !== "https:" ||
    root.hostname === "localhost" ||
    root.hostname.startsWith("[") ||
    /^[\d.:\[\]]+$/.test(root.hostname)
  )
    throw new KnowledgeError("FIRECRAWL_PUBLIC_HTTPS_REQUIRED");
  async function request(
    path: string,
    method: "GET" | "POST" | "DELETE" = "GET",
    body?: object,
    requestSignal = signal,
  ) {
    const response = await send(
      origin + path,
      { authorization: "Bearer " + apiKey, "content-type": "application/json" },
      body,
      requestSignal,
      method,
    );
    try {
      if (response.status < 200 || response.status >= 300)
        throw new KnowledgeError(
          response.status === 401 || response.status === 403
            ? "FIRECRAWL_AUTHENTICATION_FAILED"
            : response.status === 402
              ? "FIRECRAWL_CREDITS_REQUIRED"
              : "FIRECRAWL_HTTP_ERROR",
        );
      const chunks: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.byteLength;
        if (length > 20000000)
          throw new KnowledgeError("FIRECRAWL_RESPONSE_TOO_LARGE");
        chunks.push(chunk);
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new KnowledgeError("FIRECRAWL_INVALID_RESPONSE");
      }
    } finally {
      await response.close();
    }
  }
  let jobId: string | undefined;
  let completed = false;
  try {
    const started = await request("/v2/crawl", "POST", {
      url: root.href,
      limit: options.maxPages,
      maxDiscoveryDepth: options.maxDepth,
      sitemap: "skip",
      allowExternalLinks: false,
      allowSubdomains: false,
      crawlEntireDomain: true,
      includePaths: options.allowedPaths.map(prefix),
      excludePaths: options.blockedPaths.map(prefix),
      scrapeOptions: { formats: ["html"], onlyMainContent: true },
    });
    if (
      started.success !== true ||
      typeof started.id !== "string" ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(started.id)
    )
      throw new KnowledgeError("FIRECRAWL_INVALID_RESPONSE");
    jobId = started.id;
    let status;
    for (let attempt = 0; attempt < 120; attempt++) {
      signal.throwIfAborted();
      status = await request("/v2/crawl/" + jobId);
      if (status.status === "completed") break;
      if (status.status !== "scraping")
        throw new KnowledgeError("FIRECRAWL_CRAWL_FAILED");
      await delay(pause, undefined, { signal });
    }
    if (status?.status !== "completed")
      throw new KnowledgeError("FIRECRAWL_TIMEOUT");
    const pages = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    const cursors = new Set<string>();
    while (status) {
      if (!Array.isArray(status.data))
        throw new KnowledgeError("FIRECRAWL_INVALID_RESPONSE");
      for (const item of status.data) {
        signal.throwIfAborted();
        if (
          typeof item.html !== "string" ||
          typeof item.metadata?.sourceURL !== "string"
        )
          throw new KnowledgeError("FIRECRAWL_INVALID_RESPONSE");
        const url = validateWebsite(item.metadata.sourceURL);
        url.hash = "";
        if (
          url.origin !== root.origin ||
          !options.allowedPaths.some((path) => url.pathname.startsWith(path)) ||
          options.blockedPaths.some((path) => url.pathname.startsWith(path))
        )
          throw new KnowledgeError("FIRECRAWL_PAGE_OUT_OF_SCOPE");
        if (seen.has(url.href)) continue;
        if (pages.length >= options.maxPages)
          throw new KnowledgeError("FIRECRAWL_PAGE_LIMIT");
        seen.add(url.href);
        const bytes = Buffer.from(item.html);
        totalBytes += bytes.length;
        if (bytes.length > 2000000 || totalBytes > 20000000)
          throw new KnowledgeError("WEBSITE_SIZE_LIMIT");
        const document = parseHTML(bytes, url.href);
        if (typeof item.metadata.title === "string")
          document.title = item.metadata.title.slice(0, 200);
        document.metadata.crawler = "firecrawl";
        pages.push({ document, url: url.href, bytes });
      }
      if (!status.next) break;
      if (typeof status.next !== "string" || cursors.size >= 100)
        throw new KnowledgeError("FIRECRAWL_INVALID_RESPONSE");
      const next = new URL(status.next, origin);
      if (
        next.origin !== origin ||
        next.pathname !== "/v2/crawl/" + jobId ||
        next.username ||
        next.password ||
        next.hash ||
        cursors.has(next.href)
      )
        throw new KnowledgeError("FIRECRAWL_INVALID_CURSOR");
      cursors.add(next.href);
      status = await request(next.pathname + next.search);
    }
    if (!pages.length) throw new KnowledgeError("NO_WEBSITE_PAGES");
    completed = true;
    return pages;
  } finally {
    if (jobId && !completed) {
      try {
        await request(
          "/v2/crawl/" + jobId,
          "DELETE",
          undefined,
          AbortSignal.timeout(5000),
        );
      } catch {
        /* Never mask the original failure. */
      }
    }
  }
}
