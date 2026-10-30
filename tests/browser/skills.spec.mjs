import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
const { zipSync, strToU8 } = createRequire(
  new URL("../../apps/api/package.json", import.meta.url),
)("fflate");
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production mode");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const org = randomUUID(),
  workspace = randomUUID(),
  user = randomUUID(),
  session = randomUUID(),
  model = randomUUID();
const provider = createServer(async (req, res) => {
  let body = "";
  for await (const part of req) body += part;
  const input = JSON.parse(body);
  const system = input.messages.find((m) => m.role === "system")?.content ?? "";
  const text = system.includes("SKILL_MARKER_V2")
    ? "SKILL_V2_USED"
    : system.includes("SKILL_MARKER_V1")
      ? "SKILL_V1_USED"
      : "NO_SKILL_LOADED";
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
  );
});
const markdown = (marker) =>
  `---\nname: report-writer\ndescription: Write concise structured reports\n---\n# Report writing\nUse ${marker}. Start with findings, then risks and next steps. Never invent figures.`;
const url = (view, extra = "") =>
  `/#view=${view}&organization=${org}&workspace=${workspace}${extra}`;
test.beforeAll(async () => {
  await new Promise((resolve) => provider.listen(4566, "127.0.0.1", resolve));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES(${user},${user + "@example.com"},'Skill Builder','unused',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(${createHash("sha256").update(session).digest("hex")},${user},now()+interval '1 hour')`;
    await tx`INSERT INTO organizations(id,name) VALUES(${org},'Skills browser fixture')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES(${workspace},${org},'Skill workspace')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES(${randomUUID()},${org},${user},'owner')`;
    await tx`INSERT INTO model_configurations(id,workspace_id,organization_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES(${model},${workspace},${org},'Skill model','openai-compatible','fixture','http://127.0.0.1:4566/v1',32768,4096,${tx.json({ streaming: true, temperature: true, topP: true })})`;
  });
});
test.afterAll(async () => {
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  try {
    await sql.begin(async (tx) => {
      for (const table of [
        "messages",
        "agent_runs",
        "conversations",
        "deployments",
        "agent_versions",
        "agents",
        "agent_skill_versions",
        "agent_skills",
        "model_configurations",
        "audit_events",
        "memberships",
        "workspaces",
      ])
        await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
      await tx`DELETE FROM organizations WHERE id=${org}`;
      await tx`DELETE FROM users WHERE id=${user}`;
    });
  } finally {
    await sql.end();
  }
});
test("Upload Markdown and ZIP skills, pin versions, inspect compatibility, and use or revoke them in Playground", async ({
  page,
  context,
}) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  await context.addCookies([
    {
      name: "session",
      value: session,
      url: "http://localhost:3000",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto(url("Skills"));
  await expect(
    page.getByText("No agent skills yet", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Upload skill file", { exact: true }).setInputFiles({
    name: "SKILL.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(markdown("SKILL_MARKER_V1")),
  });
  await expect(
    page.getByRole("heading", { name: "report-writer", exact: true }),
  ).toBeVisible();
  const [skill] =
    await sql`SELECT s.id,v.id AS version_id FROM agent_skills s JOIN agent_skill_versions v ON v.skill_id=s.id WHERE s.workspace_id=${workspace}`;
  const v1 = skill.version_id;
  await page.goto(url("Agents"));
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await page.getByRole("button", { name: /Manual setup/ }).click();
  await page.getByLabel("Agent name", { exact: true }).fill("Reporting helper");
  await page
    .getByRole("navigation", { name: "Configure sections" })
    .getByRole("button", { name: "Skills", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "report-writer", exact: true })
    .check();
  await expect(
    page.getByLabel("report-writer skill version", { exact: true }),
  ).toHaveValue(v1);
  await page
    .getByRole("button", { name: "Save and test in Playground", exact: true })
    .click();
  await expect(page.locator(".playground-chat")).toBeVisible();
  const [agent] =
    await sql`SELECT id FROM agents WHERE workspace_id=${workspace}`;
  async function ask(expected) {
    await page.getByRole("button", { name: "New chat", exact: true }).click();
    await page
      .getByLabel("Message", { exact: true })
      .fill("Write a short report");
    await page.getByLabel("Message", { exact: true }).press("Enter");
    await expect(page.getByText(expected, { exact: true })).toBeVisible();
  }
  await ask("SKILL_V1_USED");
  await page.goto(url("Skills"));
  await page.getByRole("button", { name: /report-writer/ }).click();
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Upload new version", exact: true })
    .click();
  await (
    await chooser
  ).setFiles({
    name: "report.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(
      zipSync({
        "report/SKILL.md": strToU8(markdown("SKILL_MARKER_V2")),
        "report/references/outline.md": strToU8(
          "Findings, risks, recommendations",
        ),
        "report/scripts/run.py": strToU8("not_executable()"),
      }),
    ),
  });
  await expect(
    page.getByText(/Uploaded report-writer · Version 2/),
  ).toBeVisible();
  await expect(
    page
      .locator(".skill-detail")
      .getByText(/Scripts and binary assets are not executed/),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("skills-library-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: test.info().outputPath("skills-library-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(url("Agents", `&agent=${agent.id}&stage=playground`));
  await ask("SKILL_V1_USED");
  await page.goto(
    url("Agents", `&agent=${agent.id}&stage=configure&section=skills`),
  );
  const [v2] =
    await sql`SELECT id FROM agent_skill_versions WHERE skill_id=${skill.id} AND version=2`;
  await page
    .getByLabel("report-writer skill version", { exact: true })
    .selectOption(v2.id);
  await page
    .getByRole("button", { name: "Save and test in Playground", exact: true })
    .click();
  await expect(page.locator(".playground-chat")).toBeVisible();
  await ask("SKILL_V2_USED");
  await page.goto(url("Skills"));
  await page.getByRole("button", { name: /report-writer/ }).click();
  await page.getByLabel("Enable skill", { exact: true }).uncheck();
  await expect(
    page.getByText(
      "Skill access updated. Existing agent version pins are unchanged.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.goto(url("Agents", `&agent=${agent.id}&stage=playground`));
  await ask("NO_SKILL_LOADED");
});
