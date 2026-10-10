import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const sql = postgres(process.env.DATABASE_URL, { max: 1 }),
  org = randomUUID(),
  workspace = randomUUID(),
  agent = randomUUID(),
  users = {},
  sessions = {};
let specialistContext, analystContext;
test.beforeAll(async () => {
  // Shared localhost IP uses the real API policy; pace this multi-session flow.
  const health = await fetch("http://localhost:4000/auth/me", {
    signal: AbortSignal.timeout(5000),
  });
  if (
    health.status === 429 ||
    Number(health.headers.get("x-ratelimit-remaining") ?? 300) < 200
  ) {
    const reset = Number(
      health.headers.get("retry-after") ??
        health.headers.get("x-ratelimit-reset") ??
        1,
    );
    console.log(
      "Pacing support routing browser scenario for the API rate-limit window",
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(59000, Math.max(1000, reset * 1000 + 500))),
    );
  }

  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Routing browser fixture')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Routing workspace')`;
    for (const role of ["owner", "operator", "analyst"]) {
      users[role] = randomUUID();
      sessions[role] = randomUUID();
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${users[role]},${users[role] + "@example.invalid"},${role === "owner" ? "Routing Admin" : role === "operator" ? "Thiri Specialist" : "Case Reviewer"},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(sessions[role]).digest("hex")},${users[role]},now()+interval '1 hour')`;
      await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${role === "owner" ? null : workspace},${users[role]},${role})`;
    }
    await tx`INSERT INTO agents(id,organization_id,workspace_id,name,description,public_description,draft_config,created_by) VALUES (${agent},${org},${workspace},'Routing assistant','','','{}',${users.owner})`;
  });
});
test.afterAll(async () => {
  await specialistContext?.close();
  await analystContext?.close();
  await sql.begin(async (tx) => {
    for (const t of [
      "handoff_events",
      "conversations",
      "agents",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(t)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    for (const u of Object.values(users))
      await tx`DELETE FROM users WHERE id=${u}`;
  });
  await sql.end();
});
async function staff(context, role) {
  await context.addCookies([
    {
      name: "session",
      value: sessions[role],
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}
async function open(page) {
  await page.goto(
    "/#view=Human+Support&organization=" + org + "&workspace=" + workspace,
  );
  await expect(
    page.getByRole("heading", { name: "Human Support", exact: true }),
  ).toBeVisible();
}
test("Configure a skilled operator and default automatic queue, reserve capacity, accept and resolve", async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(120000);
  await staff(context, "owner");
  await open(page);
  await page.getByRole("button", { name: "Create queue", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "Queue name" })
    .fill("Myanmar Billing");
  await dialog
    .getByRole("button", { name: "Create queue", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await page
    .getByRole("button", { name: "Operators & routing", exact: true })
    .click();
  await page.getByRole("button", { name: "Create skill", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Skill name" }).fill("Billing");
  await dialog
    .getByRole("textbox", { name: "Skill description" })
    .fill("Billing review and refunds");
  await dialog.getByRole("button", { name: "Save skill", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page
    .getByRole("button", { name: "Add operator profile", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("combobox", { name: "Workspace member" })
    .selectOption(users.operator);
  await dialog.getByRole("spinbutton", { name: "Capacity limit" }).fill("1");
  await dialog.getByRole("textbox", { name: "Language codes" }).fill("my, en");
  await dialog.getByRole("textbox", { name: "Timezone" }).fill("Asia/Rangoon");
  await dialog
    .getByRole("combobox", { name: "Proficiency Billing" })
    .selectOption("5");
  await dialog.getByRole("button", { name: "Save operator profile" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Thiri Specialist" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Configure queue Myanmar Billing" })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByRole("combobox", { name: "Routing strategy" })
    .selectOption("hybrid");
  await dialog
    .getByRole("combobox", { name: "Assignment mode" })
    .selectOption("automatic");
  await dialog.getByRole("textbox", { name: "Required language" }).fill("my");
  await dialog
    .getByRole("checkbox", { name: "Default queue for new support requests" })
    .check();
  await dialog
    .getByRole("checkbox", {
      name: "Queue member Thiri Specialist",
      exact: true,
    })
    .check();
  await dialog
    .getByRole("combobox", { name: "Queue skill Billing" })
    .selectOption("required");
  await dialog
    .getByRole("spinbutton", { name: "Capacity scoring weight" })
    .fill("50");
  await dialog.getByRole("button", { name: "Save queue routing" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText("Hybrid · Automatic", { exact: true }),
  ).toBeVisible();
  specialistContext = await browser.newContext({
    baseURL: "http://localhost:3000",
  });
  await staff(specialistContext, "operator");
  const operator = await specialistContext.newPage();
  await open(operator);
  await operator
    .getByRole("combobox", { name: "My presence" })
    .selectOption("available");
  async function requestCase() {
    const c = randomUUID();
    await sql`INSERT INTO conversations(id,organization_id,workspace_id,agent_id,user_id,config_snapshot,model_snapshot) VALUES (${c},${org},${workspace},${agent},${users.owner},'{}','{}')`;
    const r = await context.request.post(
      `http://localhost:4000/workspaces/${workspace}/support/cases`,
      {
        headers: { origin: "http://localhost:3000" },
        data: { conversationId: c, reasonText: "Myanmar billing question" },
      },
    );
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  }
  const one = await requestCase(),
    two = await requestCase();
  await expect
    .poll(
      async () => {
        const rows =
          await sql`SELECT status FROM support_cases WHERE workspace_id=${workspace} ORDER BY id`;
        return rows.map((r) => r.status).sort();
      },
      { timeout: 20000 },
    )
    .toEqual(["assigned", "queued"]);
  const [assigned] =
    await sql`SELECT id FROM support_cases WHERE workspace_id=${workspace} AND status='assigned'`;
  const other = assigned.id === one.id ? two : one;
  await operator
    .getByRole("combobox", { name: "Cases", exact: true })
    .selectOption("mine");
  await expect(
    operator.getByRole("button", { name: /Open Case .* for Routing Admin/ }),
  ).toBeVisible({ timeout: 15000 });
  await operator
    .getByRole("button", { name: /Open Case .* for Routing Admin/ })
    .click();
  await operator
    .getByRole("button", { name: "Accept case", exact: true })
    .click();
  await expect(
    operator.getByRole("button", { name: "Send reply", exact: true }),
  ).toBeVisible();
  await expect(
    operator.getByText("Hybrid assignment · Score", { exact: false }),
  ).toBeVisible();
  const rejected = await specialistContext.request.post(
    `http://localhost:4000/workspaces/${workspace}/support/cases/${other.id}/claim`,
    { headers: { origin: "http://localhost:3000" }, data: {} },
  );
  expect(rejected.status()).toBe(409);
  await operator
    .getByRole("button", { name: "Resolve and return to AI" })
    .click();
  dialog = operator.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "Private resolution summary" })
    .fill("Billing review finished");
  await dialog
    .getByRole("button", { name: "Confirm resolution", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(
      async () => {
        const [row] =
          await sql`SELECT status FROM support_cases WHERE id=${other.id}`;
        return row.status;
      },
      { timeout: 20000 },
    )
    .toBe("assigned");
  analystContext = await browser.newContext({
    baseURL: "http://localhost:3000",
  });
  await staff(analystContext, "analyst");
  const analyst = await analystContext.newPage();
  await open(analyst);
  await analyst.getByRole("button", { name: "Operators & routing" }).click();
  await expect(
    analyst.getByRole("heading", { name: "Thiri Specialist" }),
  ).toBeVisible();
  await expect(
    analyst.getByRole("button", { name: "Add operator profile" }),
  ).toHaveCount(0);
  await expect(
    analyst.getByRole("combobox", { name: "My presence" }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      "The API returned an unexpected response. Please try again.",
      { exact: true },
    ),
  ).toHaveCount(0);
  await page.bringToFront();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Human Support", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page
    .getByRole("button", { name: "Operators & routing", exact: true })
    .click();
  await expect(
    page.getByText("1 / 1 reserved · 0 free", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page.bringToFront();
  await page.setViewportSize({ width: 360, height: 800 });
  await page
    .getByRole("button", { name: "Edit operator Thiri Specialist" })
    .click();
  dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("textbox", { name: "Language codes" }),
  ).toHaveValue("my, en");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: "docs/support-console/routing-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "docs/support-console/routing-desktop.png" });
});
