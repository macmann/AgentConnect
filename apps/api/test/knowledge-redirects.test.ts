import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { crawlWebsite, fetchWebsitePage } from "../src/knowledge-websites.js";
import { config } from "../src/config.js";
const previous = config.KNOWLEDGE_PRIVATE_HOSTS,
  visited: string[] = [];
const server = createServer((req, res) => {
  const path = req.url!;
  visited.push(path);
  if (path === "/robots.txt") {
    res
      .writeHead(200, { "content-type": "text/plain" })
      .end("User-agent: *\nDisallow: /private\n");
    return;
  }
  const redirects: Record<string, string> = {
    "/": "/en/",
    "/en/child": "details",
    "/loop-a": "/loop-b",
    "/loop-b": "/loop-a",
    "/outside": "https://unapproved.example/",
    "/jump-private": "/private",
    "/jump-blocked": "/blocked",
    "/credential-redirect": `http://user:password@${req.headers.host}/en/`,
  };
  if (path.startsWith("/chain/")) {
    res
      .writeHead(302, {
        location: "/chain/" + (Number(path.split("/").at(-1)) + 1),
      })
      .end();
    return;
  }
  if (redirects[path]) {
    res
      .writeHead(path === "/en/child" ? 307 : 301, {
        location: redirects[path],
      })
      .end();
    return;
  }
  res
    .writeHead(200, { "content-type": "text/html" })
    .end(
      path === "/en/"
        ? '<html><title>Bank help</title><body><main>Approved bank guidance. <a href="child">Details</a></main></body></html>'
        : "<html><body><main>Detailed approved guidance.</main></body></html>",
    );
});
let root = "";
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  root = "http://" + host;
  config.KNOWLEDGE_PRIVATE_HOSTS = previous + "," + host;
});
after(async () => {
  config.KNOWLEDGE_PRIVATE_HOSTS = previous;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const settings = (path = "/") => ({
  url: root + path,
  maxPages: 3,
  maxDepth: 2,
  allowedPaths: ["/"],
  blockedPaths: [],
});
const code = (expected: string) => (e: unknown) =>
  (e as { code?: string }).code === expected;
test("Same-origin redirects ingest the landing page and resolve relative links against its final URL", async () => {
  const pages = await crawlWebsite(settings(), AbortSignal.timeout(5000));
  assert.equal(pages.length, 2);
  assert.equal(pages[0]!.url, root + "/en/");
  assert.equal(pages[0]!.document.metadata.redirectedFrom, root + "/");
  assert.equal(pages[1]!.url, root + "/en/details");
  assert.ok(visited.includes("/en/child"));
  assert.ok(!visited.includes("/child"));
});
test("Redirect loops and long chains stop after bounded requests", async () => {
  const count = visited.length;
  await assert.rejects(
    fetchWebsitePage(root + "/loop-a", AbortSignal.timeout(5000)),
    code("WEBSITE_REDIRECT_LIMIT"),
  );
  assert.equal(visited.length - count, 2);
  const start = visited.length;
  await assert.rejects(
    fetchWebsitePage(root + "/chain/0", AbortSignal.timeout(5000)),
    code("WEBSITE_REDIRECT_LIMIT"),
  );
  assert.equal(visited.length - start, 6);
});
test("Redirects cannot cross origins or carry credentials, and never reach blocked or robots-denied paths", async () => {
  for (const path of ["/outside", "/credential-redirect"])
    await assert.rejects(
      crawlWebsite(settings(path), AbortSignal.timeout(5000)),
      code("WEBSITE_REDIRECT_BLOCKED"),
    );
  await assert.rejects(
    crawlWebsite(settings("/jump-private"), AbortSignal.timeout(5000)),
    code("ROBOTS_DISALLOWED"),
  );
  await assert.rejects(
    crawlWebsite(
      { ...settings("/jump-blocked"), blockedPaths: ["/blocked"] },
      AbortSignal.timeout(5000),
    ),
    code("WEBSITE_PATH_BLOCKED"),
  );
  assert.ok(!visited.includes("/private"));
  assert.ok(!visited.includes("/blocked"));
});
