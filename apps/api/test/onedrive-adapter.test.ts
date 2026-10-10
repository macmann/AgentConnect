import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createOneDriveAdapter } from "../src/onedrive-adapter.js";
import { ConnectorError } from "../src/connector-adapters.js";
import { config } from "../src/config.js";
import { type safeHttpTransport } from "@agentconnect/provider-sdk";
type Transport = ReturnType<typeof safeHttpTransport>;
const previousHosts = config.CONNECTOR_ALLOWED_HOSTS;
config.CONNECTOR_ALLOWED_HOSTS =
  "graph.microsoft.com,login.microsoftonline.com,fixture-my.sharepoint.com";
after(() => {
  config.CONNECTOR_ALLOWED_HOSTS = previousHosts;
});
const credential = {
  tenantId: randomUUID(),
  clientId: randomUUID(),
  clientSecret: "fixture+&=secret",
};
const selection = {
  driveId: "b!drive",
  folderId: "root-folder",
  recursive: true,
  maxObjects: 100,
};
const content = Buffer.from("OneDrive policy: refunds within 30 days.");
const file = {
  id: "policy",
  name: "policy.txt",
  size: content.length,
  eTag: '"etag-1"',
  cTag: '"content-1"',
  lastModifiedDateTime: "2026-10-10T00:00:00Z",
  webUrl: "https://fixture-my.sharepoint.com/policy.txt",
  parentReference: { driveId: selection.driveId, id: selection.folderId },
  file: {
    mimeType: "text/plain",
    hashes: { sha256Hash: createHash("sha256").update(content).digest("hex") },
  },
};
const root = {
  ...file,
  id: selection.folderId,
  name: "Policies",
  size: 0,
  file: undefined,
  folder: { childCount: 1 },
  parentReference: { driveId: selection.driveId, id: "parent" },
};
function response(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return {
    status,
    headers,
    body: (async function* () {
      yield Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    })(),
    close: async () => {},
  };
}
function fixture(
  options: {
    redirect?: string;
    changed?: boolean;
    corrupt?: boolean;
    oversized?: boolean;
    nextLink?: string;
    denied?: boolean;
    personal?: boolean;
    expired?: boolean;
    rootLost?: boolean;
    secondRedirect?: boolean;
  } = {},
) {
  let tokens = 0,
    downloads = 0,
    roots = 0,
    metadata = 0;
  const requests: { url: string; authorization?: string }[] = [];
  const transport: Transport = async (raw, headers, body, signal, method) => {
    signal.throwIfAborted();
    const u = new URL(raw);
    requests.push({ url: raw, authorization: headers.authorization });
    if (u.hostname === "login.microsoftonline.com") {
      assert.equal(method, "POST");
      assert.equal(headers.authorization, undefined);
      assert.equal(u.pathname, `/${credential.tenantId}/oauth2/v2.0/token`);
      const form = new URLSearchParams(String(body));
      assert.equal(form.get("client_secret"), credential.clientSecret);
      assert.equal(form.get("client_id"), credential.clientId);
      assert.equal(form.get("scope"), "https://graph.microsoft.com/.default");
      assert.equal(form.get("grant_type"), "client_credentials");
      tokens++;
      return response({
        access_token: "graph-fixture-token",
        token_type: "Bearer",
        expires_in: options.expired ? 1 : 3600,
      });
    }
    assert.equal(method, "GET");
    if (u.hostname !== "graph.microsoft.com") {
      assert.equal(headers.authorization, undefined);
      downloads++;
      return options.secondRedirect
        ? response({}, 302, { location: "https://unapproved.example/leak" })
        : response(content);
    }
    assert.equal(headers.authorization, "Bearer graph-fixture-token");
    if (options.denied)
      return response({ error: { message: "SECRET upstream content" } }, 403);
    if (u.pathname.endsWith("/drives/b!drive"))
      return response({
        id: selection.driveId,
        driveType: options.personal ? "personal" : "business",
      });
    if (u.pathname.endsWith("/items/root-folder")) {
      roots++;
      return options.rootLost && roots > 1 ? response({}, 403) : response(root);
    }
    if (u.pathname.endsWith("/children"))
      return response({
        value: u.searchParams.has("$skiptoken") ? [] : [file],
        ...(options.nextLink ? { "@odata.nextLink": options.nextLink } : {}),
      });
    if (u.pathname.endsWith("/content")) {
      assert.equal(headers["if-match"], file.eTag);
      if (options.redirect)
        return response({}, 302, { location: options.redirect });
      downloads++;
      return response(
        options.oversized
          ? Buffer.alloc(10000001)
          : options.corrupt
            ? Buffer.alloc(content.length, 0)
            : content,
      );
    }
    metadata++;
    return response({
      ...file,
      eTag: options.changed && metadata > 1 ? '"changed"' : file.eTag,
    });
  };
  return {
    adapter: createOneDriveAdapter(selection, credential, transport),
    stats: () => ({ tokens, downloads, requests }),
  };
}
const isCode = (code: string) => (e: unknown) =>
  e instanceof ConnectorError &&
  e.code === code &&
  !e.message.includes("SECRET");
