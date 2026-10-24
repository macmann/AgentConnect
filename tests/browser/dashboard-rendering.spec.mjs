import { test, expect } from "@playwright/test";

test("dashboard serves a client-only shell and mounts authentication in the browser", async ({
  page,
  request,
}) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const html = await response.text();
  expect(html).toContain("Loading workspace…");
  // The console form must not execute on the server, even on a real request.
  expect(html).not.toContain('<div class="auth">');

  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/auth/me", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "Unauthorized" }),
    }),
  );
  await page.goto("/#view=Agents");
  await expect(page.getByLabel(/^Password/)).toBeVisible();
  await page
    .getByRole("button", { name: "Already have an account? Sign in" })
    .click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).hash).toBe("#view=Agents");
  expect(errors).toEqual([]);
});
