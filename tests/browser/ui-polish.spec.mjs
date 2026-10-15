import { paceApiBudget } from "../helpers/api-budget.mjs";
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
test.beforeEach(async ({}, testInfo) => {
  await paceApiBudget(testInfo);
});
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
test("compact help is accessible and connector actions are separated", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "Connectors", exact: true }).click();
  const create = page.getByRole("button", {
    name: "Create a knowledge base",
    exact: true,
  });
  const credential = page.getByRole("button", {
    name: "Add source credential",
    exact: true,
  });
  await expect(create).toBeVisible();
  const firstBox = await create.boundingBox(),
    secondBox = await credential.boundingBox();
  expect(secondBox.x - firstBox.x - firstBox.width).toBeGreaterThanOrEqual(10);
  await page.getByRole("button", { name: "Quality", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Quality lab", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Internal server error", { exact: false }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "New dataset", exact: true }).click();
  const tooltip = page
    .getByRole("tooltip", { includeHidden: true })
    .filter({ hasText: "Example IDs" });
  const trigger = page
    .locator(".help-tooltip")
    .filter({ has: tooltip })
    .getByRole("button");
  await expect(tooltip).toBeHidden();
  await trigger.hover();
  await expect(tooltip).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
  await trigger.focus();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
});

test("panel bodies keep a shared gutter across studios and themes", async ({
  page,
}) => {
  await open(page);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) => document.documentElement.setAttribute("data-theme", theme),
        theme,
      );
      for (const destination of [
        "Workflows",
        "Knowledge",
        "Tools",
        "Models",
        "Quality",
      ]) {
        await page.goto(
          `/#view=${encodeURIComponent(destination)}&organization=${org}&workspace=${first}`,
        );
        await expect(
          page.getByRole("heading", { name: destination, exact: true }).first(),
        ).toBeVisible();
        await expect(page.locator(".panel").first()).toBeVisible();
        await page.evaluate(
          (theme) => document.documentElement.setAttribute("data-theme", theme),
          theme,
        );
        const panels = await page.locator(".panel").evaluateAll((elements) =>
          elements
            .filter((el) => el.getBoundingClientRect().width > 0)
            .map((el) => {
              const style = getComputedStyle(el);
              return {
                left: parseFloat(style.paddingLeft),
                right: parseFloat(style.paddingRight),
              };
            }),
        );
        for (const panel of panels) {
          expect(panel.left).toBeGreaterThanOrEqual(width < 600 ? 16 : 24);
          expect(panel.right).toBeGreaterThanOrEqual(width < 600 ? 16 : 24);
        }
        if (destination === "Workflows") {
          const panel = await page.locator(".workflow-studio").boundingBox();
          const template = await page
            .getByText("Start from a template", { exact: true })
            .boundingBox();
          expect(template.x - panel.x).toBeGreaterThanOrEqual(
            width < 600 ? 16 : 24,
          );
          await page.screenshot({
            path: `/tmp/panel-gutters-${theme}-${width}.png`,
            fullPage: true,
          });
        }
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
      }
    }
  }
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
