import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const sql = postgres(process.env.DATABASE_URL, { max: 1 }),
  org = randomUUID(),
  workspace = randomUUID(),
  user = randomUUID(),
  builder = randomUUID(),
  session = randomUUID(),
  builderSession = randomUUID();
test.beforeAll(async () => {
  await sql`INSERT INTO organizations(id,name) VALUES (${org},'Retention browser')`;
  await sql`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Retention workspace')`;
  for (const [id, raw, name] of [
    [user, session, "Admin"],
    [builder, builderSession, "Builder"],
  ]) {
    await sql`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${id},${id + "@example.invalid"},${name},'unused',now())`;
    await sql`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(raw).digest("hex")},${id},now()+interval '1 hour')`;
  }
  await sql`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${workspace},${user},'workspace_admin'),(${randomUUID()},${org},${workspace},${builder},'builder')`;
});
test.afterAll(async () => {
  for (const table of [
    "retention_runs",
    "workspace_retention",
    "audit_events",
    "memberships",
  ])
    await sql.unsafe(`DELETE FROM ${table} WHERE workspace_id=$1`, [workspace]);
  await sql`DELETE FROM workspaces WHERE id=${workspace}`;
  await sql`DELETE FROM organizations WHERE id=${org}`;
  await sql`DELETE FROM sessions WHERE user_id IN (${user},${builder})`;
  await sql`DELETE FROM users WHERE id IN (${user},${builder})`;
  await sql.end();
});
async function open(page, raw) {
  await page.context().addCookies([
    {
      name: "session",
      value: raw,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/");
  await page.getByRole("button", { name: "Retention", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Data retention", exact: true }),
  ).toBeVisible();
}
test("administrator saves, previews, confirms and watches real worker cleanup", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await open(page, session);
  await expect(
    page.getByLabel("Enable automatic daily cleanup"),
  ).not.toBeChecked();
  await page
    .getByRole("button", { name: "Preview & cleanup", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Preview next batch" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Retention policy", exact: true })
    .click();
  await page.getByLabel("Conversations retention days").fill("30");
  await page.getByRole("button", { name: "Save retention settings" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Retention settings saved.",
  );
  await page
    .getByRole("button", { name: "Preview & cleanup", exact: true })
    .click();
  await page.getByRole("button", { name: "Preview next batch" }).click();
  await expect(
    page.getByText(
      "I understand that cleanup permanently removes eligible data.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run cleanup batch" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Retention policy", exact: true })
    .click();
  await page.getByLabel("Enable automatic daily cleanup").check();
  await page.getByRole("button", { name: "Save retention settings" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Retention settings saved.",
  );
  await page
    .getByRole("button", { name: "Preview & cleanup", exact: true })
    .click();
  await page.getByRole("button", { name: "Preview next batch" }).click();
  await page
    .getByLabel("I understand that cleanup permanently removes eligible data.")
    .check();
  await page.getByRole("button", { name: "Run cleanup batch" }).click();
  await page
    .getByRole("button", { name: "Cleanup history", exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: "completed", exact: true }),
  ).toBeVisible({ timeout: 20000 });
  const [audit] =
    await sql`SELECT count(*)::int AS count FROM audit_events WHERE workspace_id=${workspace} AND action='retention.cleanup_completed'`;
  expect(audit.count).toBe(1);
  await page.reload();
  await page.getByRole("button", { name: "Retention", exact: true }).click();
  await page
    .getByRole("button", { name: "Retention policy", exact: true })
    .click();
  await expect(page.getByLabel("Conversations retention days")).toHaveValue(
    "30",
  );
  await expect(page.getByLabel("Enable automatic daily cleanup")).toBeChecked();
  expect(errors).toEqual([]);
});
test("builder can view status but cannot change policy or run cleanup", async ({
  page,
}) => {
  await open(page, builderSession);
  await expect(page.getByLabel("Conversations retention days")).toBeDisabled();
  await expect(
    page.getByText(
      "Only workspace administrators can change settings or run cleanup.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save retention settings" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Preview next batch" }),
  ).toHaveCount(0);
});
