import { cleanupKnowledgeFixtures } from "../../apps/api/test/knowledge-cleanup.mjs";
import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const org = randomUUID(),
  workspace = randomUUID(),
  user = randomUUID(),
  session = randomUUID(),
  embedding = randomUUID(),
  kb = randomUUID(),
  source = randomUUID(),
  document = randomUUID(),
  model = randomUUID();
const server = createServer(async (req, res) => {
  for await (const chunk of req) {
    void chunk;
  }
  if (req.url === "/v1/chat/completions") {
    res.writeHead(200, { "content-type": "text/event-stream" }).end(
      "data: " +
        JSON.stringify({
          choices: [
            {
              delta: {
                content: JSON.stringify({
                  tags: ["ai-policy"],
                  attributes: { product: "loans", language: "English" },
                }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 20 },
        }) +
        "\n\ndata: [DONE]\n\n",
    );
    return;
  }
  res
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }));
});
test.beforeAll(async () => {
  await new Promise((r) => server.listen(4557, "127.0.0.1", r));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES(${user},${user + "@example.invalid"},'Metadata owner','unused',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(${createHash("sha256").update(session).digest("hex")},${user},now()+interval '1 hour')`;
    await tx`INSERT INTO organizations(id,name) VALUES(${org},'Metadata browser fixture')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES(${workspace},${org},'Metadata workspace')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES(${randomUUID()},${org},${user},'owner')`;
    await tx`INSERT INTO embedding_models(id,organization_id,workspace_id,name,provider,model_id,base_url,dimensions) VALUES(${embedding},${org},${workspace},'Metadata embedding','openai-compatible','fixture','http://127.0.0.1:4557/v1',3)`;
    await tx`INSERT INTO model_configurations(id,organization_id,workspace_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES(${model},${org},${workspace},'Tagging model','openai-compatible','fixture','http://127.0.0.1:4557/v1',32768,8192,'{"streaming":true,"temperature":false,"topP":false}')`;
    await tx`INSERT INTO knowledge_bases(id,organization_id,workspace_id,name,description,embedding_model_id,dimensions,chunk_size,chunk_overlap,chunk_strategy) VALUES(${kb},${org},${workspace},'Loan knowledge','Metadata test',${embedding},3,500,0,'recursive')`;
    await tx`INSERT INTO knowledge_sources(id,knowledge_base_id,organization_id,workspace_id,kind,title,status) VALUES(${source},${kb},${org},${workspace},'text','Loan policy','ready')`;
    await tx`INSERT INTO knowledge_documents(id,source_id,knowledge_base_id,organization_id,workspace_id,title,metadata,page_count,content_hash,revision) VALUES(${document},${source},${kb},${org},${workspace},'Loan policy','{}',1,'fixture',1)`;
    await tx`INSERT INTO knowledge_chunks(id,document_id,source_id,knowledge_base_id,workspace_id,organization_id,embedding_model_id,dimensions,ordinal,content,metadata,embedding) VALUES(${randomUUID()},${document},${source},${kb},${workspace},${org},${embedding},3,0,'Loan refunds within 30 days.','{}','[1,0,0]'::vector)`;
  });
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
      "model_configurations",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    await tx`DELETE FROM users WHERE id=${user}`;
  });
  await sql.end();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
test("Source metadata saves, reloads safely, filters retrieval and fits mobile", async ({
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
  await page.goto(
    `/#view=Knowledge&organization=${org}&workspace=${workspace}`,
  );
  await page.getByRole("button", { name: /Loan knowledge/ }).click();
  const row = page.getByRole("row").filter({ hasText: "Loan policy" });
  await row.locator("summary").filter({ hasText: "Tags & metadata" }).click();
  const editor = page.getByRole("form", { name: "Metadata for Loan policy" });
  await editor.getByLabel("Tags", { exact: true }).fill("policy, retail");
  await editor
    .getByRole("button", { name: "Add metadata field", exact: true })
    .click();
  await editor.getByLabel("Field key 1", { exact: true }).fill("product");
  await editor.getByLabel("Field value 1", { exact: true }).fill("loans");
  await editor
    .getByRole("button", { name: "Save metadata", exact: true })
    .click();
  await expect(editor.getByRole("status")).toContainText("Metadata saved");
  // A concurrent editor cannot silently overwrite metadata with an old revision.
  await sql`UPDATE knowledge_sources SET metadata=jsonb_set(metadata,'{metadataRevision}','2'::jsonb) WHERE id=${source}`;
  await editor
    .getByRole("button", { name: "Save metadata", exact: true })
    .click();
  await expect(editor.getByRole("alert")).toContainText("changed; reload");
  await editor
    .getByRole("button", { name: "Reload metadata", exact: true })
    .click();
  await expect(editor.getByRole("status")).toContainText(
    "Latest metadata loaded",
  );
  await editor
    .getByRole("button", { name: "Save metadata", exact: true })
    .click();
  await expect(editor.getByRole("status")).toContainText("Metadata saved");
  await page.reload();
  await page.getByRole("button", { name: /Loan knowledge/ }).click();
  await page
    .getByRole("row")
    .filter({ hasText: "Loan policy" })
    .locator("summary")
    .filter({ hasText: "Tags & metadata" })
    .click();
  await expect(
    page
      .getByRole("form", { name: "Metadata for Loan policy" })
      .getByLabel("Tags", { exact: true }),
  ).toHaveValue("policy, retail");
  await page
    .getByRole("button", { name: "Retrieval playground", exact: true })
    .click();
  await page
    .locator("summary")
    .filter({ hasText: "Filter by tags & metadata" })
    .click();
  await page.getByLabel("Required tags", { exact: true }).fill("policy");
  await page
    .getByRole("button", { name: "Add metadata field", exact: true })
    .click();
  await page.getByLabel("Field key 1", { exact: true }).fill("product");
  await page.getByLabel("Field value 1", { exact: true }).fill("loans");
  await page.getByLabel("Retrieval query").fill("loan refund");
  await page
    .getByRole("button", { name: "Search knowledge", exact: true })
    .click();
  await expect(
    page.getByText("[1] Loan policy", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Field value 1", { exact: true }).fill("cards");
  await page
    .getByRole("button", { name: "Search knowledge", exact: true })
    .click();
  await expect(page.locator(".retrieval-results")).toContainText(
    "No relevant passages",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Field value 1", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBeTruthy();
});

test("Shared upload metadata, bulk patch preview and optional AI review work together", async ({
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
  await page.goto(
    `/#view=Knowledge&organization=${org}&workspace=${workspace}`,
  );
  await page.getByRole("button", { name: /Loan knowledge/ }).click();
  await page
    .getByRole("button", { name: "Upload document", exact: true })
    .click();
  await page.getByLabel("Document files").setInputFiles({
    name: "shared-policy.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Retail loan refund policy within 30 days."),
  });
  await page
    .getByText("Shared metadata for all selected files", { exact: true })
    .click();
  const uploadForm = page
    .locator("form")
    .filter({ has: page.getByLabel("Document files") });
  await uploadForm.getByLabel("Tags", { exact: true }).fill("shared, policy");
  await uploadForm
    .getByRole("button", { name: "Add metadata field", exact: true })
    .click();
  await uploadForm
    .getByLabel("Field key 1", { exact: true })
    .fill("department");
  await uploadForm.getByLabel("Field value 1", { exact: true }).fill("retail");
  await expect(
    uploadForm.getByRole("switch", { name: "Suggest metadata with AI" }),
  ).not.toBeChecked();
  await uploadForm
    .getByRole("switch", { name: "Suggest metadata with AI" })
    .check();
  await uploadForm.getByLabel("AI tagging model").selectOption(model);
  await uploadForm
    .getByRole("button", { name: "Start uploads", exact: true })
    .click();
  const row = page.getByRole("row").filter({ hasText: "shared-policy.txt" });
  await expect(row.getByText("ready", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await row.getByText("AI metadata tagging", { exact: true }).click();
  await expect(
    row.getByText("Review AI metadata suggestions", { exact: true }),
  ).toBeVisible({ timeout: 30000 });
  let [stored] =
    await sql`SELECT metadata FROM knowledge_sources WHERE knowledge_base_id=${kb} AND title='shared-policy.txt'`;
  expect(stored.metadata.tags).toEqual(["shared", "policy"]);
  expect(stored.metadata.attributes).toEqual({ department: "retail" });
  await row
    .getByText("Review AI metadata suggestions", { exact: true })
    .click();
  await row
    .getByRole("button", { name: "Apply reviewed suggestions", exact: true })
    .click();
  await expect(
    row.getByText("AI tagging: applied", { exact: true }),
  ).toBeVisible();
  await row.locator("summary").filter({ hasText: "Tags & metadata" }).click();
  await expect(
    row
      .getByRole("form", { name: "Metadata for shared-policy.txt" })
      .getByLabel("Tags", { exact: true }),
  ).toHaveValue(/ai-policy/);
  await page.getByLabel("Select source Loan policy", { exact: true }).check();
  await page
    .getByLabel("Select source shared-policy.txt", { exact: true })
    .check();
  const bulk = page.getByRole("region", { name: "Bulk metadata editor" });
  await bulk.getByLabel("Tags", { exact: true }).fill("bulk-policy");
  await bulk
    .getByRole("button", { name: "Add metadata field", exact: true })
    .click();
  await bulk.getByLabel("Field key 1", { exact: true }).fill("document_type");
  await bulk.getByLabel("Field value 1", { exact: true }).fill("policy");
  await bulk
    .getByRole("button", { name: "Preview bulk changes", exact: true })
    .click();
  await expect(
    bulk.getByText("Review changes for 2 sources", { exact: true }),
  ).toBeVisible();
  [stored] =
    await sql`SELECT metadata FROM knowledge_sources WHERE knowledge_base_id=${kb} AND title='shared-policy.txt'`;
  expect(stored.metadata.tags).not.toContain("bulk-policy");
  await bulk
    .getByRole("button", { name: "Apply to 2 sources", exact: true })
    .click();
  await expect(bulk.getByRole("status")).toContainText(
    "Metadata updated for 2 sources",
  );
  [stored] =
    await sql`SELECT metadata FROM knowledge_sources WHERE knowledge_base_id=${kb} AND title='shared-policy.txt'`;
  expect(stored.metadata.tags).toContain("shared");
  expect(stored.metadata.tags).toContain("ai-policy");
  expect(stored.metadata.tags).toContain("bulk-policy");
  expect(stored.metadata.attributes).toMatchObject({
    department: "retail",
    product: "loans",
    document_type: "policy",
  });
});