test("OneDrive client credentials stay on the token endpoint; direct download preserves provenance and verifies integrity", async () => {
  const f = fixture(),
    signal = AbortSignal.timeout(10000);
  try {
    const [doc] = await f.adapter.list(signal);
    assert.equal(doc!.url, file.webUrl);
    assert.deepEqual(await f.adapter.read(doc!, signal), content);
    assert.equal(f.stats().tokens, 1);
    assert.equal(f.stats().downloads, 1);
  } finally {
    f.adapter.close();
  }
});
test("OneDrive approved signed redirect strips Graph credentials and never persists the URL", async () => {
  const f = fixture({
      redirect: "https://fixture-my.sharepoint.com/download?tempauth=SECRET",
    }),
    signal = AbortSignal.timeout(10000);
  try {
    const [doc] = await f.adapter.list(signal);
    assert.ok(!JSON.stringify(doc).includes("tempauth"));
    assert.deepEqual(await f.adapter.read(doc!, signal), content);
    assert.equal(f.stats().requests.at(-2)!.authorization, undefined);
  } finally {
    f.adapter.close();
  }
});
test("OneDrive renews near-expiry access tokens", async () => {
  const f = fixture({ expired: true }),
    signal = AbortSignal.timeout(10000);
  try {
    await f.adapter.list(signal);
    assert.ok(f.stats().tokens > 1);
  } finally {
    f.adapter.close();
  }
});
for (const [options, code] of [
  [{ denied: true }, "CONNECTOR_ACCESS_DENIED"],
  [{ personal: true }, "CONNECTOR_DRIVE_UNSUPPORTED"],
  [{ rootLost: true }, "CONNECTOR_ACCESS_DENIED"],
  [
    { nextLink: "https://unapproved.example/?SECRET" },
    "CONNECTOR_INVALID_LISTING",
  ],
  [
    {
      nextLink:
        "https://graph.microsoft.com/v1.0/drives/another/items/root-folder/children",
    },
    "CONNECTOR_INVALID_LISTING",
  ],
  [
    {
      nextLink:
        "https://graph.microsoft.com/v1.0/drives/b!drive/items/root-folder/children?$skiptoken=same",
    },
    "CONNECTOR_INVALID_LISTING",
  ],
] as const)
  test(`OneDrive inventory rejects ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    try {
      await assert.rejects(
        f.adapter.list(AbortSignal.timeout(10000)),
        isCode(code),
      );
    } finally {
      f.adapter.close();
    }
  });
for (const [options, code] of [
  [{ changed: true }, "CONNECTOR_OBJECT_CHANGED"],
  [{ corrupt: true }, "CONNECTOR_OBJECT_CHANGED"],
  [{ oversized: true }, "CONNECTOR_OBJECT_LIMIT"],
  [
    { redirect: "https://unapproved.example/download?SECRET" },
    "CONNECTOR_DOWNLOAD_ENDPOINT_NOT_ALLOWED",
  ],
  [
    { redirect: "http://fixture-my.sharepoint.com/download?SECRET" },
    "CONNECTOR_DOWNLOAD_ENDPOINT_NOT_ALLOWED",
  ],
  [
    { redirect: "https://127.0.0.1/private?SECRET" },
    "CONNECTOR_DOWNLOAD_ENDPOINT_NOT_ALLOWED",
  ],
  [
    {
      redirect: "https://fixture-my.sharepoint.com/download?SECRET",
      secondRedirect: true,
    },
    "CONNECTOR_PROVIDER_ERROR",
  ],
] as const)
  test(`OneDrive download rejects ${JSON.stringify(options)}`, async () => {
    const f = fixture(options),
      signal = AbortSignal.timeout(10000);
    try {
      const [doc] = await f.adapter.list(signal);
      await assert.rejects(f.adapter.read(doc!, signal), isCode(code));
      if (code === "CONNECTOR_DOWNLOAD_ENDPOINT_NOT_ALLOWED")
        assert.equal(
          f
            .stats()
            .requests.filter(
              (r) =>
                new URL(r.url).hostname !== "graph.microsoft.com" &&
                new URL(r.url).hostname !== "login.microsoftonline.com",
            ).length,
          0,
        );
    } finally {
      f.adapter.close();
    }
  });
test("OneDrive recursive inventory includes nested documents, skips remote shortcuts, and bounds every entry", async () => {
  const visited: string[] = [];
  const transport: Transport = async (raw) => {
    const u = new URL(raw);
    if (u.hostname === "login.microsoftonline.com")
      return response({
        access_token: "fixture",
        token_type: "Bearer",
        expires_in: 3600,
      });
    if (u.pathname.endsWith("/drives/b!drive"))
      return response({ id: selection.driveId, driveType: "business" });
    if (u.pathname.endsWith("/items/root-folder")) return response(root);
    visited.push(raw);
    return response({
      value: u.pathname.includes("/items/root-folder/")
        ? [
            {
              ...root,
              id: "nested",
              parentReference: {
                driveId: selection.driveId,
                id: selection.folderId,
              },
            },
            { ...file, id: "shortcut", remoteItem: { id: "external" } },
          ]
        : [
            {
              ...file,
              parentReference: { driveId: selection.driveId, id: "nested" },
            },
          ],
    });
  };
  const adapter = createOneDriveAdapter(
    { ...selection, maxObjects: 3 },
    credential,
    transport,
  );
  try {
    assert.equal((await adapter.list(AbortSignal.timeout(10000))).length, 1);
    assert.equal(visited.length, 2);
  } finally {
    adapter.close();
  }
  const limited = createOneDriveAdapter(
    { ...selection, maxObjects: 2 },
    credential,
    transport,
  );
  try {
    await assert.rejects(
      limited.list(AbortSignal.timeout(10000)),
      isCode("CONNECTOR_SOURCE_LIMIT"),
    );
  } finally {
    limited.close();
  }
  const shallow = createOneDriveAdapter(
    { ...selection, recursive: false },
    credential,
    transport,
  );
  try {
    assert.equal((await shallow.list(AbortSignal.timeout(10000))).length, 0);
  } finally {
    shallow.close();
  }
});
