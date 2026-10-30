import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const sql = postgres(process.env.DATABASE_URL, { max: 1 }),
  org = randomUUID(),
  workspace = randomUUID(),
  user = randomUUID(),
  session = randomUUID(),
  secret = randomUUID(),
  attempt = randomUUID();
test.beforeAll(async () => {
  await sql`INSERT INTO organizations(id,name) VALUES(${org},'Connector browser sample')`;
  await sql`INSERT INTO workspaces(id,organization_id,name) VALUES(${workspace},${org},'Source workspace')`;
  await sql`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES(${user},${user + "@example.invalid"},'Source administrator','unused',now())`;
  await sql`INSERT INTO memberships(id,organization_id,user_id,role) VALUES(${randomUUID()},${org},${user},'owner')`;
  await sql`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(${createHash("sha256").update(session).digest("hex")},${user},now()+interval '1 hour')`;
});
test.afterAll(async () => {
  for (const table of ["audit_events", "memberships", "workspaces"])
    await sql`DELETE FROM ${sql(table)} WHERE organization_id=${org}`;
  await sql`DELETE FROM organizations WHERE id=${org}`;
  await sql`DELETE FROM sessions WHERE user_id=${user}`;
  await sql`DELETE FROM users WHERE id=${user}`;
  await sql.end();
});
test("Guided connector sign-in selects an account, browses folders and preserves selected source IDs", async ({
  page,
  context,
}) => {
  await context.addCookies([
    {
      name: "session",
      value: session,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  // Explicit browser-only OAuth protocol fixture; API exchange/refresh are tested separately.
  await context.route("**/connectors/oauth/providers", (r) =>
    r.fulfill({ json: [{ provider: "google-drive", ready: true }] }),
  );
  await context.route("**/connectors/oauth/start", (r) =>
    r.fulfill({
      json: { id: attempt, url: "http://localhost:3000/oauth-browser-fixture" },
    }),
  );
  await context.route("**/oauth-browser-fixture", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<h1>Fixture authorization complete</h1>",
    }),
  );
  await context.route("**/connectors/oauth/" + attempt, (r) =>
    r.fulfill({
      json: { status: "connected", secret_id: secret, error_code: null },
    }),
  );
  await context.route("**/workspaces/" + workspace + "/secrets", (r) =>
    r.fulfill({ json: [{ id: secret, name: "OAuth Google Drive sample" }] }),
  );
  await context.route("**/connectors/browse", (r) =>
    r.fulfill({
      json: {
        folderId: "policies-folder",
        items: [
          { id: "product-folder", name: "Product policies", type: "folder" },
        ],
        truncated: false,
      },
    }),
  );
  await page.goto(
    "/#view=Connectors&organization=" + org + "&workspace=" + workspace,
  );
  await page
    .getByRole("button", { name: "Add connector", exact: true })
    .click();
  await page.getByLabel("Connector provider").selectOption("google-drive");
  await page.getByRole("button", { name: /2\s*Account/ }).click();
  await page
    .getByRole("button", { name: "Sign in with Google", exact: true })
    .click();
  await expect(
    page.getByText("Signed in. Select your source, then save and synchronize."),
  ).toBeVisible();
  await expect(page.getByLabel("Source workspace credential")).toHaveValue(
    secret,
  );
  await page.getByRole("button", { name: /3\s*Source & sync/ }).click();
  await page
    .getByText("2. Choose a folder or channel", { exact: true })
    .click();
  await page
    .getByRole("button", { name: "Browse sources", exact: true })
    .click();
  await expect(page.getByLabel("Available sources")).toContainText(
    "Product policies",
  );
  await page
    .getByRole("button", { name: "Use current folder", exact: true })
    .click();
  await expect(
    page.getByLabel("Google Drive folder ID", { exact: true }),
  ).toHaveValue("policies-folder");
  await page.setViewportSize({ width: 360, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
