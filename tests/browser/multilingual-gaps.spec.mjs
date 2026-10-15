import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import postgres from "postgres";
import { paceApiBudget } from "../helpers/api-budget.mjs";
import { cleanupKnowledgeFixtures } from "../../apps/api/test/knowledge-cleanup.mjs";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const org = randomUUID(),
  workspace = randomUUID(),
  user = randomUUID(),
  session = randomUUID();
let embedding, kb, source, agent;
const provider = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (req.url === "/v1/embeddings") {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        data: body.input.map((text, index) => ({
          index,
          embedding: text.toLowerCase().includes("branch")
            ? [0, 1, 0]
            : [1, 0, 0],
        })),
      }),
    );
    return;
  }
  const question = body.messages.at(-1)?.content ?? "";
  const answer = question.includes("เปลี่ยน")
    ? "รีเซ็ตรหัสผ่าน [1]"
    : "Reset password [1]";
  res
    .writeHead(200, { "content-type": "text/event-stream" })
    .end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
    );
});
async function api(path, data) {
  const response = await fetch("http://localhost:4000" + path, {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      cookie: "session=" + session,
      "content-type": "application/json",
    },
    body: JSON.stringify(data),
  });
  const body = await response.json();
  expect(response.ok, JSON.stringify(body)).toBe(true);
  return body;
}
test.beforeEach(async ({}, testInfo) => {
  await paceApiBudget(testInfo);
});
test.beforeAll(async () => {
  await new Promise((resolve) => provider.listen(4548, "127.0.0.1", resolve));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES(${user},${user + "@example.invalid"},'Language reviewer','unused',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(${createHash("sha256").update(session).digest("hex")},${user},now()+interval '1 hour')`;
    await tx`INSERT INTO organizations(id,name) VALUES(${org},'Multilingual browser')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES(${workspace},${org},'Language workspace')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES(${randomUUID()},${org},${user},'owner')`;
  });
  embedding = (
    await api(`/workspaces/${workspace}/embedding-models`, {
      name: "Multilingual embedding",
      provider: "openai-compatible",
      modelId: "fixture",
      baseUrl: "http://127.0.0.1:4548/v1",
      dimensions: 3,
    })
  ).id;
  kb = (
    await api(`/workspaces/${workspace}/knowledge-bases`, {
      name: "English procedures",
      embeddingModelId: embedding,
    })
  ).id;
  source = (
    await api(`/knowledge-bases/${kb}/text`, {
      title: "Password procedure",
      text: "Reset your password using the approved reset page.",
    })
  ).id;
  await expect
    .poll(
      async () => {
        const [row] =
          await sql`SELECT status FROM knowledge_sources WHERE id=${source}`;
        return row.status;
      },
      { timeout: 20000 },
    )
    .toBe("ready");
  const model = (
    await api(`/workspaces/${workspace}/models`, {
      name: "Multilingual response",
      provider: "openai-compatible",
      modelId: "language-fixture",
      baseUrl: "http://127.0.0.1:4548/v1",
      contextWindow: 32768,
      maxOutputTokens: 2048,
    })
  ).id;
  agent = (
    await api(`/workspaces/${workspace}/agents`, {
      name: "Cross-language assistant",
      config: {
        modelId: model,
        languageMode: "auto",
        rag: { knowledgeBaseIds: [kb], usageMode: "always", minScore: 0 },
      },
    })
  ).id;
});
test.afterAll(async () => {
  await cleanupKnowledgeFixtures(sql, org);
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  await sql.begin(async (tx) => {
    for (const table of [
      "evaluation_results",
      "evaluation_runs",
      "agent_quality_gates",
      "evaluation_datasets",
      "messages",
      "agent_runs",
      "conversations",
      "agent_versions",
      "agents",
      "model_configurations",
      "knowledge_jobs",
      "knowledge_documents",
      "knowledge_sources",
      "knowledge_bases",
      "embedding_models",
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
async function open(page, context) {
  await context.addCookies([
    {
      name: "session",
      value: session,
      url: "http://localhost:3000",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/");
}
test("Guided multilingual cases evaluate retrieval, citations and scripts with language-pair reporting", async ({
  page,
  context,
}) => {
  await open(page, context);
  await page.getByRole("button", { name: "Quality", exact: true }).click();
  await page.getByRole("button", { name: "New dataset", exact: true }).click();
  await page.getByLabel("Dataset name").fill("Language coverage");
  await page
    .getByText("Add multilingual retrieval cases", { exact: true })
    .click();
  await page
    .getByLabel("Shared intent", { exact: true })
    .fill("Password reset");
  await page
    .getByLabel("Multilingual knowledge base", { exact: true })
    .selectOption(kb);
  await page
    .getByLabel("Expected retrieved source", { exact: true })
    .selectOption(source);
  await page
    .getByLabel("Variant 1 question", { exact: true })
    .fill("How to reset my password?");
  await page
    .getByLabel("Variant 1 required phrase", { exact: true })
    .fill("password");
  await page
    .getByLabel("Variant 1 script", { exact: true })
    .selectOption("Latin");
  await page
    .getByLabel("Variant 2 question", { exact: true })
    .fill("เปลี่ยนรหัสผ่านอย่างไร");
  await page
    .getByLabel("Variant 2 required phrase", { exact: true })
    .fill("รหัสผ่าน");
  await page
    .getByLabel("Variant 2 script", { exact: true })
    .selectOption("Thai");
  await page
    .getByLabel("Variant 2 question language", { exact: true })
    .fill("not a tag");
  await page
    .getByRole("button", { name: "Add language cases to dataset", exact: true })
    .click();
  await expect(page.getByRole("alert").filter({ hasText: "Variant 2:" })).toContainText(
    "Variant 2: Use a BCP 47 language tag",
  );
  await page
    .getByLabel("Variant 2 question language", { exact: true })
    .fill("th");
  await page
    .getByRole("button", { name: "Add language cases to dataset", exact: true })
    .click();
  const examples = JSON.parse(
    await page.getByLabel("Examples (JSON array)").inputValue(),
  );
  expect(examples).toHaveLength(2);
  expect(examples[1].multilingual.expectedAnswerLanguage).toBe("th");
  await page.getByRole("button", { name: "Save dataset", exact: true }).click();
  await expect(page.getByText("Dataset saved.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Evaluation", exact: true }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption(agent);
  await page
    .getByRole("button", { name: "Run evaluation", exact: true })
    .click();
  await expect(page.getByText(/Run .* · completed/)).toBeVisible({
    timeout: 20000,
  });
  await expect(
    page.getByRole("heading", {
      name: "Multilingual retrieval validation",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "th → en / answer th", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("table")
      .filter({ has: page.getByText("By language pair", { exact: true }) }),
  ).toContainText("100.0%");
  await page.setViewportSize({ width: 390, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/multilingual-report-mobile.png",
    fullPage: true,
  });
});
test("Semantic topics are previewed without writes, selectively applied, and protect reviewer splits", async ({
  page,
  context,
}) => {
  const conversation = randomUUID();
  await sql`INSERT INTO conversations(id,workspace_id,organization_id,agent_id,user_id,config_snapshot,model_snapshot) VALUES(${conversation},${workspace},${org},${agent},${user},'{}','{}')`;
  for (const question of [
    "Reset my password",
    "กู้คืนรหัสผ่าน",
    "Find a branch",
  ]) {
    const run = randomUUID();
    await sql`INSERT INTO agent_runs(id,conversation_id,workspace_id,organization_id,status,trace_id,answer_kind) VALUES(${run},${conversation},${workspace},${org},'completed',${run},'no_answer')`;
    await sql`INSERT INTO messages(id,conversation_id,workspace_id,organization_id,run_id,role,content) VALUES(${randomUUID()},${conversation},${workspace},${org},${run},'user',${question})`;
  }
  await open(page, context);
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  await page
    .getByRole("button", { name: "Knowledge gaps", exact: true })
    .click();
  await page
    .getByText("Group related questions by meaning", { exact: true })
    .click();
  await page
    .getByLabel("Grouping embedding model", { exact: true })
    .selectOption(embedding);
  await page
    .getByRole("button", { name: "Preview related topics", exact: true })
    .click();
  const preview = page.getByRole("region", {
    name: "Grouping preview",
    exact: true,
  });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("3 questions · 2 topics");
  const [before] =
    await sql`SELECT count(*)::int AS n FROM knowledge_gap_assignments WHERE workspace_id=${workspace}`;
  expect(before.n).toBe(0);
  await preview
    .getByRole("button", { name: "Apply selected topics", exact: true })
    .click();
  await expect(preview).toBeHidden();
  const group = page
    .locator(".knowledge-gap-row")
    .filter({ hasText: "2 occurrences" });
  await expect(group).toHaveCount(1);
  const [after] =
    await sql`SELECT count(*)::int AS n FROM knowledge_gap_assignments WHERE workspace_id=${workspace}`;
  expect(after.n).toBe(2);
  await group.locator("summary").first().click();
  await group
    .getByRole("button", { name: "Split into separate topic", exact: true })
    .first()
    .click();
  await expect
    .poll(async () => {
      const [row] =
        await sql`SELECT count(*)::int AS n FROM knowledge_gap_assignments WHERE workspace_id=${workspace} AND method='reviewer'`;
      return row.n;
    })
    .toBe(1);
  await page
    .getByRole("button", { name: "Preview related topics", exact: true })
    .click();
  await expect(preview).toContainText("1 reviewer-protected runs");
  await page.setViewportSize({ width: 390, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/semantic-gap-preview-mobile.png",
    fullPage: true,
  });
  await preview
    .getByRole("button", { name: "Discard preview", exact: true })
    .click();
});
