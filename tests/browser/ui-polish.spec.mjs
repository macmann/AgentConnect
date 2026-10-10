import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const org = randomUUID(),
  first = randomUUID(),
  second = randomUUID(),
  user = randomUUID(),
  session = randomUUID();
test.beforeAll(async () => {
  await sql`INSERT INTO organizations(id,name) VALUES (${org},'UI browser organization')`;
  await sql`INSERT INTO workspaces(id,organization_id,name) VALUES (${first},${org},'Alpha workspace'),(${second},${org},'Beta workspace')`;
  await sql`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${user},${user + "@example.invalid"},'UI Reviewer','unused',now())`;
  await sql`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(session).digest("hex")},${user},now()+interval '1 hour')`;
  await sql`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${user},'owner')`;
});
test.afterAll(async () => {
  await sql`DELETE FROM audit_events WHERE organization_id=${org} OR actor_id=${user}`;
  await sql`DELETE FROM secrets WHERE organization_id=${org}`;
  await sql`DELETE FROM memberships WHERE organization_id=${org}`;
  await sql`DELETE FROM workspaces WHERE organization_id=${org}`;
  await sql`DELETE FROM organizations WHERE id=${org}`;
  await sql`DELETE FROM sessions WHERE user_id=${user}`;
  await sql`DELETE FROM users WHERE id=${user}`;
  await sql.end();
});
async function open(page) {
  await page.context().addCookies([
    {
      name: "session",
      value: session,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Good to see you, UI." }),
  ).toBeVisible();
}
test("navigation preserves page and workspace through refresh and Back", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Model registry" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New workspace", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Current workspace").selectOption(second);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Models", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Current workspace")).toHaveValue(second);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page
    .getByRole("button", { name: "Register a model", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Models", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await page.getByRole("link", { name: "Skip to content" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#workspace-content")).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "Agents", exact: true }),
  ).toBeVisible();
});
test("mobile drawer, forms and dialogs fit the viewport and restore focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const trigger = page.getByRole("button", { name: "Open navigation" });
  await trigger.click();
  const nav = page.getByRole("dialog", { name: "Workspace navigation" });
  await expect(nav.getByLabel("Organization")).toBeVisible();
  await nav.getByRole("button", { name: "Models", exact: true }).click();
  await expect(nav).toHaveCount(0);
  await page
    .getByRole("button", { name: "Register model", exact: true })
    .click();
  await expect(page.getByLabel("Display name")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(nav).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Secrets", exact: true })
    .click();
  await page.getByRole("button", { name: "Add secret", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add encrypted secret" });
  await expect(dialog).toBeVisible();
  const rect = await dialog.boundingBox();
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add secret", exact: true }),
  ).toBeFocused();
});
test("API outages offer retry and non-JSON failures remain readable", async ({
  page,
}) => {
  await page.route("**/auth/me", (route) =>
    route.fulfill({
      status: 503,
      contentType: "text/html",
      body: "<html>Unavailable</html>",
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Unable to connect" }),
  ).toBeVisible();
  await expect(
    page.getByRole("alert").filter({ hasText: /HTTP/ }),
  ).toContainText("HTTP 503");
  await page.unroute("**/auth/me");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: "Create your account" }),
  ).toBeVisible();
  await open(page);
  await page.route("**/workspaces/*/secrets", (route) =>
    route.fulfill({
      status: 502,
      contentType: "text/html",
      body: "Bad Gateway",
    }),
  );
  await page.getByRole("button", { name: "Secrets", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("alert").filter({ hasText: /HTTP/ }),
  ).toContainText("HTTP 502");
  await expect(page.getByText("No secrets yet.")).toHaveCount(0);
});
test("sign out removes private workspace state", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Create your account" }),
  ).toBeVisible();
  await expect(page.getByLabel("Current workspace")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Create your account" }),
  ).toBeVisible();
});
