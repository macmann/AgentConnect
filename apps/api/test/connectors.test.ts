import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest } from "../src/security.js";
import { processConnectorSync } from "../src/connector-worker.js";
import {
  createSourceAdapter,
  ConnectorError,
  type AdapterFactory,
  type ConnectorRow,
} from "../src/connector-adapters.js";
import { createOneDriveAdapter } from "../src/onedrive-adapter.js";
import {
  oneDriveCredential,
  oneDriveSelection,
} from "@agentconnect/schemas/connectors";
import { createGoogleDriveAdapter } from "../src/google-drive-adapter.js";
import {
  googleDriveCredential,
  googleDriveSelection,
} from "@agentconnect/schemas/connectors";
import { connectorCredentials } from "../src/connector-adapters.js";
import { processKnowledgeJob } from "../src/ingestion.js";
import { cleanupKnowledgeFixtures } from "./knowledge-cleanup.mjs";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const originalPrivate = config.CONNECTOR_PRIVATE_HOSTS;
const originalAllowed = config.CONNECTOR_ALLOWED_HOSTS;
config.CONNECTOR_PRIVATE_HOSTS = new URL(config.S3_ENDPOINT).host;
const org = randomUUID(),
  workspace = randomUUID(),
  bucket = "connector-" + randomUUID(),
  prefix = "documents with spaces/",
  remoteKey = prefix + "policy.txt";
const storage = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  },
});
const sessions: Record<string, string> = {},
  users: string[] = [];
let kbId = "",
  secretId = "",
  connectorId = "",
  sourceId = "";
const embedding = () => ({
    async embed(texts: string[]) {
      return texts.map(() => [1, 0.3, 0.2]);
    },
  }),
  app = await buildApp({ embeddingFactory: embedding });
