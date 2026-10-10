import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID, createHash, generateKeyPairSync } from "node:crypto";
import postgres from "postgres";
import { cleanupKnowledgeFixtures } from "../../apps/api/test/knowledge-cleanup.mjs";
const apiRequire = createRequire(
  new URL("../../apps/api/package.json", import.meta.url),
);
const {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} = apiRequire("@aws-sdk/client-s3");
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
// Explicit local embedding protocol fixture and real local S3. Temporarily approve the S3 endpoint and 127.0.0.1:4553 in worker/API private host settings.
const sql = postgres(process.env.DATABASE_URL, { max: 1 }),
  org = randomUUID(),
  workspace = randomUUID(),
  user = randomUUID(),
  session = randomUUID(),
  bucket = "connector-browser-" + randomUUID();
const storage = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY,
    secretAccessKey: process.env.S3_SECRET_KEY,
  },
});
const embedding = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const data = JSON.parse(raw);
  res.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      data: data.input.map((_, index) => ({
        index,
        embedding: [1, 0.3, 0.2],
      })),
    }),
  );
});
test.beforeAll(async () => {
  await new Promise((r) => embedding.listen(4553, "127.0.0.1", r));
  await storage.send(new CreateBucketCommand({ Bucket: bucket }));
  await storage.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: "documents/policy.txt",
      Body: "Refunds are available within 30 days.",
    }),
  );
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${user},${user + "@example.com"},'Connector Builder','unused',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(session).digest("hex")},${user},now()+interval '1 hour')`;
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Connector browser')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Connector workspace')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${user},'owner')`;
  });
});
test.afterAll(async () => {
  embedding.closeAllConnections();
  await new Promise((r) => embedding.close(r));
  const objects =
    (await storage.send(new ListObjectsV2Command({ Bucket: bucket })))
      .Contents ?? [];
  if (objects.length)
    await storage.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objects.map((o) => ({ Key: o.Key })) },
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
    await tx`DELETE FROM users WHERE id=${user}`;
  });
  await sql.end();
});
test("S3 setup, worker ingestion, incremental sync, schedule, pause and disconnect", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.addCookies([
    {
      name: "session",
      value: session,
      url: "http://localhost:3000",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const base = `http://localhost:4000/workspaces/${workspace}`,
    headers = { origin: "http://localhost:3000" };
  async function post(url, data) {
    const r = await context.request.post(url, { headers, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  }
  const model = await post(base + "/embedding-models", {
      name: "Fixture embeddings",
      provider: "openai-compatible",
      modelId: "fixture",
      baseUrl: "http://127.0.0.1:4553/v1",
      dimensions: 3,
    }),
    kb = await post(base + "/knowledge-bases", {
      name: "Connected policies",
      embeddingModelId: model.id,
    });
  await post(base + "/secrets", {
    name: "S3_READ_CREDENTIAL",
    value: JSON.stringify({
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    }),
  });
  const secrets = await (await context.request.get(base + "/secrets")).json();
  await page.goto("/");
  await page.getByRole("button", { name: "Connectors", exact: true }).click();
  await expect(
    page.getByText("No enterprise sources yet", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Add connector", exact: true })
    .click();
  await page
    .getByLabel("Connector name", { exact: true })
    .fill("Policy storage");
  await page
    .getByLabel("Connector knowledge base", { exact: true })
    .selectOption(kb.id);
  await page
    .getByLabel("Source workspace credential", { exact: true })
    .selectOption(secrets[0].id);
  await page
    .getByLabel("S3 endpoint", { exact: true })
    .fill(process.env.S3_ENDPOINT);
  await page.getByLabel("S3 bucket", { exact: true }).fill(bucket);
  await page.getByLabel("S3 prefix", { exact: true }).fill("documents/");
  await page
    .getByRole("button", { name: "Save connector", exact: true })
    .click();
  await expect(
    page.getByText(
      "Connector saved. Run Sync now to verify access and import files.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(page.getByText(/imported: 1/)).toBeVisible({ timeout: 30000 });
  await expect
    .poll(
      async () => {
        const r = await context.request.get(
          `http://localhost:4000/knowledge-bases/${kb.id}/sources`,
        );
        return (await r.json())[0]?.status;
      },
      { timeout: 30000 },
    )
    .toBe("ready");
  const search = await post(
    `http://localhost:4000/knowledge-bases/${kb.id}/search`,
    { query: "refund 30 days", mode: "hybrid" },
  );
  expect(search.results[0].content).toContain("30 days");
  expect(search.results[0].sourceUrl).toBe(
    `s3://${bucket}/documents/policy.txt`,
  );
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(page.getByText(/unchanged: 1/)).toBeVisible({ timeout: 30000 });
  await storage.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: "documents/policy.txt",
      Body: "Refunds are available within 60 days.",
    }),
  );
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(page.getByText(/updated: 1/)).toBeVisible({ timeout: 30000 });
  await page
    .getByRole("button", { name: "Edit connector", exact: true })
    .click();
  await page.getByLabel("Maximum listed objects", { exact: true }).fill("200");
  await page
    .getByLabel("Refresh schedule", { exact: true })
    .selectOption("1440");
  await page
    .getByRole("button", { name: "Save connector", exact: true })
    .click();
  await expect(page.getByText(/Refresh every 1440 minutes/)).toBeVisible();
  await page
    .getByRole("button", { name: "Pause connector", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Sync now", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Resume connector", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Sync now", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Disconnect connector", exact: true })
    .click();
  await expect(
    page.getByText("No enterprise sources yet", { exact: true }),
  ).toBeVisible();
  const retained = await (
    await context.request.get(
      `http://localhost:4000/knowledge-bases/${kb.id}/sources`,
    )
  ).json();
  expect(retained).toHaveLength(1);
  expect(retained[0].status).not.toBe("deleted");
  expect(errors).toEqual([]);
});

test("Google Drive setup explains sharing, saves selected provider and locks source configuration", async ({
  page,
  context,
}) => {
  await context.addCookies([
    {
      name: "session",
      value: session,
      url: "http://localhost:3000",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const base = `http://localhost:4000/workspaces/${workspace}`,
    headers = { origin: "http://localhost:3000" };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const saved = await context.request.post(base + "/secrets", {
    headers,
    data: {
      name: "DRIVE_ACCOUNT",
      value: JSON.stringify({
        client_email: "fixture@project.iam.gserviceaccount.com",
        private_key: privateKey
          .export({ format: "pem", type: "pkcs8" })
          .toString(),
      }),
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const secrets = await (await context.request.get(base + "/secrets")).json(),
    bases = await (await context.request.get(base + "/knowledge-bases")).json();
  await page.goto("/");
  await page.getByRole("button", { name: "Connectors", exact: true }).click();
  await page
    .getByRole("button", { name: "Add connector", exact: true })
    .click();
  await page
    .getByLabel("Connector provider", { exact: true })
    .selectOption("google-drive");
  await expect(
    page.getByText(/share this folder with its client_email as Viewer/),
  ).toBeVisible();
  await expect(page.getByLabel("S3 endpoint", { exact: true })).toHaveCount(0);
  await page
    .getByLabel("Connector name", { exact: true })
    .fill("Drive policies");
  await page
    .getByLabel("Connector knowledge base", { exact: true })
    .selectOption(bases[0].id);
  await page
    .getByLabel("Source workspace credential", { exact: true })
    .selectOption(secrets.find((s) => s.name === "DRIVE_ACCOUNT").id);
  await page
    .getByLabel("Google Drive folder ID", { exact: true })
    .fill("fixture-folder");
  await page.getByLabel("Include subfolders", { exact: true }).uncheck();
  await page
    .getByRole("button", { name: "Save connector", exact: true })
    .click();
  await expect(
    page.getByText(
      "Connector saved. Run Sync now to verify access and import files.",
      { exact: true },
    ),
  ).toBeVisible();
  const connectors = await (
    await context.request.get(base + "/connectors")
  ).json();
  expect(connectors[0].kind).toBe("google-drive");
  expect(connectors[0].selection).toEqual({
    folderId: "fixture-folder",
    recursive: false,
    maxObjects: 100,
  });
  await page
    .getByRole("button", { name: "Edit connector", exact: true })
    .click();
  await expect(
    page.getByLabel("Connector provider", { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("Google Drive folder ID", { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("Include subfolders", { exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole("button", { name: "Save connector", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Pause connector", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Sync now", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Disconnect connector", exact: true })
    .click();
  await expect(
    page.getByText("No enterprise sources yet", { exact: true }),
  ).toBeVisible();
});
