import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const org = randomUUID(),
  workspace = randomUUID(),
  user = randomUUID(),
  session = randomUUID(),
  workflow = randomUUID(),
  legacy = randomUUID(),
  legacyVersion = randomUUID();
const graph = {
  schemaVersion: 1,
  inputFields: [],
  nodes: [
    {
      id: "start",
      type: "input",
      position: { x: 0, y: 0 },
      data: { label: "Input" },
    },
    {
      id: "end",
      type: "output",
      position: { x: 250, y: 0 },
      data: { label: "Output" },
    },
  ],
  edges: [{ id: "edge", source: "start", target: "end" }],
};
test.beforeAll(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${user},${user + "@example.com"},'Workflow automation','not-used',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(session).digest("hex")},${user},now()+interval '1 hour')`;
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Automation browser')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Automation')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${user},'owner')`;
    await tx`INSERT INTO workflows(id,workspace_id,organization_id,name,description,draft_graph,created_by) VALUES (${workflow},${workspace},${org},'Automation example','',${tx.json(graph)},${user})`;
    const oldGraph = { ...graph };
    delete oldGraph.inputFields;
    await tx`INSERT INTO workflows(id,workspace_id,organization_id,name,description,draft_graph,created_by) VALUES (${legacy},${workspace},${org},'Legacy automation','',${tx.json(oldGraph)},${user})`;
    await tx`INSERT INTO workflow_versions(id,workflow_id,workspace_id,organization_id,version,name,graph,published_by) VALUES (${legacyVersion},${legacy},${workspace},${org},1,'Legacy automation',${tx.json(oldGraph)},${user})`;
  });
});
test.afterAll(async () => {
  await sql.begin(async (tx) => {
    for (const table of [
      "workflow_node_runs",
      "workflow_runs",
      "workflow_schedules",
      "workspace_api_keys",
      "workflow_versions",
      "workflows",
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
test("typed inputs, schedule preview and pause/resume work from the workflow interface", async ({
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
    `/#view=Workflows&organization=${org}&workspace=${workspace}`,
  );
  await page
    .getByRole("button", { name: "Automation example", exact: true })
    .click();
  await page.locator('.react-flow__node[data-id="start"]').click();
  await page
    .getByRole("button", { name: "Add input field", exact: true })
    .click();
  await page.getByLabel("Field name", { exact: true }).fill("question");
  await page.getByLabel("Label", { exact: true }).fill("Question");
  await page.getByLabel("Required", { exact: true }).check();
  const save = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/workflows/${workflow}`) &&
      r.request().method() === "PUT",
  );
  await page
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  expect((await save).ok()).toBe(true);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const publish = page.waitForResponse(
    (r) => r.url().endsWith("/publish") && r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Publish workflow", exact: true })
    .click();
  expect((await publish).status()).toBe(201);
  await page.getByRole("button", { name: "Triggers", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Workflow triggers" }),
  ).toBeVisible();
  await expect(page.locator(".workflow-editor")).not.toBeVisible();
  await page.getByLabel("Timezone", { exact: true }).fill("Asia/Yangon");
  await page
    .getByLabel("Question *", { exact: true })
    .fill("Scheduled question");
  await page.getByRole("button", { name: "Preview next runs" }).click();
  await expect(page.locator(".workflow-triggers li")).toHaveCount(5);
  const create = page.waitForResponse(
    (r) => r.url().endsWith("/schedules") && r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  expect((await create).status()).toBe(201);
  await expect(
    page.getByRole("heading", { name: "Daily workflow · Enabled" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Daily workflow · Paused" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit schedule" }).click();
  await page.getByLabel("Schedule enabled").check();
  await page
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Daily workflow · Enabled" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await page.getByLabel("Question *", { exact: true }).fill("Manual question");
  const run = page.waitForResponse(
    (r) => r.url().endsWith("/runs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Run workflow", exact: true }).click();
  const res = await run;
  expect(res.status()).toBe(202);
  expect(res.request().postDataJSON().input).toBe(
    '{"question":"Manual question"}',
  );
});

test("existing published workflows retain their text input test form", async ({
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
    `/#view=Workflows&organization=${org}&workspace=${workspace}`,
  );
  await page
    .getByRole("button", { name: "Legacy automation", exact: true })
    .click();
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(page.getByRole("combobox", { name: /Run version/ })).toBeVisible(
    { timeout: 5000 },
  );
  await page
    .getByRole("combobox", { name: /Run version/ })
    .selectOption(legacyVersion);
  await page
    .getByLabel("Workflow input", { exact: true })
    .fill("Legacy text input");
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/workflows/${legacy}/runs`) &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Run workflow", exact: true }).click();
  const run = await response;
  expect(run.status()).toBe(202);
  expect(run.request().postDataJSON().input).toBe("Legacy text input");
});
