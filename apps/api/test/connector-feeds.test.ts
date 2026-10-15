import { test } from "node:test";
import assert from "node:assert/strict";
import {
  googleChanges,
  microsoftChanges,
  recoverFeed,
} from "../src/connector-feeds.js";
import { ConnectorError } from "../src/connector-adapters.js";
const signal = () => AbortSignal.timeout(10000);
test("Google change feed bootstraps before inventory and drains change/tombstone pages", async () => {
  const urls: string[] = [];
  const json = async (url: string) => {
    urls.push(url);
    const u = new URL(url);
    return u.pathname.endsWith("startPageToken")
      ? { startPageToken: "one" }
      : u.searchParams.get("pageToken") === "one"
        ? {
            changes: [{ fileId: "deleted", removed: true }],
            nextPageToken: "two",
          }
        : { changes: [], newStartPageToken: "three" };
  };
  assert.deepEqual(await googleChanges(json, signal()), {
    cursor: "one",
    changed: true,
  });
  assert.deepEqual(await googleChanges(json, signal(), "one"), {
    cursor: "three",
    changed: true,
  });
  assert.equal(urls.length, 3);
  assert.deepEqual(
    await googleChanges(
      async () => ({ changes: [], newStartPageToken: "four" }),
      signal(),
      "three",
    ),
    { cursor: "four", changed: false },
  );
});
test("feed expiration recovers once; permission failures do not reset cursors", async () => {
  const cursors: (string | undefined)[] = [];
  const result = await recoverFeed(async (cursor) => {
    cursors.push(cursor);
    if (cursor) throw new ConnectorError("CONNECTOR_CURSOR_EXPIRED");
    return { cursor: "fresh", changed: true };
  }, "expired");
  assert.equal(result.changed, true);
  assert.deepEqual(cursors, ["expired", undefined]);
  await assert.rejects(
    () =>
      recoverFeed(async () => {
        throw new ConnectorError("CONNECTOR_ACCESS_DENIED");
      }, "old"),
    { code: "CONNECTOR_ACCESS_DENIED" },
  );
});
test("Graph delta uses a latest baseline, handles deletes and validates every continuation destination", async () => {
  const base = "https://graph.microsoft.com/v1.0/drives/drive/root/delta";
  const calls: string[] = [];
  assert.deepEqual(
    await microsoftChanges(
      async (url) => {
        calls.push(url);
        return { value: [], "@odata.deltaLink": base + "?token=one" };
      },
      signal(),
      "drive",
    ),
    { cursor: base + "?token=one", changed: true },
  );
  assert.equal(new URL(calls[0]!).searchParams.get("token"), "latest");
  assert.deepEqual(
    await microsoftChanges(
      async () => ({ value: [], "@odata.deltaLink": base + "?token=two" }),
      signal(),
      "drive",
      base + "?token=one",
    ),
    { cursor: base + "?token=two", changed: false },
  );
  assert.equal(
    (
      await microsoftChanges(
        async () => ({
          value: [{ id: "gone", deleted: {} }],
          "@odata.deltaLink": base + "?token=three",
        }),
        signal(),
        "drive",
        base + "?token=two",
      )
    ).changed,
    true,
  );
  for (const url of [
    "https://evil.example/delta",
    base.replace("/drive/", "/other/") + "?token=x",
    base + "#fragment",
  ]) {
    await assert.rejects(
      () =>
        microsoftChanges(
          async () => ({ value: [], "@odata.nextLink": url }),
          signal(),
          "drive",
        ),
      { code: "CONNECTOR_INVALID_LISTING" },
    );
  }
});
test("feed loops, missing terminal cursor and bounded pagination fail closed", async () => {
  await assert.rejects(
    () =>
      googleChanges(
        async () => ({ changes: [], nextPageToken: "loop" }),
        signal(),
        "loop",
      ),
    { code: "CONNECTOR_INVALID_LISTING" },
  );
  await assert.rejects(
    () => googleChanges(async () => ({ changes: [] }), signal(), "x"),
    { code: "CONNECTOR_INVALID_LISTING" },
  );
  let page = 0;
  await assert.rejects(
    () =>
      googleChanges(
        async () => ({ changes: [], nextPageToken: String(page++) }),
        signal(),
        "initial",
      ),
    { code: "CONNECTOR_SOURCE_LIMIT" },
  );
});
