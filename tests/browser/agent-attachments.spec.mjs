import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production mode");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const org = randomUUID(),
  workspace = randomUUID(),
  user = randomUUID(),
  session = randomUUID();
test.beforeAll(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${user},${user + "@example.com"},'Attachment tester','unused',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(session).digest("hex")},${user},now()+interval '1 hour')`;
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Attachment UI')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Attachment workspace')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${user},'owner')`;
    await tx`INSERT INTO model_configurations(id,organization_id,workspace_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES (${randomUUID()},${org},${workspace},'UI fixture','openai-compatible','fixture','https://api.openai.com/v1',4096,1024,'{"streaming":true,"temperature":true,"topP":true}')`;
  });
});
test.afterAll(async () => {
  await sql.begin(async (tx) => {
    for (const table of ["model_configurations", "memberships", "workspaces"])
      await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    await tx`DELETE FROM users WHERE id=${user}`;
  });
  await sql.end();
});
async function editor(page, context) {
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
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await page.getByRole("button", { name: /Manual setup/ }).click();
}
test("empty attachment actions navigate within the workspace and protect unsaved changes", async ({
  page,
  context,
}) => {
  page.setDefaultTimeout(15000);
  await editor(page, context);
  await configure(page, "Knowledge");
  await expect(
    page.getByText("No knowledge bases in this workspace"),
  ).toBeVisible();
  await configure(page, "Tools");
  await expect(
    page.getByText("No enabled tools in this workspace"),
  ).toBeVisible();
  await configure(page, "Knowledge");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("button", { name: "Create knowledge base", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Attached knowledge" }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Create knowledge base", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your knowledge starts here" }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Current workspace", exact: true }),
  ).toHaveValue(workspace);
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await page.getByRole("button", { name: /Manual setup/ }).click();
  await configure(page, "Tools");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Register or enable tools", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Tools & MCP" }),
  ).toBeVisible();
});
test("attachment sections select items, show disabled tools, and distinguish load failures", async ({
  page,
  context,
}) => {
  await page.route(`**/workspaces/${workspace}/tools`, (route) =>
    route.fulfill({
      json: [
        {
          id: randomUUID(),
          name: "Approved search",
          enabled: true,
          public_access: false,
        },
        {
          id: randomUUID(),
          name: "Disabled search",
          enabled: false,
          public_access: false,
        },
      ],
    }),
  );
  await page.route(`**/workspaces/${workspace}/knowledge-bases`, (route) =>
    route.fulfill({
      json: [
        { id: randomUUID(), name: "Support handbook", public_access: true },
      ],
    }),
  );
  page.setDefaultTimeout(15000);
  await editor(page, context);
  await configure(page, "Tools");
  await page.getByRole("checkbox", { name: /Approved search/ }).check();
  await expect(
    page.getByRole("checkbox", { name: /Disabled search/ }),
  ).toBeDisabled();
  await expect(
    page
      .getByRole("region", { name: "Attached tools" })
      .getByText(/1 selected/),
  ).toBeVisible();
  await configure(page, "Knowledge");
  await page.getByRole("checkbox", { name: /Support handbook/ }).check();
  await expect(
    page
      .getByRole("region", { name: "Attached knowledge" })
      .getByText(/1 selected/),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("region", { name: "Attached knowledge" })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("checkbox", { name: /Support handbook/ }),
  ).toBeChecked();
  await page.unroute(`**/workspaces/${workspace}/knowledge-bases`);
  await page.route(`**/workspaces/${workspace}/knowledge-bases`, (route) =>
    route.fulfill({ status: 403, json: { error: "Access denied" } }),
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await page.getByRole("button", { name: /Manual setup/ }).click();
  await configure(page, "Knowledge");
  await expect(page.getByText("Could not load knowledge bases.")).toBeVisible({
    timeout: 15000,
  });
  await expect(
    page.getByText("No knowledge bases in this workspace"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Try again", exact: true }),
  ).toBeVisible();
});

async function configure(page, section) {
  await page
    .getByRole("navigation", { name: "Configure sections" })
    .getByRole("button", { name: section, exact: true })
    .click();
}
