import { test, expect } from "@playwright/test";

test("generated not-found page supports system theme, persistence and synchronization", async ({
  page,
  context,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ colorScheme: "dark" });
  const response = await page.goto("/theme-test-missing-page");
  expect(response.status()).toBe(404);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const light = page.getByRole("button", { name: "Switch to light theme" });
  await expect(light).toBeVisible();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(light).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  const other = await context.newPage();
  await other.goto("/theme-test-missing-page");
  await other.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(
    page.getByRole("button", { name: "Switch to dark theme" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
