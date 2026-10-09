import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const sql = postgres(process.env.DATABASE_URL, { max: 1 }),
  user = randomUUID(),
  session = randomUUID();
test.beforeAll(async () => {
  await sql`INSERT INTO users(id,email,name,password_hash) VALUES (${user},${user + "@example.com"},'Local unverified user','unused-fixture')`;
  await sql`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(session).digest("hex")},${user},now()+interval '1 hour')`;
});
test.afterAll(async () => {
  await sql.begin(async (tx) => {
    const orgs =
      await tx`SELECT organization_id FROM memberships WHERE user_id=${user}`;
    for (const row of orgs) {
      await tx`DELETE FROM audit_events WHERE organization_id=${row.organization_id}`;
      await tx`DELETE FROM memberships WHERE organization_id=${row.organization_id}`;
      await tx`DELETE FROM organizations WHERE id=${row.organization_id}`;
    }
    await tx`DELETE FROM users WHERE id=${user}`;
  });
  await sql.end();
});
test("Local unverified account creates an organization without a verification banner", async ({
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
  await page.goto("/");
  await expect(
    page
      .getByRole("button", { name: "Create organization", exact: true })
      .first(),
  ).toBeVisible();
  await expect(page.locator(".verify-banner")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Create organization", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Name", { exact: true })
    .fill("Local verification bypass");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "New workspace", exact: true }),
  ).toBeVisible();
  const [row] = await sql`SELECT verified_at FROM users WHERE id=${user}`;
  expect(row.verified_at).toBeNull();
});
