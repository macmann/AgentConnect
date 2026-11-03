import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
import { cleanupKnowledgeFixtures } from "../../apps/api/test/knowledge-cleanup.mjs";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
test.use({ actionTimeout: 15000 });
const sql = postgres(process.env.DATABASE_URL, { max: 1 }),
  org = randomUUID(),
  workspace = randomUUID(),
  embedding = randomUUID(),
  kb = randomUUID(),
  model = randomUUID(),
  source = randomUUID(),
  golden = randomUUID(),
  manual = randomUUID(),
  failed = randomUUID(),
  conversation = randomUUID();
const sessions = {};
test.beforeAll(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES(${org},'Compact knowledge browser')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES(${workspace},${org},'Knowledge workspace')`;
    for (const role of ["owner", "analyst"]) {
      const uid = randomUUID(),
        session = randomUUID();
      sessions[role] = session;
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES(${uid},${uid + "@example.invalid"},${role},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(${createHash("sha256").update(session).digest("hex")},${uid},now()+interval '1 hour')`;
      await tx`INSERT INTO memberships(id,organization_id,user_id,role,workspace_id) VALUES(${randomUUID()},${org},${uid},${role},${role === "owner" ? null : workspace})`;
    }
    await tx`INSERT INTO embedding_models(id,organization_id,workspace_id,name,provider,model_id,base_url,dimensions) VALUES(${embedding},${org},${workspace},'Fixture embedding','openai-compatible','fixture','https://example.test/v1',3)`;
    await tx`INSERT INTO model_configurations(id,organization_id,workspace_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES(${model},${org},${workspace},'Tagging model','openai-compatible','fixture','https://example.test/v1',32768,8192,'{"streaming":true,"temperature":false,"topP":false}')`;
    await tx`INSERT INTO knowledge_bases(id,organization_id,workspace_id,name,description,embedding_model_id,dimensions,chunk_size,chunk_overlap,chunk_strategy) VALUES(${kb},${org},${workspace},'Compact knowledge','Source row browser fixture',${embedding},3,500,0,'recursive')`;
    for (const [id, kind, title, status, metadata] of [
      [
        source,
        "text",
        "A document with a long descriptive title that should stay on one line in the knowledge list",
        "ready",
        {
          tags: ["policy"],
          attributes: { department: "support" },
          metadataRevision: 0,
        },
      ],
      [
        golden,
        "qa",
        "week 5 study materials",
        "ready",
        {
          question: "week 5 study materials",
          answer: "Review chapters five and six.\nPractise the examples.",
          goldenAnswer: true,
          provenance: { conversationId: conversation },
          tags: ["golden-answer", "conversation-history"],
        },
      ],
      [
        manual,
        "qa",
        "Test",
        "ready",
        { question: "Test", answer: "A manually added answer." },
      ],
      [failed, "text", "Source that needs review", "failed", {}],
    ])
      await tx`INSERT INTO knowledge_sources(id,knowledge_base_id,organization_id,workspace_id,kind,title,status,metadata,error_code) VALUES(${id},${kb},${org},${workspace},${kind},${title},${status},${tx.json(metadata)},${id === failed ? "EMPTY_DOCUMENT" : null})`;
  });
});
test.afterAll(async () => {
  await cleanupKnowledgeFixtures(sql, org);
  const users =
    await sql`SELECT DISTINCT user_id FROM memberships WHERE organization_id=${org}`;
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
    for (const u of users) {
      await tx`DELETE FROM sessions WHERE user_id=${u.user_id}`;
      await tx`DELETE FROM users WHERE id=${u.user_id}`;
    }
  });
  await sql.end();
});
async function open(page, context, role = "owner") {
  await context.addCookies([
    {
      name: "session",
      value: sessions[role],
      url: "http://localhost:3000",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto(
    `/#view=Knowledge&organization=${org}&workspace=${workspace}`,
  );
  await page.getByRole("button", { name: /Compact knowledge/ }).click();
}
async function menu(page, row) {
  await row.getByRole("button", { name: /More actions for/ }).click();
  return page.getByRole("menu");
}
test("Q&A stays in single rows and opens full details and source provenance in a dialog", async ({
  page,
  context,
}, testInfo) => {
  await open(page, context);
  await page.getByRole("button", { name: /^Q&A \(/ }).click();
  const row = page
    .getByRole("row")
    .filter({ hasText: "week 5 study materials" });
  await expect(row.locator("details, form")).toHaveCount(0);
  expect((await row.boundingBox()).height).toBeLessThanOrEqual(64);
  await expect(
    row.getByRole("button", { name: "Inspect chunks", exact: true }),
  ).toHaveCount(0);
  const actions = await menu(page, row);
  await expect(
    actions.getByRole("menuitem", { name: "Advanced settings", exact: true }),
  ).toBeVisible();
  await expect(
    actions.getByRole("menuitem", { name: "Inspect chunks", exact: true }),
  ).toBeDisabled();
  await actions
    .getByRole("menuitem", { name: "View details", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Source details",
    exact: true,
  });
  await expect(dialog).toContainText("Review chapters five and six.");
  await expect(dialog).toContainText("Moderated from chat history");
  await expect(
    dialog.getByRole("link", { name: "View source conversation" }),
  ).toHaveAttribute("href", new RegExp(conversation));
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator("body")).not.toHaveCSS("pointer-events", "none");
  await expect(row.getByRole("button", { name: /More actions/ })).toBeFocused();
  await page
    .getByRole("button", { name: "Switch to dark theme", exact: true })
    .click();
  await page.screenshot({
    path: testInfo.outputPath("knowledge-qa-compact-dark.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 360, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  expect((await row.boundingBox()).height).toBeLessThanOrEqual(64);
  await menu(page, row);
  await page
    .getByRole("menuitem", { name: "Advanced settings", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Advanced settings", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath("knowledge-advanced-mobile.png"),
    fullPage: true,
  });
});
test("Advanced settings supports metadata saves, protects unsaved edits and lets builders select an AI model", async ({
  page,
  context,
}) => {
  await open(page, context);
  const row = page
    .getByRole("row")
    .filter({ hasText: "A document with a long descriptive title" });
  await menu(page, row);
  await page
    .getByRole("menuitem", { name: "Advanced settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Advanced settings",
    exact: true,
  });
  const editor = dialog.getByRole("form", { name: /Metadata for A document/ });
  await editor.getByLabel("Tags", { exact: true }).fill("policy, reviewed");
  page.once("dialog", (d) => d.dismiss());
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(editor.getByLabel("Tags", { exact: true })).toHaveValue(
    "policy, reviewed",
  );
  await editor
    .getByRole("button", { name: "Save metadata", exact: true })
    .click();
  await expect(editor.getByRole("status")).toContainText("Metadata saved");
  const [saved] =
    await sql`SELECT metadata FROM knowledge_sources WHERE id=${source}`;
  expect(saved.metadata.tags).toEqual(["policy", "reviewed"]);
  await dialog
    .getByRole("button", { name: "AI metadata tagging", exact: true })
    .click();
  await dialog
    .getByRole("switch", { name: "Suggest metadata with AI" })
    .check();
  await dialog.getByLabel("AI tagging model").selectOption(model);
  await expect(
    dialog.getByRole("button", {
      name: "Generate suggestions for 1 source",
      exact: true,
    }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row.locator("form, details")).toHaveCount(0);
});
test("Keyboard menu access, warnings and read-only permissions remain available", async ({
  page,
  context,
}) => {
  await open(page, context, "analyst");
  const row = page
    .getByRole("row")
    .filter({ hasText: "Source that needs review" });
  await row.getByRole("button", { name: /More actions/ }).focus();
  await page.keyboard.press("ArrowDown");
  const actions = page.getByRole("menu");
  await expect(actions).toBeVisible();
  await expect(
    actions.getByRole("menuitem", { name: "Advanced settings", exact: true }),
  ).toHaveCount(0);
  await expect(
    actions.getByRole("menuitem", { name: "Remove", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await row
    .getByRole("button", {
      name: "Review warnings for Source that needs review",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Source details",
    exact: true,
  });
  await expect(dialog).toContainText("EMPTY_DOCUMENT");
  await expect(dialog).toContainText("Try Firecrawl");
});
