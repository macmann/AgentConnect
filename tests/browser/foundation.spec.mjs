import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Browser tests refuse production mode");
const email = `browser-${randomUUID()}@example.com`;
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
async function mailLink(request, recipient, subject) {
  let link;
  await expect
    .poll(
      async () => {
        const inbox = await (
          await request.get("http://localhost:8025/api/v1/messages")
        ).json();
        const item = inbox.messages?.find(
          (m) =>
            m.Subject === subject && m.To?.some((t) => t.Address === recipient),
        );
        if (!item) return false;
        const message = await (
          await request.get(`http://localhost:8025/api/v1/message/${item.ID}`)
        ).json();
        link = message.Text?.match(/http:\/\/localhost:3000\/[?#][^\s]+/)?.[0];
        return !!link;
      },
      { timeout: 20000 },
    )
    .toBe(true);
  return link;
}
test.afterAll(async () => {
  await sql.begin(async (tx) => {
    const [u] = await tx`SELECT id FROM users WHERE email=${email}`;
    if (!u) return;
    const memberships =
      await tx`SELECT organization_id FROM memberships WHERE user_id=${u.id} AND role='owner'`;
    for (const m of memberships) {
      const org = m.organization_id;
      await tx`DELETE FROM audit_events WHERE organization_id=${org}`;
      await tx`DELETE FROM secrets WHERE organization_id=${org}`;
      await tx`DELETE FROM invitations WHERE organization_id=${org}`;
      await tx`DELETE FROM memberships WHERE organization_id=${org}`;
      await tx`DELETE FROM workspaces WHERE organization_id=${org}`;
      await tx`DELETE FROM organizations WHERE id=${org}`;
    }
    await tx`DELETE FROM audit_events WHERE actor_id=${u.id}`;
    await tx`DELETE FROM mail_outbox WHERE recipient=${email} OR recipient=${"invited-" + email}`;
    await tx`DELETE FROM users WHERE id=${u.id}`;
  });
  await sql.end();
});
test("registration, SMTP verification, workspace management, secrets and audit work in browser", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Create your account" }),
  ).toBeVisible();
  await page.getByLabel("Your name").fill("Foundation Builder");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel(/^Password/).fill("Browser-test-password-123");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Good to see you, Foundation." }),
  ).toBeVisible();
  const verify = await mailLink(request, email, "Verify your email");
  await page.goto(verify);
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText("Action completed")).toBeVisible();
  await page
    .getByRole("button", { name: "Create organization", exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Browser organization");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Organization created")).toBeVisible();
  await page
    .getByRole("button", { name: "New workspace", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Customer experience");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Workspace created")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Customer experience", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Members", exact: true }).click();
  await page
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Email", { exact: true })
    .fill("invited-" + email);
  await page
    .getByRole("dialog")
    .getByLabel("Workspace role")
    .selectOption("viewer");
  await page
    .getByRole("button", { name: "Send invitation", exact: true })
    .click();
  await expect(
    page.getByText("Invitation queued for email delivery"),
  ).toBeVisible();
  await mailLink(request, "invited-" + email, "Workspace invitation");
  await page.getByRole("button", { name: "Secrets", exact: true }).click();
  await page.getByRole("button", { name: "Add secret", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Secret name")
    .fill("BROWSER_TEST_KEY");
  await page
    .getByRole("dialog")
    .getByLabel("Value", { exact: true })
    .fill("test-secret-value");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "BROWSER_TEST_KEY" }),
  ).toBeVisible();
  await expect(page.getByText("test-secret-value")).toHaveCount(0);
  await page.getByRole("button", { name: "Audit log", exact: true }).click();
  await expect(page.getByRole("cell", { name: "secret.saved" })).toBeVisible();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.screenshot({
    path: "test-results/workspace-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Good to see you, Foundation." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/workspace-mobile.png",
    fullPage: true,
  });
});