const base = `/workspaces/${workspace}`;
async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
  role = "owner",
) {
  return app.inject({
    method,
    url,
    remoteAddress: "127.0.0.9",
    headers: {
      cookie: sessions[role],
      origin: config.WEB_ORIGIN,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    payload: body ? JSON.stringify(body) : undefined,
  });
}
const selection = {
  endpoint: config.S3_ENDPOINT,
  region: "us-east-1",
  bucket,
  prefix,
  maxObjects: 10,
};
async function queue(cid = connectorId, role = "owner") {
  const r = await call(
    "POST",
    base + "/connectors/" + cid + "/sync",
    undefined,
    role,
  );
  assert.equal(r.statusCode, 202, r.body);
  return r.json().id as string;
}
async function run(id: string) {
  const [r] = await sql`SELECT * FROM connector_syncs WHERE id=${id}`;
  return r!;
}
async function connector() {
  const [c] = await sql<
    ConnectorRow[]
  >`SELECT * FROM enterprise_connectors WHERE id=${connectorId}`;
  return c!;
}
before(async () => {
  await storage.send(new CreateBucketCommand({ Bucket: bucket }));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Connector fixtures')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Connector workspace')`;
    for (const role of ["owner", "builder", "analyst", "outsider"]) {
      const uid = randomUUID(),
        raw = randomUUID();
      users.push(uid);
      sessions[role] = "session=" + raw;
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${uid},${uid + "@example.com"},${role},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(raw)},${uid},now()+interval '1 hour')`;
      if (role !== "outsider")
        await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${role === "owner" ? null : workspace},${uid},${role})`;
    }
  });
  const model = await call("POST", base + "/embedding-models", {
    name: "Fixture embeddings",
    provider: "openai-compatible",
    modelId: "fixture",
    baseUrl: "https://api.openai.com/v1",
    dimensions: 3,
  });
  assert.equal(model.statusCode, 201, model.body);
  const kb = await call("POST", base + "/knowledge-bases", {
    name: "S3 knowledge",
    embeddingModelId: model.json().id,
  });
  assert.equal(kb.statusCode, 201, kb.body);
  kbId = kb.json().id;
  assert.equal(
    (
      await call("POST", base + "/secrets", {
        name: "S3_CREDENTIAL",
        value: JSON.stringify({
          accessKeyId: config.S3_ACCESS_KEY,
          secretAccessKey: config.S3_SECRET_KEY,
        }),
      })
    ).statusCode,
    201,
  );
  secretId = (await call("GET", base + "/secrets")).json()[0].id;
  const c = await call("POST", base + "/connectors", {
    name: "S3 files",
    kind: "s3",
    knowledgeBaseId: kbId,
    secretId,
    selection,
  });
  assert.equal(c.statusCode, 201, c.body);
  connectorId = c.json().id;
});
after(async () => {
  const objects =
    (await storage.send(new ListObjectsV2Command({ Bucket: bucket })))
      .Contents ?? [];
  if (objects.length)
    await storage.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objects.map((o) => ({ Key: o.Key! })) },
      }),
    );
  await storage.send(new DeleteBucketCommand({ Bucket: bucket }));
  storage.destroy();
  await cleanupKnowledgeFixtures(sql, org);
  await sql.begin(async (tx) => {
    for (const table of [
      "connector_items",
      "connector_syncs",
      "enterprise_connectors",
      "knowledge_jobs",
      "knowledge_documents",
      "knowledge_sources",
      "knowledge_bases",
      "embedding_models",
      "secrets",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    for (const uid of users) await tx`DELETE FROM users WHERE id=${uid}`;
  });
  config.CONNECTOR_PRIVATE_HOSTS = originalPrivate;
  config.CONNECTOR_ALLOWED_HOSTS = originalAllowed;
  await app.close();
});
test("connector registration enforces roles, credentials and endpoint approval", async () => {
  assert.equal(
    (await call("GET", base + "/connectors", undefined, "outsider")).statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "POST",
        base + "/connectors",
        {
          name: "Denied",
          kind: "s3",
          knowledgeBaseId: kbId,
          secretId,
          selection,
        },
        "builder",
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call("POST", base + "/connectors", {
        name: "Unsafe",
        kind: "s3",
        knowledgeBaseId: kbId,
        secretId,
        selection: { ...selection, endpoint: "http://169.254.169.254" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call("POST", base + "/connectors", {
        name: "Foreign",
        kind: "s3",
        knowledgeBaseId: randomUUID(),
        secretId,
        selection,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await call("GET", base + "/connectors", undefined, "analyst")).statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "POST",
        base + "/connectors/" + connectorId + "/sync",
        undefined,
        "analyst",
      )
    ).statusCode,
    403,
  );
  const listed = (await call("GET", base + "/connectors")).body;
  assert.ok(!listed.includes(config.S3_SECRET_KEY));
});
test("real S3 adapter lists and reads signed prefix queries; sync ingests retrievable documents", async () => {
  await storage.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: remoteKey,
      Body: "Refunds are available within 30 days.",
    }),
  );
  await storage.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: "outside.txt",
      Body: "Outside prefix",
    }),
  );
  await storage.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: prefix + "image.png",
      Body: "Not a supported document",
    }),
  );
  const adapter = await createSourceAdapter(await connector());
  try {
    const listed = await adapter.list(AbortSignal.timeout(10000));
    assert.equal(listed.length, 2);
    const doc = listed.find((d) => d.key === remoteKey)!;
    assert.equal(
      Buffer.from(
        await adapter.read(doc, AbortSignal.timeout(10000)),
      ).toString(),
      "Refunds are available within 30 days.",
    );
  } finally {
    adapter.close();
  }
  const job = await queue(connectorId, "builder");
  assert.equal(await processConnectorSync(), true);
  const r = await run(job);
  assert.equal(r.status, "completed", r.error_code);
  assert.equal(r.counts.imported, 1);
  assert.equal(r.counts.skipped, 1);
  const [item] =
    await sql`SELECT source_id FROM connector_items WHERE connector_id=${connectorId}`;
  sourceId = item!.source_id;
  assert.equal(await processKnowledgeJob(embedding), true);
  const search = await call("POST", `/knowledge-bases/${kbId}/search`, {
    query: "refund 30 days",
    mode: "hybrid",
  });
  assert.equal(search.statusCode, 200, search.body);
  assert.equal(search.json().results[0].sourceId, sourceId);
  assert.equal(
    search.json().results[0].sourceUrl,
    `s3://${bucket}/${remoteKey}`,
  );
});
test("incremental sync skips unchanged objects and updates changed source revisions", async () => {
  let job = await queue();
  await processConnectorSync();
  assert.equal((await run(job)).counts.unchanged, 1);
  await storage.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: remoteKey,
      Body: "Refunds are available within 60 days.",
    }),
  );
  job = await queue();
  await processConnectorSync();
  assert.equal((await run(job)).counts.updated, 1);
  const [source] =
    await sql`SELECT revision,status FROM knowledge_sources WHERE id=${sourceId}`;
  assert.equal(source!.revision, 2);
  assert.equal(source!.status, "queued");
  await processKnowledgeJob(embedding);
  const search = await call("POST", `/knowledge-bases/${kbId}/search`, {
    query: "refund 60 days",
    mode: "hybrid",
  });
  assert.match(search.json().results[0].content, /60 days/);
});
test("listing failure preserves existing sources and exposes a safe failure code", async () => {
  const job = await queue();
  const factory: AdapterFactory = async () => ({
    async list() {
      throw new ConnectorError("CONNECTOR_SOURCE_LIMIT");
    },
    async read() {
      throw new Error("unexpected read");
    },
    close() {},
  });
  await processConnectorSync(factory);
  assert.equal((await run(job)).error_code, "CONNECTOR_SOURCE_LIMIT");
  const [s] =
    await sql`SELECT status FROM knowledge_sources WHERE id=${sourceId}`;
  assert.equal(s!.status, "ready");
});
test("real S3 listing limits fail before applying removals", async () => {
  const job = await queue();
  await processConnectorSync(async (c) =>
    createSourceAdapter({ ...c, selection: { ...selection, maxObjects: 1 } }),
  );
  assert.equal((await run(job)).error_code, "CONNECTOR_SOURCE_LIMIT");
  const [source] =
    await sql`SELECT status FROM knowledge_sources WHERE id=${sourceId}`;
  assert.equal(source!.status, "ready");
});
test("deleted managed sources are recreated under a fresh storage prefix", async () => {
  const previous = sourceId;
  assert.equal(
    (await call("DELETE", `/knowledge-bases/${kbId}/sources/${sourceId}`))
      .statusCode,
    200,
  );
  const job = await queue();
  await processConnectorSync();
  assert.equal((await run(job)).counts.imported, 1);
  const [item] =
    await sql`SELECT source_id FROM connector_items WHERE connector_id=${connectorId}`;
  sourceId = item!.source_id;
  assert.notEqual(sourceId, previous);
  await processKnowledgeJob(embedding);
  const [source] =
    await sql`SELECT status FROM knowledge_sources WHERE id=${sourceId}`;
  assert.equal(source!.status, "ready");
});
test("If-Match prevents importing a changed object after listing", async () => {
  const adapter = await createSourceAdapter(await connector());
  try {
    const doc = (await adapter.list(AbortSignal.timeout(10000))).find(
      (d) => d.key === remoteKey,
    )!;
    await storage.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: remoteKey,
        Body: "Changed after listing",
      }),
    );
    await assert.rejects(
      adapter.read(doc, AbortSignal.timeout(10000)),
      (e: unknown) =>
        e instanceof ConnectorError && e.code === "CONNECTOR_OBJECT_CHANGED",
    );
  } finally {
    adapter.close();
  }
});
test("remote removal deletes only connector-managed sources after complete listing", async () => {
  const manual = await call("POST", `/knowledge-bases/${kbId}/text`, {
    title: "Manual note",
    text: "Keep this separate curated source.",
  });
  assert.equal(manual.statusCode, 202, manual.body);
  await storage.send(
    new DeleteObjectCommand({ Bucket: bucket, Key: remoteKey }),
  );
  const job = await queue();
  await processConnectorSync();
  assert.equal((await run(job)).counts.removed, 1);
  const [old] =
    await sql`SELECT status FROM knowledge_sources WHERE id=${sourceId}`;
  assert.equal(old!.status, "deleted");
  const [saved] =
    await sql`SELECT status FROM knowledge_sources WHERE id=${manual.json().id}`;
  assert.notEqual(saved!.status, "deleted");
});
test("pending syncs are exclusive, cancellation prevents provider calls", async () => {
  const job = await queue();
  assert.equal(
    (await call("POST", base + "/connectors/" + connectorId + "/sync"))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await call(
        "POST",
        base + "/connectors/" + connectorId + "/syncs/" + job + "/cancel",
      )
    ).statusCode,
    200,
  );
  let called = false;
  await processConnectorSync(async (c) => {
    called = true;
    return createSourceAdapter(c);
  });
  assert.equal(called, false);
  assert.equal((await run(job)).status, "cancelled");
});
test("schedules queue due connectors; stale updates and paused syncs are rejected", async () => {
  const c = await connector();
  const update = await call("PUT", base + "/connectors/" + connectorId, {
    revision: c.revision,
    name: "Scheduled source",
    maxObjects: 20,
    secretId,
    enabled: true,
    scheduleMinutes: 15,
  });
  assert.equal(update.statusCode, 200, update.body);
  assert.equal(
    ((await connector()).selection as { maxObjects: number }).maxObjects,
    20,
  );
  assert.equal(
    (
      await call("PUT", base + "/connectors/" + connectorId, {
        revision: c.revision,
        name: "Stale",
        secretId,
        enabled: false,
        scheduleMinutes: null,
      })
    ).statusCode,
    409,
  );
  await sql`UPDATE enterprise_connectors SET next_sync_at=now()-interval '1 second' WHERE id=${connectorId}`;
  await processConnectorSync();
  const [latest] =
    await sql`SELECT status FROM connector_syncs WHERE connector_id=${connectorId} ORDER BY created_at DESC LIMIT 1`;
  assert.equal(latest!.status, "completed");
  const current = await connector();
  assert.equal(
    (
      await call("PUT", base + "/secrets/" + secretId, {
        value: "invalid credential JSON",
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call("PUT", base + "/connectors/" + connectorId, {
        revision: current.revision,
        name: "Paused source",
        secretId,
        enabled: false,
        scheduleMinutes: null,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await call("POST", base + "/connectors/" + connectorId + "/sync"))
      .statusCode,
    409,
  );
  const paused = await connector();
  assert.equal(
    (
      await call("PUT", base + "/connectors/" + connectorId, {
        revision: paused.revision,
        name: paused.id,
        secretId,
        enabled: true,
        scheduleMinutes: null,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await call("PUT", base + "/secrets/" + secretId, {
        value: JSON.stringify({
          accessKeyId: config.S3_ACCESS_KEY,
          secretAccessKey: config.S3_SECRET_KEY,
        }),
      })
    ).statusCode,
    200,
  );
});
test("expired final leases and lost requester permission terminate syncs", async () => {
  const c = await connector();
  await call("PUT", base + "/connectors/" + connectorId, {
    revision: c.revision,
    name: "Active source",
    secretId,
    enabled: true,
    scheduleMinutes: null,
  });
  let job = await queue();
  await sql`UPDATE connector_syncs SET status='running',attempts=3,lease_until=now()-interval '1 second' WHERE id=${job}`;
  await processConnectorSync();
  assert.equal((await run(job)).error_code, "CONNECTOR_RETRY_LIMIT");
  job = await queue(connectorId, "builder");
  await sql`UPDATE memberships SET role='viewer' WHERE workspace_id=${workspace} AND role='builder'`;
  await processConnectorSync();
  assert.equal((await run(job)).status, "failed");
});
test("disconnect retains imported knowledge and releases the credential reference", async () => {
  assert.equal(
    (await call("DELETE", base + "/secrets/" + secretId)).statusCode,
    409,
  );
  const sources =
    await sql`SELECT id FROM knowledge_sources WHERE knowledge_base_id=${kbId} AND status<>'deleted'`;
  assert.equal(
    (await call("DELETE", base + "/connectors/" + connectorId)).statusCode,
    200,
  );
  assert.equal((await call("GET", base + "/connectors")).json().length, 0);
  assert.equal(
    (await call("DELETE", base + "/secrets/" + secretId)).statusCode,
    200,
  );
  for (const source of sources) {
    const [s] =
      await sql`SELECT status FROM knowledge_sources WHERE id=${source.id}`;
    assert.notEqual(s!.status, "deleted");
  }
});

test("Google Drive registration validates provider credentials and native exports enter durable knowledge sync", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const credential = {
    client_email: "fixture@project.iam.gserviceaccount.com",
    private_key: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
  const secret = await call("POST", base + "/secrets", {
    name: "DRIVE_ACCOUNT",
    value: JSON.stringify(credential),
  });
  assert.equal(secret.statusCode, 201, secret.body);
  const sid = (await call("GET", base + "/secrets"))
    .json()
    .find((s: { name: string }) => s.name === "DRIVE_ACCOUNT").id;
  const input = {
    name: "Drive policies",
    kind: "google-drive",
    knowledgeBaseId: kbId,
    secretId: sid,
    selection: { folderId: "root", recursive: true, maxObjects: 10 },
  };
  config.CONNECTOR_ALLOWED_HOSTS = "www.googleapis.com";
  assert.equal(
    (await call("POST", base + "/connectors", input)).statusCode,
    400,
  );
  config.CONNECTOR_ALLOWED_HOSTS = "www.googleapis.com,oauth2.googleapis.com";
  assert.equal(
    (await call("POST", base + "/connectors", input, "analyst")).statusCode,
    403,
  );
  const created = await call("POST", base + "/connectors", input);
  assert.equal(created.statusCode, 201, created.body);
  const cid = created.json().id;
  let visible = true;
  const metadata = {
    id: "policy",
    name: "Drive policy",
    mimeType: "application/vnd.google-apps.document",
    version: "1",
    modifiedTime: "2026-10-10T00:00:00Z",
    parents: ["root"],
    trashed: false,
  };
  const factory: AdapterFactory = async (c) =>
    createGoogleDriveAdapter(
      googleDriveSelection.parse(c.selection),
      googleDriveCredential.parse(await connectorCredentials(c, c.kind)),
      async (raw) => {
        const u = new URL(raw);
        const value =
          u.hostname === "oauth2.googleapis.com"
            ? {
                access_token: "fixture",
                token_type: "Bearer",
                expires_in: 3600,
              }
            : u.pathname.endsWith("/root")
              ? {
                  ...metadata,
                  id: "root",
                  mimeType: "application/vnd.google-apps.folder",
                  parents: [],
                }
              : u.pathname.endsWith("/files")
                ? { files: visible ? [metadata] : [] }
                : u.pathname.endsWith("/export")
                  ? "Drive refunds within 90 days."
                  : metadata;
        return {
          status: 200,
          headers: {},
          body: (async function* () {
            yield Buffer.from(
              typeof value === "string" ? value : JSON.stringify(value),
            );
          })(),
          close: async () => {},
        };
      },
    );
  let job = await queue(cid);
  await processConnectorSync(factory);
  assert.equal((await run(job)).status, "completed");
  assert.equal((await run(job)).counts.imported, 1);
  const [item] =
    await sql`SELECT source_id FROM connector_items WHERE connector_id=${cid}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    await processKnowledgeJob(embedding);
    const [state] =
      await sql`SELECT status FROM knowledge_sources WHERE id=${item!.source_id}`;
    if (state!.status === "ready") break;
  }
  const [source] =
    await sql`SELECT status,source_url FROM knowledge_sources WHERE id=${item!.source_id}`;
  assert.equal(source!.status, "ready");
  assert.equal(
    source!.source_url,
    "https://drive.google.com/file/d/policy/view",
  );
  job = await queue(cid);
  await processConnectorSync(factory);
  assert.equal((await run(job)).counts.unchanged, 1);
  visible = false;
  job = await queue(cid);
  await processConnectorSync(factory);
  assert.equal((await run(job)).counts.removed, 1);
  assert.equal(
    (await call("DELETE", base + "/connectors/" + cid)).statusCode,
    200,
  );
});

test("OneDrive credentials, endpoint grants, durable ingestion and removal use the existing tenant sync pipeline", async () => {
  const credential = {
    tenantId: randomUUID(),
    clientId: randomUUID(),
    clientSecret: "fixture-secret",
  };
  assert.equal(
    (
      await call("POST", base + "/secrets", {
        name: "ONEDRIVE_APP",
        value: JSON.stringify(credential),
      })
    ).statusCode,
    201,
  );
  const sid = (await call("GET", base + "/secrets"))
    .json()
    .find((s: { name: string }) => s.name === "ONEDRIVE_APP").id;
  const input = {
    name: "OneDrive policies",
    kind: "onedrive",
    knowledgeBaseId: kbId,
    secretId: sid,
    selection: {
      driveId: "b!drive",
      folderId: "folder",
      recursive: true,
      maxObjects: 10,
    },
  };
  config.CONNECTOR_ALLOWED_HOSTS = "graph.microsoft.com";
  assert.equal(
    (await call("POST", base + "/connectors", input)).statusCode,
    400,
  );
  config.CONNECTOR_ALLOWED_HOSTS =
    "graph.microsoft.com,login.microsoftonline.com";
  assert.equal(
    (await call("POST", base + "/connectors", input, "analyst")).statusCode,
    403,
  );
  await call("PUT", base + "/secrets/" + sid, {
    value: JSON.stringify({ ...credential, tenantId: "common" }),
  });
  assert.equal(
    (await call("POST", base + "/connectors", input)).statusCode,
    409,
  );
  await call("PUT", base + "/secrets/" + sid, {
    value: JSON.stringify(credential),
  });
  const created = await call("POST", base + "/connectors", input);
  assert.equal(created.statusCode, 201, created.body);
  const cid = created.json().id;
  assert.ok(
    !(await call("GET", base + "/connectors")).body.includes("fixture-secret"),
  );
  let visible = true,
    denied = false;
  const bytes = Buffer.from("OneDrive refunds within 120 days.");
  const item = {
    id: "policy",
    name: "OneDrive policy.txt",
    size: bytes.length,
    eTag: '"etag-1"',
    lastModifiedDateTime: "2026-10-10T00:00:00Z",
    webUrl: "https://fixture-my.sharepoint.com/policy.txt",
    parentReference: { driveId: "b!drive", id: "folder" },
    file: {},
  };
  const factory: AdapterFactory = async (c) =>
    createOneDriveAdapter(
      oneDriveSelection.parse(c.selection),
      oneDriveCredential.parse(await connectorCredentials(c, c.kind)),
      async (raw) => {
        const u = new URL(raw);
        const value =
          u.hostname === "login.microsoftonline.com"
            ? {
                access_token: "fixture",
                token_type: "Bearer",
                expires_in: 3600,
              }
            : u.pathname.endsWith("/drives/b!drive")
              ? { id: "b!drive", driveType: "business" }
              : u.pathname.endsWith("/items/folder")
                ? { ...item, id: "folder", file: undefined, folder: {} }
                : u.pathname.endsWith("/children")
                  ? { value: visible ? [item] : [] }
                  : u.pathname.endsWith("/content")
                    ? bytes
                    : item;
        return {
          status:
            denied && u.hostname !== "login.microsoftonline.com" ? 403 : 200,
          headers: {},
          body: (async function* () {
            yield Buffer.isBuffer(value)
              ? value
              : Buffer.from(JSON.stringify(value));
          })(),
          close: async () => {},
        };
      },
    );
  let job = await queue(cid);
  await processConnectorSync(factory);
  assert.equal((await run(job)).status, "completed");
  assert.equal((await run(job)).counts.imported, 1);
  const [mapped] =
    await sql`SELECT source_id FROM connector_items WHERE connector_id=${cid}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    await processKnowledgeJob(embedding);
    const [state] =
      await sql`SELECT status FROM knowledge_sources WHERE id=${mapped!.source_id}`;
    if (state!.status === "ready") break;
  }
  const [source] =
    await sql`SELECT status,source_url FROM knowledge_sources WHERE id=${mapped!.source_id}`;
  assert.equal(source!.status, "ready");
  assert.equal(source!.source_url, item.webUrl);
  job = await queue(cid);
  await processConnectorSync(factory);
  assert.equal((await run(job)).counts.unchanged, 1);
  denied = true;
  job = await queue(cid);
  await processConnectorSync(factory);
  assert.equal((await run(job)).error_code, "CONNECTOR_ACCESS_DENIED");
  assert.equal(
    (
      await sql`SELECT status FROM knowledge_sources WHERE id=${mapped!.source_id}`
    )[0]!.status,
    "ready",
  );
  denied = false;
  visible = false;
  job = await queue(cid);
  await processConnectorSync(factory);
  assert.equal((await run(job)).counts.removed, 1);
  assert.equal(
    (await call("DELETE", base + "/connectors/" + cid)).statusCode,
    200,
  );
});
