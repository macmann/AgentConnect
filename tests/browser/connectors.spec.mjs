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
      "Connector saved. Run Sync now to verify access and import sources.",
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
      "Connector saved. Run Sync now to verify access and import sources.",
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

test("OneDrive setup requires drive and folder IDs, saves application credential and preserves source selection", async ({
  page,
  context,
}) => {
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
  const saved = await context.request.post(base + "/secrets", {
    headers,
    data: {
      name: "ONEDRIVE_APP",
      value: JSON.stringify({
        tenantId: randomUUID(),
        clientId: randomUUID(),
        clientSecret: "fixture-app-secret",
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
    .selectOption("onedrive");
  await expect(
    page.getByText(
      /Microsoft Graph application permissions and administrator consent/,
    ),
  ).toBeVisible();
  await expect(
    page.getByLabel("Google Drive folder ID", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("S3 endpoint", { exact: true })).toHaveCount(0);
  await page
    .getByLabel("Connector name", { exact: true })
    .fill("OneDrive policies");
  await page
    .getByLabel("Connector knowledge base", { exact: true })
    .selectOption(bases[0].id);
  await page
    .getByLabel("Source workspace credential", { exact: true })
    .selectOption(secrets.find((s) => s.name === "ONEDRIVE_APP").id);
  await page
    .getByLabel("OneDrive folder item ID", { exact: true })
    .fill("fixture-folder");
  await expect(
    page.getByRole("button", { name: "Save connector", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("OneDrive drive ID", { exact: true })
    .fill("b!fixture-drive");
  await page.getByLabel("Refresh schedule", { exact: true }).selectOption("60");
  await page
    .getByRole("button", { name: "Save connector", exact: true })
    .click();
  await expect(
    page.getByText(
      "Connector saved. Run Sync now to verify access and import sources.",
      { exact: true },
    ),
  ).toBeVisible();
  const connectors = await (
    await context.request.get(base + "/connectors")
  ).json();
  expect(connectors[0].kind).toBe("onedrive");
  expect(connectors[0].selection).toEqual({
    driveId: "b!fixture-drive",
    folderId: "fixture-folder",
    recursive: true,
    maxObjects: 100,
  });
  expect(connectors[0].schedule_minutes).toBe(60);
  await page
    .getByRole("button", { name: "Edit connector", exact: true })
    .click();
  await expect(
    page.getByLabel("Connector provider", { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("OneDrive drive ID", { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("OneDrive folder item ID", { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("Include subfolders", { exact: true }),
  ).toBeChecked();
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
  expect(errors).toEqual([]);
});

test("SharePoint discovery wizard selects a library folder, resets stale choices and saves the site-bound connector", async ({
  page,
  context,
}) => {
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
  const base = `http://localhost:4000/workspaces/${workspace}`;
  const secrets = await (await context.request.get(base + "/secrets")).json(),
    bases = await (await context.request.get(base + "/knowledge-bases")).json();
  const secret = secrets.find((s) => s.name === "ONEDRIVE_APP");
  // Explicit discovery-response fixture. Registration, encrypted secrets and
  // persistence use the real API; server discovery is covered by protocol-backed API tests.
  const site = {
    id: `fixture.sharepoint.com,${randomUUID()},${randomUUID()}`,
    displayName: "Support site",
    webUrl: "https://fixture.sharepoint.com/sites/Support",
  };
  const library = {
      id: "b!support-library",
      name: "Documents",
      webUrl: site.webUrl + "/Documents",
    },
    root = { id: "root-folder", name: "Documents", webUrl: library.webUrl },
    policies = {
      id: "policies-folder",
      name: "Policies",
      webUrl: library.webUrl + "/Policies",
    };
  await page.route(base + "/connectors/sharepoint/discover", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const body = route.request().postDataJSON();
    expect(body.secretId).toBe(secret.id);
    const value =
      body.action === "site"
        ? { site, libraries: [library] }
        : body.folderId === policies.id
          ? { folder: policies, folders: [] }
          : { folder: root, folders: [policies] };
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/json",
        "access-control-allow-origin": "http://localhost:3000",
        "access-control-allow-credentials": "true",
      },
      body: JSON.stringify(value),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Connectors", exact: true }).click();
  await page
    .getByRole("button", { name: "Add connector", exact: true })
    .click();
  await page
    .getByLabel("Connector provider", { exact: true })
    .selectOption("sharepoint");
  await page
    .getByLabel("Connector name", { exact: true })
    .fill("SharePoint policies");
  await page
    .getByLabel("Connector knowledge base", { exact: true })
    .selectOption(bases[0].id);
  await page
    .getByLabel("Source workspace credential", { exact: true })
    .selectOption(secret.id);
  await page
    .getByLabel("SharePoint site URL", { exact: true })
    .fill(site.webUrl);
  await page.getByRole("button", { name: "Find site", exact: true }).click();
  await expect(
    page.getByText("Site: Support site", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("SharePoint document library", { exact: true })
    .selectOption(library.id);
  await expect(
    page.getByText("Current folder: Documents", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save connector", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Open Policies", exact: true })
    .click();
  await expect(
    page.getByText("Current folder: Policies", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Use this folder", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save connector", exact: true }),
  ).toBeEnabled();
  // A credential change clears discovered selection before another save.
  await page
    .getByLabel("Source workspace credential", { exact: true })
    .selectOption("");
  await expect(
    page.getByRole("button", { name: "Save connector", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("SharePoint document library", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel("Source workspace credential", { exact: true })
    .selectOption(secret.id);
  await page.getByRole("button", { name: "Find site", exact: true }).click();
  await page
    .getByLabel("SharePoint document library", { exact: true })
    .selectOption(library.id);
  await page
    .getByRole("button", { name: "Open Policies", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Use this folder", exact: true })
    .click();
  await page.getByLabel("Include subfolders", { exact: true }).uncheck();
  await page
    .getByRole("button", { name: "Save connector", exact: true })
    .click();
  await expect(
    page.getByText(
      "Connector saved. Run Sync now to verify access and import sources.",
      { exact: true },
    ),
  ).toBeVisible();
  const connectors = await (
    await context.request.get(base + "/connectors")
  ).json();
  expect(connectors[0].kind).toBe("sharepoint");
  expect(connectors[0].selection).toEqual({
    siteId: site.id,
    driveId: library.id,
    folderId: policies.id,
    recursive: false,
    maxObjects: 100,
  });
  await page
    .getByRole("button", { name: "Edit connector", exact: true })
    .click();
  await expect(
    page.getByLabel("SharePoint site ID", { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("SharePoint library ID", { exact: true }),
  ).toHaveValue(library.id);
  await expect(
    page.getByLabel("SharePoint folder ID", { exact: true }),
  ).toHaveValue(policies.id);
  await page
    .getByRole("button", { name: "Save connector", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Disconnect connector", exact: true })
    .click();
  await expect(
    page.getByText("No enterprise sources yet", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

for (const kind of ["teams", "slack"]) {
  test(`${kind} channel setup links, registration and lifecycle controls persist without exposing credentials`, async ({
    page,
    context,
  }) => {
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
    const base = `http://localhost:4000/workspaces/${workspace}`;
    const saved = await context.request.post(base + "/secrets", {
      headers: { origin: "http://localhost:3000" },
      data: {
        name: kind.toUpperCase() + "_MESSAGES",
        value: JSON.stringify(
          kind === "teams"
            ? {
                tenantId: randomUUID(),
                clientId: randomUUID(),
                clientSecret: "fixture-teams-client-secret",
              }
            : { token: "xoxp-fixture-slack-user-token" },
        ),
      },
    });
    expect(saved.status()).toBe(201);
    const secrets = await (await context.request.get(base + "/secrets")).json(),
      bases = await (
        await context.request.get(base + "/knowledge-bases")
      ).json();
    await page.goto("/");
    await page.getByRole("button", { name: "Connectors", exact: true }).click();
    await page
      .getByRole("button", { name: "Add connector", exact: true })
      .click();
    await page
      .getByLabel("Connector provider", { exact: true })
      .selectOption(kind);
    await expect(
      page.getByRole("button", { name: "Open Secrets", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/Imported content inherits knowledge base access/),
    ).toBeVisible();
    await page
      .getByLabel("Connector name", { exact: true })
      .fill(kind + " support");
    await page
      .getByLabel("Connector knowledge base", { exact: true })
      .selectOption(bases[0].id);
    await page
      .getByLabel("Source workspace credential", { exact: true })
      .selectOption(
        secrets.find((s) => s.name === kind.toUpperCase() + "_MESSAGES").id,
      );
    await expect(
      page.getByRole("button", { name: "Save connector", exact: true }),
    ).toBeDisabled();
    const teamId = kind === "teams" ? randomUUID() : "TFIXTURE",
      channelId = kind === "teams" ? "19:fixture@thread.tacv2" : "CFIXTURE";
    const teamLabel = kind === "teams" ? "Teams team ID" : "Slack workspace ID";
    await page.getByLabel(teamLabel, { exact: true }).fill(teamId);
    await page.getByLabel("Channel ID", { exact: true }).fill(channelId);
    await page
      .getByRole("button", { name: "Save connector", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Sync now", exact: true }),
    ).toBeVisible();
    const records = await (
        await context.request.get(base + "/connectors")
      ).json(),
      record = records.find((c) => c.name === kind + " support");
    expect(record.kind).toBe(kind);
    expect(record.selection).toEqual({ teamId, channelId, maxObjects: 100 });
    expect(JSON.stringify(records)).not.toContain("fixture-slack-user-token");
    await page
      .getByRole("button", { name: "Edit connector", exact: true })
      .click();
    await expect(page.getByLabel(teamLabel, { exact: true })).toBeDisabled();
    await expect(page.getByLabel("Channel ID", { exact: true })).toBeDisabled();
    await page
      .getByLabel("Connector name", { exact: true })
      .fill(kind + " renamed");
    await page
      .getByRole("button", { name: "Save connector", exact: true })
      .click();
    await page.getByRole("button", { name: "Pause connector", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Sync now", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Resume connector", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Sync now", exact: true }),
    ).toBeEnabled();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Disconnect connector", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: kind + " renamed", exact: true }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
