import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  validateWebsite,
  fetchWebsitePage,
} from "../src/knowledge-websites.js";
import { validateEndpoint } from "@agentconnect/provider-sdk";
import { config } from "../src/config.js";
const code = (expected: string) => (error: unknown) =>
  (error as { code?: string }).code === expected;
test("Crawl URLs accept arbitrary public HTTPS domains with an empty or stale legacy allowlist", () => {
  const previous = config.KNOWLEDGE_ALLOWED_HOSTS;
  try {
    for (const legacy of ["", "different.example"]) {
      config.KNOWLEDGE_ALLOWED_HOSTS = legacy;
      for (const url of [
        "https://example.com/help?q=refund#section",
        "https://www.example.com/",
        "https://another-customer.example:8443/docs",
      ]) {
        assert.equal(validateWebsite(url).host, new URL(url).host);
      }
    }
  } finally {
    config.KNOWLEDGE_ALLOWED_HOSTS = previous;
  }
  assert.throws(
    () => validateEndpoint("https://example.com", []),
    code("ENDPOINT_NOT_ALLOWED"),
  );
});
test("Public URL selection still blocks local, private, metadata, IPv6, non-HTTPS and credential-bearing targets", async () => {
  for (const host of [
    "localhost",
    "localhost.",
    "app.localhost",
    "service.local",
    "service.internal",
    "127.0.0.1",
    "127.1",
    "2130706433",
    "0x7f000001",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.200",
    "[::1]",
    "[::ffff:127.0.0.1]",
  ]) {
    assert.throws(
      () => validateWebsite(`https://${host}/`),
      code("PRIVATE_ENDPOINT_BLOCKED"),
    );
    await assert.rejects(
      () => fetchWebsitePage(`https://${host}/`, AbortSignal.timeout(1000)),
      code("PRIVATE_ENDPOINT_BLOCKED"),
    );
  }
  for (const url of [
    "http://example.com/",
    "ftp://example.com/",
    "file:///etc/passwd",
  ]) {
    assert.throws(() => validateWebsite(url));
  }
  assert.throws(() => validateWebsite("https://user:password@example.com/"));
});

test("Public-looking hostnames resolving to private addresses are rejected before transport access", async () => {
  const { default: dns } = await import("node:dns/promises");
  const { syncBuiltinESMExports } = await import("node:module");
  const lookup = mock.method(
    dns,
    "lookup",
    async () => [{ address: "127.0.0.1", family: 4 }] as never,
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      () =>
        fetchWebsitePage(
          "https://rebinding.example/",
          AbortSignal.timeout(1000),
        ),
      code("PRIVATE_ENDPOINT_BLOCKED"),
    );
    assert.equal(lookup.mock.callCount(), 1);
  } finally {
    lookup.mock.restore();
    syncBuiltinESMExports();
  }
});
