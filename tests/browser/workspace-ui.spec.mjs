import { paceApiBudget } from "../helpers/api-budget.mjs";
import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
test.use({ actionTimeout: 15000 });
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const org = randomUUID(),
  workspace = randomUUID(),
  user = randomUUID(),
  session = randomUUID();
test.beforeEach(async ({}, testInfo) => {
  await paceApiBudget(testInfo);
});
test.beforeAll(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${user},${user + "@example.invalid"},'Workspace UI','unused',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(session).digest("hex")},${user},now()+interval '1 hour')`;
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'UI browser')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'UI workspace')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${user},'owner')`;
  });
});
test.afterAll(async () => {
  await sql.begin(async (tx) => {
    for (const table of ["workspace_retention", "audit_events", "memberships"])
      await tx.unsafe(`DELETE FROM ${table} WHERE workspace_id=$1`, [
        workspace,
      ]);
    await tx`DELETE FROM memberships WHERE organization_id=${org}`;
    await tx`DELETE FROM workspaces WHERE id=${workspace}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    await tx`DELETE FROM sessions WHERE user_id=${user}`;
    await tx`DELETE FROM users WHERE id=${user}`;
  });
  await sql.end();
});
test("workspace sections preserve edits, support direct links and history, and fit mobile", async ({
  page,
}) => {
  async function navigate(name) {
    console.log("Workspace UI: navigate", name);
    const opener = page.getByRole("button", {
      name: "Open navigation",
      exact: true,
    });
    if (await opener.isVisible()) await opener.click();
    await page.getByRole("button", { name, exact: true }).click();
  }
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.context().addCookies([
    {
      name: "session",
      value: session,
      url: "http://localhost:3000",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto(`/#view=Tools&organization=${org}&workspace=${workspace}`);
  await expect(
    page.getByRole("heading", { name: "No tools registered yet", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toBeHidden();
  await page.screenshot({
    path: "test-results/workspace-tools-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Register your first tool", exact: true })
    .click();
  await page.getByLabel("Name", { exact: true }).fill("Unsaved lookup");
  await page
    .getByRole("button", { name: "MCP connectors", exact: true })
    .click();
  await expect(page.getByLabel("Server name", { exact: true })).toBeVisible();
  console.log("Workspace UI: browser back");
  await page.goBack();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Unsaved lookup",
  );
  console.log("Workspace UI: browser forward");
  await page.goForward();
  await expect(page.getByLabel("Server name", { exact: true })).toBeVisible();
  console.log("Workspace UI: refresh");
  await page.reload();
  await expect(page.getByLabel("Server name", { exact: true })).toBeVisible();
  console.log("Workspace UI: mobile");
  await page.setViewportSize({ width: 360, height: 800 });
  await page
    .getByLabel("Tools sections", { exact: true })
    .selectOption("registry");
  await expect(
    page.getByRole("heading", { name: "No tools registered yet", exact: true }),
  ).toBeVisible();
  await navigate("Knowledge");
  await page
    .getByLabel("Knowledge sections", { exact: true })
    .selectOption("embeddings");
  await expect(
    page.getByRole("heading", { name: "No embedding models yet", exact: true }),
  ).toBeVisible();
  await navigate("Channels");
  await page
    .getByLabel("Channels sections", { exact: true })
    .selectOption("inbox");
  await expect(
    page.getByRole("heading", { name: "Human support inbox", exact: true }),
  ).toBeVisible();
  await navigate("Quality");
  await page
    .getByLabel("Quality sections", { exact: true })
    .selectOption("evaluate");
  await expect(
    page.getByText("Dataset: None selected", { exact: true }),
  ).toBeVisible();
  await navigate("Retention");
  await page
    .getByLabel("Conversations retention days", { exact: true })
    .fill("42");
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Retention sections", { exact: true })
    .selectOption("history");
  await page
    .getByLabel("Retention sections", { exact: true })
    .selectOption("policy");
  await expect(
    page.getByLabel("Conversations retention days", { exact: true }),
  ).toHaveValue("42");
  page.once("dialog", (d) => d.dismiss());
  await navigate("Knowledge");
  await page
    .getByRole("button", { name: "Close navigation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Data retention", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page
    .getByLabel("Conversations retention days", { exact: true })
    .fill("43");
  const controlBounds = await page
    .getByLabel("Conversations retention days", { exact: true })
    .boundingBox();
  const barBounds = await page.locator(".workspace-save-bar").boundingBox();
  expect(controlBounds.y + controlBounds.height).toBeLessThan(barBounds.y);
  const bounds = await page
    .getByRole("button", { name: "Save retention settings", exact: true })
    .boundingBox();
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(800);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/workspace-retention-mobile.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  expect(errors).toEqual([]);
});
