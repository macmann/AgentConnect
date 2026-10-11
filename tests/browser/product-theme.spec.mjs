import { test, expect } from "@playwright/test";

test("Product logo and theme persist across reloads, system changes and mobile layouts", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    page.getByRole("img", { name: "Agent Connex", exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Switch to light theme", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "light" });
  await page
    .getByRole("button", { name: "Switch to dark theme", exact: true })
    .click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.setViewportSize({ width: 360, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "Switch to light theme", exact: true }),
  ).toBeVisible();
  if (process.env.PRODUCT_SCREENSHOTS)
    await page.screenshot({
      path: "docs/screenshots/sign-in-dark.png",
      fullPage: true,
    });
  const logo = await page.request.get("/agent-connex-logo.svg");
  expect(logo.ok()).toBe(true);
  expect(await logo.text()).toContain("CONNEX");
  const widgetLogo = await page.request.get(
    "http://localhost:4000/brand/agent-connex-logo.svg",
  );
  expect(widgetLogo.ok()).toBe(true);
  expect(await widgetLogo.text()).toBe(await logo.text());
  expect(errors).toEqual([]);
});
