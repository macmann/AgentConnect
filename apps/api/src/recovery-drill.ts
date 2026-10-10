import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { config } from "./config.js";
import { encrypt, decrypt } from "./security.js";
import {
  requiredMigrations,
  supportedVectorVersion,
} from "./release-requirements.js";
import {
  checksum,
  sealRecoveryBundle,
  openRecoveryBundle,
  verifyRecoveryObject,
} from "./recovery-bundle.js";

// Only synthetic data is backed up. Never accept a source or restore database name.
const database = new URL(config.DATABASE_URL);
const storageUrl = new URL(config.S3_ENDPOINT);
const local = (url: URL) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
if (config.NODE_ENV === "production" || !local(database) || !local(storageUrl))
  throw new Error("RECOVERY_DRILL_REQUIRES_LOCAL_NONPRODUCTION_SERVICES");
const suffix = randomUUID().replaceAll("-", "");
const names = [
  `ac_drill_source_${suffix}`,
  `ac_drill_restore_${suffix}`,
] as const;
const buckets = [
  `ac-drill-source-${suffix}`,
  `ac-drill-restore-${suffix}`,
] as const;
const createdDatabases: string[] = [];
const createdBuckets: string[] = [];
const connections: ReturnType<typeof postgres>[] = [];
const objectKeys: string[] = [];
const dockerEnv = { ...process.env };
for (const name of [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
])
  delete dockerEnv[name];
function pg(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "--host=unix:///var/run/docker.sock",
        "compose",
        "exec",
        "-T",
        "postgres",
        ...args,
      ],
      {
        cwd: new URL("../../../", import.meta.url),
        env: dockerEnv,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) child.kill("SIGKILL");
      else chunks.push(chunk);
    });
    // SQL and dump diagnostics can contain row data. Return only a safe operation name.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("RECOVERY_POSTGRES_CLIENT_UNAVAILABLE"));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || size > 64 * 1024 * 1024)
        reject(new Error(`RECOVERY_POSTGRES_OPERATION_FAILED:${args[0]}`));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}
