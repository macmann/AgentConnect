import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createHash, createVerify } from "node:crypto";
import { createGoogleDriveAdapter } from "../src/google-drive-adapter.js";
import { ConnectorError } from "../src/connector-adapters.js";
import { type safeHttpTransport } from "@agentconnect/provider-sdk";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const credential = {
  client_email: "fixture@project.iam.gserviceaccount.com",
  private_key: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
};
const content = Buffer.from("Refunds within 30 days.");
const file = {
  id: "file",
  name: "policy.txt",
  mimeType: "text/plain",
  version: "1",
  modifiedTime: "2026-10-10T00:00:00Z",
  parents: ["root"],
  trashed: false,
  size: String(content.length),
  md5Checksum: createHash("md5").update(content).digest("hex"),
};
const root = {
  ...file,
  id: "root",
  name: "Policies",
  mimeType: "application/vnd.google-apps.folder",
  parents: [],
};
type Transport = ReturnType<typeof safeHttpTransport>;
function response(value: unknown, status = 200) {
  return {
    status,
    headers: {},
    body: (async function* () {
      yield Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    })(),
    close: async () => {},
  };
}
function fixture(
  options: {
    incomplete?: boolean;
    cycle?: boolean;
    changed?: boolean;
    denied?: boolean;
    native?: boolean;
    oversized?: boolean;
    corrupt?: boolean;
  } = {},
) {
  let tokens = 0,
    reads = 0,
    metadataCalls = 0;
  const requested: string[] = [];
  const document = options.native
    ? {
        ...file,
        mimeType: "application/vnd.google-apps.document",
        name: "Policy",
        size: undefined,
        md5Checksum: undefined,
      }
    : file;
  const transport: Transport = async (raw, headers, body, signal, method) => {
    signal.throwIfAborted();
    const u = new URL(raw);
    requested.push(raw);
    if (u.hostname === "oauth2.googleapis.com") {
      assert.equal(method, "POST");
      assert.equal(
        headers["content-type"],
        "application/x-www-form-urlencoded",
      );
      const assertion = new URLSearchParams(String(body)).get("assertion")!;
      const [head, payload, signature] = assertion.split(".");
      assert.ok(
        createVerify("RSA-SHA256")
          .update(head + "." + payload)
          .verify(publicKey, signature!, "base64url"),
      );
      const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
      assert.equal(
        claims.scope,
        "https://www.googleapis.com/auth/drive.readonly",
      );
      assert.equal(claims.iss, credential.client_email);
      assert.equal(claims.sub, undefined);
      tokens++;
      return response({
        access_token: "fixture-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    assert.equal(method, "GET");
    assert.equal(headers.authorization, "Bearer fixture-token");
    if (options.denied)
      return response({ error: "secret provider response" }, 403);
    if (u.pathname.endsWith("/files/root")) return response(root);
    if (u.pathname.endsWith("/files")) {
      assert.equal(
        u.searchParams.get("q"),
        "'root' in parents and trashed = false",
      );
      return response({
        files: u.searchParams.has("pageToken") ? [] : [document],
        incompleteSearch: !!options.incomplete,
        ...(options.cycle ? { nextPageToken: "same" } : {}),
      });
    }
    if (
      u.searchParams.get("alt") === "media" ||
      u.pathname.endsWith("/export")
    ) {
      reads++;
      if (options.native)
        assert.equal(u.searchParams.get("mimeType"), "text/plain");
      return response(
        options.oversized
          ? Buffer.alloc(10000001)
          : options.corrupt
            ? Buffer.from("wrong")
            : content,
      );
    }
    metadataCalls++;
    return response({
      ...document,
      version: options.changed && metadataCalls > 1 ? "2" : "1",
    });
  };
  const adapter = createGoogleDriveAdapter(
    { folderId: "root", recursive: true, maxObjects: 100 },
    credential,
    transport,
  );
  return { adapter, transport, stats: () => ({ tokens, reads, requested }) };
}
test("Drive signs read-only service-account JWT, reuses token, checks binary checksum and provenance", async () => {
  const f = fixture(),
    signal = AbortSignal.timeout(10000);
  try {
    const docs = await f.adapter.list(signal);
    assert.equal(docs[0]!.url, "https://drive.google.com/file/d/file/view");
    assert.deepEqual(await f.adapter.read(docs[0]!, signal), content);
    assert.equal(f.stats().tokens, 1);
    assert.equal(f.stats().reads, 1);
  } finally {
    f.adapter.close();
  }
});
test("native Google Docs export without reported byte size", async () => {
  const f = fixture({ native: true }),
    signal = AbortSignal.timeout(10000);
  try {
    const [doc] = await f.adapter.list(signal);
    assert.equal(doc!.filename, "Policy.txt");
    assert.equal(doc!.size, undefined);
    assert.deepEqual(await f.adapter.read(doc!, signal), content);
  } finally {
    f.adapter.close();
  }
});
for (const [options, code] of [
  [{ incomplete: true }, "CONNECTOR_INCOMPLETE_LISTING"],
  [{ cycle: true }, "CONNECTOR_INVALID_LISTING"],
  [{ denied: true }, "CONNECTOR_ACCESS_DENIED"],
] as const)
  test(`Drive rejects ${code} without exposing response bodies`, async () => {
    const f = fixture(options);
    try {
      await assert.rejects(
        f.adapter.list(AbortSignal.timeout(10000)),
        (e: unknown) =>
          e instanceof ConnectorError &&
          e.code === code &&
          !e.message.includes("secret"),
      );
    } finally {
      f.adapter.close();
    }
  });
for (const [options, code] of [
  [{ changed: true }, "CONNECTOR_OBJECT_CHANGED"],
  [{ corrupt: true }, "CONNECTOR_OBJECT_CHANGED"],
  [{ oversized: true }, "CONNECTOR_OBJECT_LIMIT"],
] as const)
  test(`Drive download rejects ${JSON.stringify(options)}`, async () => {
    const f = fixture(options),
      signal = AbortSignal.timeout(10000);
    try {
      const [doc] = await f.adapter.list(signal);
      await assert.rejects(
        f.adapter.read(doc!, signal),
        (e: unknown) => e instanceof ConnectorError && e.code === code,
      );
    } finally {
      f.adapter.close();
    }
  });
test("recursive Drive inventory stays bounded and skips shortcuts", async () => {
  const visited: string[] = [];
  const transport: Transport = async (raw) => {
    const u = new URL(raw);
    if (u.hostname === "oauth2.googleapis.com")
      return response({
        access_token: "fixture",
        token_type: "Bearer",
        expires_in: 3600,
      });
    if (u.pathname.endsWith("/root")) return response(root);
    visited.push(u.searchParams.get("q")!);
    return response({
      files: u.searchParams.get("q")!.includes("'root'")
        ? [
            { ...root, id: "child", parents: ["root"] },
            {
              ...file,
              id: "shortcut",
              mimeType: "application/vnd.google-apps.shortcut",
            },
          ]
        : [{ ...file, parents: ["child"] }],
    });
  };
  const adapter = createGoogleDriveAdapter(
    { folderId: "root", recursive: true, maxObjects: 3 },
    credential,
    transport,
  );
  try {
    assert.equal((await adapter.list(AbortSignal.timeout(10000))).length, 1);
    assert.equal(visited.length, 2);
  } finally {
    adapter.close();
  }
  const limited = createGoogleDriveAdapter(
    { folderId: "root", recursive: true, maxObjects: 2 },
    credential,
    transport,
  );
  try {
    await assert.rejects(
      limited.list(AbortSignal.timeout(10000)),
      (e: unknown) =>
        e instanceof ConnectorError && e.code === "CONNECTOR_SOURCE_LIMIT",
    );
  } finally {
    limited.close();
  }
});
