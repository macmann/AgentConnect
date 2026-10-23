import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
import { cleanupKnowledgeFixtures } from "../../apps/api/test/knowledge-cleanup.mjs";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production mode");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const org = randomUUID(),
  workspace = randomUUID(),
  user = randomUUID(),
  session = randomUUID();
let baseId;
const headers = {
  origin: "http://localhost:3000",
  cookie: `session=${session}`,
  "content-type": "application/json",
};
async function post(path, body) {
  const response = await fetch(`http://localhost:4000${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  expect(response.ok, await response.clone().text()).toBeTruthy();
  return response.json();
}
test.beforeAll(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${user},${user + "@example.com"},'Bulk Builder','unused-browser-fixture',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(session).digest("hex")},${user},now()+interval '1 hour')`;
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Bulk browser')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Bulk workspace')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${user},'owner')`;
  });
  await post(`/workspaces/${workspace}/secrets`, {
    name: "BULK_FIXTURE",
    value: "fixture-not-a-real-provider-key",
  });
  const [secret] =
    await sql`SELECT id FROM secrets WHERE workspace_id=${workspace}`;
  const model = await post(`/workspaces/${workspace}/embedding-models`, {
    name: "Bulk embedding fixture",
    provider: "openai",
    modelId: "text-embedding-3-small",
    dimensions: 3,
    secretId: secret.id,
  });
  const base = await post(`/workspaces/${workspace}/knowledge-bases`, {
    name: "Bulk documents",
    embeddingModelId: model.id,
  });
  baseId = base.id;
});
test.afterAll(async () => {
  await cleanupKnowledgeFixtures(sql, org);
  await sql.begin(async (tx) => {
    for (const table of [
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
test("100-file browser queue pauses, resumes and retries a lost response without duplicating ingestion", async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  await context.addCookies([
    {
      name: "session",
      value: session,
      url: "http://localhost:3000",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  let active = 0,
    peak = 0,
    calls = 0,
    lostKey;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/knowledge-bases/*/upload", async (route) => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    const ordinal = calls;
    try {
      if (ordinal <= 2) await gate;
      const response = await route.fetch();
      if (ordinal === 1) {
        lostKey = route.request().headers()["idempotency-key"];
        await route.abort("failed");
      } else await route.fulfill({ response });
    } finally {
      active--;
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await page.getByRole("button", { name: /Bulk documents/ }).click();
  await page
    .getByRole("button", { name: "Upload document", exact: true })
    .click();
  await page.getByLabel("Document files").setInputFiles(
    Array.from({ length: 100 }, (_, i) => ({
      name: `bulk-${i}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from(`Policy document ${i}: refunds within thirty days.`),
    })),
  );
  await page
    .getByRole("button", { name: "Start uploads", exact: true })
    .click();
  const queue = page.getByRole("region", { name: "Document upload queue" });
  await expect.poll(() => calls).toBe(2);
  await queue
    .getByRole("button", { name: "Pause uploads", exact: true })
    .click();
  release();
  await expect(
    queue.getByText("1 uploaded · 98 remaining · 1 failed · Paused", {
      exact: true,
    }),
  ).toBeVisible();
  expect(calls).toBe(2);
  await queue
    .getByRole("button", { name: "Resume uploads", exact: true })
    .click();
  await expect(
    queue.getByText("99 uploaded · 0 remaining · 1 failed", { exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await queue
    .getByRole("button", { name: "Retry failed uploads", exact: true })
    .click();
  await expect(
    queue.getByText("100 uploaded · 0 remaining · 0 failed", { exact: true }),
  ).toBeVisible();
  expect(peak).toBeLessThanOrEqual(2);
  expect(calls).toBe(101);
  const [count] =
    await sql`SELECT count(*)::int AS n FROM knowledge_sources WHERE knowledge_base_id=${baseId}`;
  const [jobs] =
    await sql`SELECT count(*)::int AS n FROM knowledge_jobs WHERE knowledge_base_id=${baseId}`;
  const [retried] =
    await sql`SELECT count(*)::int AS n FROM knowledge_sources WHERE id=${lostKey}`;
  expect(count.n).toBe(100);
  expect(jobs.n).toBe(100);
  expect(retried.n).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(queue.getByLabel("Simultaneous uploads")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await queue.screenshot({
    path: "test-results/knowledge-bulk-mobile.png",
  });
  await queue
    .getByRole("button", { name: "Clear finished files", exact: true })
    .click();
  await expect(queue).not.toBeVisible();
  await page
    .getByRole("button", { name: "Upload document", exact: true })
    .click();
  await page.getByLabel("Document files").setInputFiles([
    { name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) },
    {
      name: "invalid.exe",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("bad"),
    },
  ]);
  await page
    .getByRole("button", { name: "Start uploads", exact: true })
    .click();
  await expect(queue.getByText("File is empty", { exact: true })).toBeVisible();
  await expect(
    queue.getByText("Unsupported file type", { exact: true }),
  ).toBeVisible();
  expect(calls).toBe(101);
});

test("unfinished uploads warn on navigation and cancel cleanly", async ({
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
  let started = 0;
  await page.route("**/knowledge-bases/*/upload", async (route) => {
    started++;
    // Keep transfers pending until the user cancels them.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await route
      .fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fixture transfer unavailable" }),
      })
      .catch(() => {});
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await page.getByRole("button", { name: /Bulk documents/ }).click();
  await page
    .getByRole("button", { name: "Upload document", exact: true })
    .click();
  await page
    .getByLabel("Document files")
    .setInputFiles(
      Array.from({ length: 3 }, (_, i) => ({
        name: `cancel-${i}.txt`,
        mimeType: "text/plain",
        buffer: Buffer.from("Cancel me"),
      })),
    );
  await page
    .getByRole("button", { name: "Start uploads", exact: true })
    .click();
  const queue = page.getByRole("region", { name: "Document upload queue" });
  await expect.poll(() => started).toBe(2);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(queue).toBeVisible();
  await queue
    .getByRole("button", { name: "Cancel pending uploads", exact: true })
    .click();
  await expect(queue.getByText("Cancelled", { exact: true })).toHaveCount(3);
  expect(started).toBe(2);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(queue).not.toBeVisible();
});