const user = decodeURIComponent(database.username);
const admin = postgres(config.DATABASE_URL, { max: 1, connect_timeout: 5 });
const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  },
  maxAttempts: 1,
  requestHandler: { requestTimeout: 10000, connectionTimeout: 3000 },
});
const started = performance.now();
let failed = false;
let stage = "server-identity";
let report: Record<string, unknown> | undefined;
try {
  // Ensure container dump tools and host SQL connection refer to the same local server.
  const [identity] =
    await admin`SELECT system_identifier::text AS id FROM pg_control_system()`;
  const containerIdentity = await pg([
    "psql",
    "-U",
    user,
    "-d",
    database.pathname.slice(1),
    "-Atc",
    "SELECT system_identifier FROM pg_control_system()",
  ]);
  assert.equal(
    containerIdentity.toString().trim(),
    identity!.id,
    "RECOVERY_SERVER_MISMATCH",
  );
  stage = "create-isolated-targets";
  for (const name of names) {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    createdDatabases.push(name);
    const url = new URL(database);
    url.pathname = `/${name}`;
    connections.push(postgres(url.toString(), { max: 1, connect_timeout: 5 }));
  }
  for (const bucket of buckets) {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    createdBuckets.push(bucket);
  }
  const source = connections[0]!;
  const restored = connections[1]!;
  stage = "apply-schema-and-fixtures";
  const directory = new URL(
    "../../../packages/db/migrations/",
    import.meta.url,
  );
  const files = (await readdir(directory))
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort();
  assert.deepEqual(
    files.map((name) => name.slice(0, 4)),
    requiredMigrations,
  );
  await source`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const file of files) {
    await source.unsafe(await readFile(new URL(file, directory), "utf8"));
    await source`INSERT INTO schema_migrations(version) VALUES (${file.slice(0, 4)})`;
  }
  const userId = randomUUID();
  await source`INSERT INTO users(id,email,name,password_hash) VALUES (${userId},'recovery@example.invalid','Recovery fixture','not-a-password')`;
  const fixtures: {
    org: string;
    workspace: string;
    secretId: string;
    context: string;
    value: string;
    key: string;
    hash: string;
  }[] = [];
  for (let i = 0; i < 2; i++) {
    const org = randomUUID(),
      workspace = randomUUID(),
      secretId = randomUUID();
    const context = `${org}:${workspace}:RECOVERY_PROBE`;
    const value = randomBytes(24).toString("hex");
    const key = `${org}/${workspace}/recovery-probe`;
    const bytes = Buffer.from(`Tenant ${i} recovery fixture`);
    await source`INSERT INTO organizations(id,name) VALUES (${org},${`Recovery tenant ${i}`})`;
    await source`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Recovery workspace')`;
    await source`INSERT INTO secrets(id,organization_id,workspace_id,name,ciphertext,created_by) VALUES (${secretId},${org},${workspace},'RECOVERY_PROBE',${source.json(encrypt(value, context))},${userId})`;
    objectKeys.push(key);
    await s3.send(
      new PutObjectCommand({ Bucket: buckets[0], Key: key, Body: bytes }),
    );
    fixtures.push({
      org,
      workspace,
      secretId,
      context,
      value,
      key,
      hash: checksum(bytes),
    });
  }
  await source`CREATE TABLE recovery_vectors (id integer PRIMARY KEY, embedding vector(3))`;
  await source`INSERT INTO recovery_vectors VALUES (1, '[1,2,3]')`;
  stage = "capture-and-authenticate-backup";
  const snapshotAt = new Date().toISOString();
  const dump = await pg([
    "pg_dump",
    "-U",
    user,
    "-d",
    names[0],
    "-Fc",
    "--no-owner",
    "--no-acl",
  ]);
  const objects = [];
  for (const fixture of fixtures) {
    const result = await s3.send(
      new GetObjectCommand({ Bucket: buckets[0], Key: fixture.key }),
    );
    const bytes = await result.Body!.transformToByteArray();
    verifyRecoveryObject(bytes, fixture.hash);
    objects.push({
      key: fixture.key,
      data: Buffer.from(bytes).toString("base64"),
      hash: fixture.hash,
    });
  }
  // Separate ephemeral archive key; MASTER_KEY is never written into the archive.
  const archiveKey = randomBytes(32);
  const archive = sealRecoveryBundle(
    Buffer.from(
      JSON.stringify({
        snapshotAt,
        dump: dump.toString("base64"),
        dumpHash: checksum(dump),
        objects,
      }),
    ),
    archiveKey,
  );
  assert.throws(() => openRecoveryBundle(archive, randomBytes(32)));
  const corrupt = Buffer.from(archive);
  corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
  assert.throws(() => openRecoveryBundle(corrupt, archiveKey));
  stage = "restore-database-and-objects";
  const recoveryStarted = performance.now();
  // Shape is generated locally, authenticated, and never accepted from user input.
  const recovered: { dump: string; dumpHash: string; objects: typeof objects } =
    JSON.parse(openRecoveryBundle(archive, archiveKey).toString());
  const restoredDump = Buffer.from(recovered.dump, "base64");
  verifyRecoveryObject(restoredDump, recovered.dumpHash);
  await pg(
    [
      "pg_restore",
      "-U",
      user,
      "-d",
      names[1],
      "--exit-on-error",
      "--no-owner",
      "--no-acl",
    ],
    restoredDump,
  );
  for (const object of recovered.objects) {
    const bytes = Buffer.from(object.data, "base64");
    verifyRecoveryObject(bytes, object.hash);
    await s3.send(
      new PutObjectCommand({
        Bucket: buckets[1],
        Key: object.key,
        Body: bytes,
      }),
    );
    const result = await s3.send(
      new GetObjectCommand({ Bucket: buckets[1], Key: object.key }),
    );
    verifyRecoveryObject(
      await result.Body!.transformToByteArray(),
      object.hash,
    );
    assert.throws(() => verifyRecoveryObject(undefined, object.hash));
    assert.throws(() =>
      verifyRecoveryObject(Buffer.from("corrupt"), object.hash),
    );
  }
  assert.deepEqual(
    (
      await restored`SELECT version FROM schema_migrations ORDER BY version`
    ).map((row) => row.version),
    requiredMigrations,
  );
  const [extension] =
    await restored`SELECT extversion FROM pg_extension WHERE extname='vector'`;
  assert.ok(supportedVectorVersion(extension!.extversion));
  assert.equal((await restored`SELECT id FROM organizations`).length, 2);
  for (const fixture of fixtures) {
    const [secret] =
      await restored`SELECT ciphertext FROM secrets WHERE id=${fixture.secretId} AND organization_id=${fixture.org} AND workspace_id=${fixture.workspace}`;
    assert.equal(decrypt(secret!.ciphertext, fixture.context), fixture.value);
    assert.throws(() =>
      decrypt(
        secret!.ciphertext,
        fixtures.find((other) => other !== fixture)!.context,
      ),
    );
    const originalMasterKey = config.MASTER_KEY;
    try {
      config.MASTER_KEY = randomBytes(32).toString("hex");
      assert.throws(() => decrypt(secret!.ciphertext, fixture.context));
    } finally {
      config.MASTER_KEY = originalMasterKey;
    }
    await assert.rejects(
      restored`UPDATE secrets SET organization_id=${fixtures.find((other) => other !== fixture)!.org} WHERE id=${fixture.secretId}`,
    );
  }
  archiveKey.fill(0);
  report = {
    status: "passed",
    scope: "synthetic-local-recovery",
    snapshotAt,
    tenants: fixtures.length,
    objects: objects.length,
    migrations: requiredMigrations.length,
    encryptedArchiveBytes: archive.length,
    recoveryMs: Math.round(performance.now() - recoveryStarted),
    elapsedMs: Math.round(performance.now() - started),
  };
} catch {
  failed = true;
  console.error(
    `Recovery drill failed at ${stage}. Check local PostgreSQL/S3 availability and administrator permissions. Credential and row diagnostics are suppressed.`,
  );
} finally {
  const cleanupErrors = [];
  for (const connection of connections) {
    try {
      await connection.end({ timeout: 5 });
    } catch {
      cleanupErrors.push("connection");
    }
  }
  for (const bucket of createdBuckets) {
    try {
      for (const key of objectKeys)
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    } catch {
      cleanupErrors.push(bucket);
    }
  }
  for (const name of createdDatabases) {
    try {
      await admin.unsafe(`DROP DATABASE "${name}"`);
    } catch {
      cleanupErrors.push(name);
    }
  }
  await admin.end({ timeout: 5 });
  s3.destroy();
  if (cleanupErrors.length) {
    failed = true;
    console.error(JSON.stringify({ cleanupRequired: cleanupErrors }));
  }
  if (failed) process.exitCode = 1;
  else console.log(JSON.stringify(report));
}
