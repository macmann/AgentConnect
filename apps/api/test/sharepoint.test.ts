import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createSharePointClient,
  createSharePointAdapter,
} from "../src/sharepoint.js";
import { createMicrosoftGraphClient } from "../src/microsoft-graph-client.js";
import { ConnectorError } from "../src/connector-adapters.js";
import { createSharePointFixture } from "./sharepoint-fixture.js";
const credential = {
  tenantId: randomUUID(),
  clientId: randomUUID(),
  clientSecret: "fixture-secret",
};
const isCode = (code: string) => (e: unknown) =>
  e instanceof ConnectorError && e.code === code;
test("SharePoint resolves a supplied site, lists member libraries and browses folders without following shortcuts", async () => {
  const f = createSharePointFixture(),
    client = createSharePointClient(credential, f.transport),
    signal = AbortSignal.timeout(10000);
  try {
    assert.deepEqual(await client.resolveSite(f.site.webUrl, signal), f.site);
    assert.deepEqual(await client.libraries(f.site.id, signal), [f.library]);
    const root = await client.folders(
      f.site.id,
      f.library.id,
      undefined,
      signal,
    );
    assert.equal(root.folder.id, f.root.id);
    assert.deepEqual(
      root.folders.map((v) => v.id),
      [f.policies.id],
    );
    const nested = await client.folders(
      f.site.id,
      f.library.id,
      f.policies.id,
      signal,
    );
    assert.equal(nested.folder.id, f.policies.id);
    assert.equal(nested.folders.length, 0);
    assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
    assert.ok(
      f.requests
        .filter((r) => r.method === "GET")
        .every(
          (r) =>
            new URL(r.url).hostname === "graph.microsoft.com" &&
            r.authorization === "Bearer sharepoint-fixture-token",
        ),
    );
  } finally {
    client.close();
  }
});
for (const input of [
  "https://unapproved.example/sites/Support",
  "http://fixture.sharepoint.com/sites/Support",
  "https://fixture.sharepoint.com/sites/Support?secret=x",
  "https://fixture.sharepoint.com/sites/Support%2Fescape",
])
  test(`SharePoint rejects invalid site URL ${input}`, async () => {
    const f = createSharePointFixture(),
      client = createSharePointClient(credential, f.transport);
    try {
      await assert.rejects(
        client.resolveSite(input, AbortSignal.timeout(10000)),
        (e: unknown) => e instanceof ConnectorError,
      );
      assert.equal(f.requests.length, 0);
    } finally {
      client.close();
    }
  });
test("SharePoint rejects mismatched site identity and libraries outside the selected site", async () => {
  const f = createSharePointFixture(),
    client = createSharePointClient(credential, f.transport),
    signal = AbortSignal.timeout(10000);
  try {
    f.state.wrongSite = true;
    await assert.rejects(
      client.resolveSite(f.site.webUrl, signal),
      isCode("CONNECTOR_SITE_MISMATCH"),
    );
    f.state.wrongSite = false;
    f.state.linked = false;
    await assert.rejects(
      client.folders(f.site.id, f.library.id, undefined, signal),
      isCode("CONNECTOR_LIBRARY_UNAVAILABLE"),
    );
    assert.ok(!f.requests.some((r) => r.url.includes("/root")));
  } finally {
    client.close();
  }
});
test("SharePoint discovery bounds library inventory before returning partial results", async () => {
  const f = createSharePointFixture(),
    client = createSharePointClient(credential, f.transport);
  try {
    f.state.libraryCount = 101;
    await assert.rejects(
      client.libraries(f.site.id, AbortSignal.timeout(10000)),
      isCode("CONNECTOR_DISCOVERY_LIMIT"),
    );
  } finally {
    client.close();
  }
});
for (const next of [
  "https://unapproved.example/leak",
  "https://graph.microsoft.com/v1.0/sites/foreign/drives",
  "https://graph.microsoft.com/v1.0/drives/foreign/items/root-folder/children",
])
  test(`SharePoint refuses foreign discovery pagination ${next}`, async () => {
    const f = createSharePointFixture(),
      client = createSharePointClient(credential, f.transport),
      signal = AbortSignal.timeout(10000);
    try {
      f.state.libraryNext = next;
      await assert.rejects(
        client.libraries(f.site.id, signal),
        isCode("CONNECTOR_INVALID_LISTING"),
      );
      assert.ok(!f.requests.some((r) => r.url === next));
    } finally {
      client.close();
    }
  });
test("SharePoint rejects looping folder pagination and invalid parents", async () => {
  const f = createSharePointFixture(),
    client = createSharePointClient(credential, f.transport),
    signal = AbortSignal.timeout(10000);
  try {
    f.state.folderNext = `https://graph.microsoft.com/v1.0/drives/${f.library.id}/items/${f.root.id}/children?$skiptoken=repeat`;
    await assert.rejects(
      client.folders(f.site.id, f.library.id, undefined, signal),
      isCode("CONNECTOR_INVALID_LISTING"),
    );
    f.state.folderNext = "";
    f.state.wrongParent = true;
    await assert.rejects(
      client.folders(f.site.id, f.library.id, f.policies.id, signal),
      isCode("CONNECTOR_INVALID_LISTING"),
    );
  } finally {
    client.close();
  }
});
test("SharePoint adapter reuses one Graph token and verifies site membership before document sync", async () => {
  const f = createSharePointFixture(),
    adapter = createSharePointAdapter(
      {
        siteId: f.site.id,
        driveId: f.library.id,
        folderId: f.policies.id,
        recursive: true,
        maxObjects: 10,
      },
      credential,
      f.transport,
    ),
    signal = AbortSignal.timeout(10000);
  try {
    const [document] = await adapter.list(signal);
    assert.equal(document!.url, f.policies.webUrl + "/policy.txt");
    assert.equal(
      Buffer.from(await adapter.read(document!, signal)).toString(),
      f.state.content,
    );
    assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
    f.state.linked = false;
    await assert.rejects(
      adapter.list(signal),
      isCode("CONNECTOR_LIBRARY_UNAVAILABLE"),
    );
  } finally {
    adapter.close();
  }
});
test("Graph client rejects arbitrary credential destinations before transport", async () => {
  const f = createSharePointFixture(),
    graph = createMicrosoftGraphClient(credential, f.transport);
  try {
    await assert.rejects(
      graph.get("https://unapproved.example/leak", AbortSignal.timeout(10000)),
      isCode("CONNECTOR_INVALID_LISTING"),
    );
    assert.equal(f.requests.length, 0);
  } finally {
    graph.close();
  }
});
