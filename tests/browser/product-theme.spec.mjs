import { test, expect } from "@playwright/test";
import { createServer } from "node:http";

test("Product logo and theme persist across reloads, system changes and mobile layouts", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("img.product-logo-dark")).toBeVisible();
  await page
    .getByRole("button", { name: "Switch to light theme", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("img.product-logo-light")).toBeVisible();
  await expect(page.locator("img.product-logo-dark")).toBeHidden();
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
  const light = await page.request.get("/agent-connex-logo-light.svg");
  const widgetLight = await page.request.get(
    "http://localhost:4000/brand/agent-connex-logo-light.svg",
  );
  expect(light.ok()).toBe(true);
  expect(widgetLight.ok()).toBe(true);
  expect(await widgetLight.text()).toBe(await light.text());
  expect(await light.text()).toContain(".logo-text-connex { fill: #0F172A; }");
  expect(errors).toEqual([]);
});

test("Widget product logo follows its own theme switcher", async ({ page }) => {
  const site = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      '<html><body><script src="http://localhost:4000/widget.js" data-deployment="00000000-0000-4000-8000-000000000001"></script></body></html>',
    );
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  try {
    await page.route("http://localhost:4000/public/widgets/**", (route) =>
      route.fulfill({
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(
          route.request().url().endsWith("/sessions")
            ? { token: "fixture" }
            : {
                name: "Logo preview",
                widget: {
                  theme: "light",
                  width: 420,
                  height: 720,
                  position: "right",
                  language: "en",
                  launcher: "Chat",
                },
                branding: {},
              },
        ),
      }),
    );
    await page.goto("http://localhost:" + site.address().port);
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    const logo = page.getByRole("img", { name: "Agent Connex", exact: true });
    await expect(logo).toHaveAttribute("src", /agent-connex-logo-light.svg$/);
    await expect
      .poll(() => logo.evaluate((img) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    await page
      .getByRole("button", { name: "Switch to dark theme", exact: true })
      .click();
    await expect(logo).toHaveAttribute("src", /agent-connex-logo.svg$/);
    await expect
      .poll(() => logo.evaluate((img) => img.complete && img.naturalWidth > 0))
      .toBe(true);
  } finally {
    site.closeAllConnections();
    await new Promise((resolve) => site.close(resolve));
  }
});
