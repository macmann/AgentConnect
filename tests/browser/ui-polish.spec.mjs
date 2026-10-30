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
  const trigger = page.getByRole("button", {
    name: "About test examples",
    exact: true,
  });
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
test("guided connector steps retain values and explain missing setup", async ({
  page,
}) => {
  await open(page);
  await page.route(`**/workspaces/${first}/knowledge-bases`, (route) =>
    route.fulfill({ json: [{ id: "kb-preview", name: "Policies" }] }),
  );
  await page.route(`**/workspaces/${first}/secrets`, (route) =>
    route.fulfill({
      json: [{ id: "secret-preview", name: "Read-only account" }],
    }),
  );
  await page.getByRole("button", { name: "Connectors", exact: true }).click();
  await page
    .getByRole("button", { name: "Add connector", exact: true })
    .click();
  await expect(page.getByLabel("S3 bucket", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator(".error-banner[role=alert]")).toContainText(
    "Enter a name",
  );
  await page
    .getByLabel("Connector name", { exact: true })
    .fill("Policy documents");
  await page
    .getByLabel("Connector knowledge base", { exact: true })
    .selectOption("kb-preview");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Connector name", { exact: true })).toBeHidden();
  await page
    .getByLabel("Source workspace credential", { exact: true })
    .selectOption("secret-preview");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("S3 bucket", { exact: true }).fill("policy-bucket");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(
    page.getByLabel("Source workspace credential", { exact: true }),
  ).toHaveValue("secret-preview");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("S3 bucket", { exact: true })).toHaveValue(
    "policy-bucket",
  );
  await expect(
    page.getByRole("button", { name: "Save connector", exact: true }),
  ).toBeEnabled();
});

test("question editor preserves advanced assertions and paginates imported examples", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: "Quality", exact: true }).click();
  await page.getByRole("button", { name: "New dataset", exact: true }).click();
  const raw = page.getByLabel("Examples (JSON array)", { exact: true });
  await expect(raw).toBeHidden();
  await page
    .getByLabel("Question 1", { exact: true })
    .fill("How do I reset access?");
  await page.getByText("Advanced JSON / import", { exact: true }).click();
  expect(JSON.parse(await raw.inputValue())[0].contains).toEqual(["hello"]);
  await raw.fill(
    JSON.stringify(
      Array.from({ length: 7 }, (_, i) => ({
        input: `Question ${i + 1}`,
        expectedBehavior: "Help",
        tags: ["retain"],
        contains: ["policy"],
      })),
    ),
  );
  await expect(page.locator(".quality-example-row")).toHaveCount(5);
  await page
    .getByRole("button", { name: "Next questions", exact: true })
    .click();
  await page
    .getByLabel("Question 6", { exact: true })
    .fill("Edited sixth question");
  const edited = JSON.parse(await raw.inputValue());
  expect(edited[5]).toEqual({
    input: "Edited sixth question",
    expectedBehavior: "Help",
    tags: ["retain"],
    contains: ["policy"],
  });
  expect(edited).toHaveLength(7);
  await raw.fill("invalid JSON");
  await expect(page.locator(".error-banner[role=alert]")).toContainText(
    "JSON array of objects",
  );
  await raw.fill("[]");
  await page.getByRole("button", { name: "Add question", exact: true }).click();
  await expect(page.getByLabel("Question 1", { exact: true })).toBeVisible();
});

test("console pages fit mobile, tablet and desktop in both themes", async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  await open(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => {
        localStorage.setItem("agent-connex-theme", theme);
        document.documentElement.dataset.theme = theme;
      }, theme);
      for (const destination of [
        "Agents",
        "Workflows",
        "Knowledge",
        "Connectors",
        "Skills",
        "Tools",
        "Models",
        "Quality",
        "Operations",
        "Channels",
        "Secrets",
      ]) {
        await page.goto(
          `/#view=${destination}&organization=${org}&workspace=${first}`,
        );
        await expect(page.locator("h1")).toHaveText(destination);
        await expect(page.locator(".panel").first()).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          `${destination} at ${width} in ${theme}`,
        ).toBe(true);
        const collisions = await page
          .locator(".panel-header")
          .evaluateAll((headers) =>
            headers.flatMap((header) => {
              const boxes = [...header.children]
                .map((child) => child.getBoundingClientRect())
                .filter((box) => box.width && box.height);
              return boxes.flatMap((a, i) =>
                boxes
                  .slice(i + 1)
                  .filter(
                    (b) =>
                      Math.min(a.right, b.right) - Math.max(a.left, b.left) >
                        1 &&
                      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1,
                  ),
              );
            }),
          );
        expect(
          collisions,
          `${destination} header controls overlap at ${width}`,
        ).toHaveLength(0);
        if (width === 1440 || width === 390)
          await page.screenshot({
            path: testInfo.outputPath(`${destination}-${theme}-${width}.png`),
            fullPage: true,
          });
      }
    }
  }
  expect(errors).toEqual([]);
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
