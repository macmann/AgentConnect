import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
// Local provider protocol fixture; temporary MODEL_PRIVATE_HOSTS=127.0.0.1:4551.
const sql = postgres(process.env.DATABASE_URL, { max: 1 }),
  org = randomUUID(),
  workspace = randomUUID();
const users = {},
  sessions = {};
let agent, deployment, caseId, customer, operatorContext, analystContext;
const provider = createServer(async (req, res) => {
  for await (const chunk of req) void chunk;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    "data: " +
      JSON.stringify({
        choices: [
          {
            delta: { content: "Support browser fixture answer" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      }) +
      "\n\ndata: [DONE]\n\n",
  );
});
test.beforeAll(async () => {
  await new Promise((r) => provider.listen(4551, "127.0.0.1", r));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Human support browser')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Support workspace')`;
    await tx`INSERT INTO support_policies(id,organization_id,workspace_id,scope,target_id,policy) VALUES (${randomUUID()},${org},${workspace},'workspace',${workspace},${tx.json({ humanEntryMode: "always_available", aiTriageEnabled: false, generateHandoffSummary: false })})`;
    for (const role of ["owner", "operator", "analyst"]) {
      users[role] = randomUUID();
      sessions[role] = randomUUID();
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${users[role]},${users[role] + "@example.invalid"},${role === "operator" ? "Taylor Specialist" : role === "analyst" ? "Case Reviewer" : "Support Admin"},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(sessions[role]).digest("hex")},${users[role]},now()+interval '1 hour')`;
      await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${role === "owner" ? null : workspace},${users[role]},${role})`;
    }
  });
});
test.afterAll(async () => {
  for (const c of [customer, operatorContext, analystContext]) await c?.close();
  provider.closeAllConnections();
  await new Promise((r) => provider.close(r));
  await sql.begin(async (tx) => {
    for (const table of [
      "handoff_events",
      "messages",
      "agent_runs",
      "conversations",
      "deployments",
      "agent_versions",
      "agents",
      "model_configurations",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    for (const user of Object.values(users))
      await tx`DELETE FROM users WHERE id=${user}`;
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
async function openSupport(page) {
  await page.goto(
    "/#view=Human+Support&organization=" + org + "&workspace=" + workspace,
  );
  await expect(
    page.getByRole("heading", { name: "Human Support", exact: true }),
  ).toBeVisible();
}
test("Support console assigns, accepts, notes privately, replies and restores customer AI chat", async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(120000);
  await staff(context, "owner");
  async function post(path, data) {
    const r = await context.request.post("http://localhost:4000" + path, {
      headers: { origin: "http://localhost:3000" },
      data,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  }
  const m = await post(`/workspaces/${workspace}/models`, {
    name: "Browser support provider",
    provider: "openai-compatible",
    modelId: "fixture",
    baseUrl: "http://127.0.0.1:4551/v1",
  });
  agent = (
    await post(`/workspaces/${workspace}/agents`, {
      name: "Support assistant",
      config: { modelId: m.id },
    })
  ).id;
  const version = await post(`/agents/${agent}/publish`, { revision: 1 });
  deployment = (
    await post(`/agents/${agent}/deployments`, {
      name: "Customer support",
      versionId: version.id,
    })
  ).id;
  customer = await browser.newContext({ baseURL: "http://localhost:3000" });
  const visitor = await customer.newPage();
  await visitor.goto("/chat/" + deployment);
  await visitor
    .getByLabel("Message", { exact: true })
    .fill("Please review my billing question");
  await visitor
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(
    visitor.getByText("Support browser fixture answer", { exact: true }),
  ).toBeVisible();
  await visitor
    .getByRole("button", { name: "Request human support", exact: true })
    .click();
  await expect(
    visitor.getByText("Waiting for an operator. You can leave a message."),
  ).toBeVisible();
  await openSupport(page);
  await page.getByRole("button", { name: "Create queue", exact: true }).click();
  const create = page.getByRole("dialog");
  await create.getByLabel("Queue name").fill("Billing");
  await create
    .getByRole("button", { name: "Create queue", exact: true })
    .click();
  await expect(create).toBeHidden();
  await page
    .getByRole("button", { name: /Open Case .* for Guest visitor/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Conversation", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("log")).toContainText(
    "Please review my billing question",
  );
  caseId = (
    await sql`SELECT id FROM support_cases WHERE workspace_id=${workspace}`
  )[0].id;
  await page.getByRole("button", { name: "Assign case", exact: true }).click();
  const assign = page.getByRole("dialog");
  await assign.getByLabel("Assign to").selectOption(users.operator);
  await assign.getByLabel("Assigned queue").selectOption({ label: "Billing" });
  await assign
    .getByRole("button", { name: "Assign case", exact: true })
    .click();
  await expect(assign).toBeHidden();
  operatorContext = await browser.newContext({
    baseURL: "http://localhost:3000",
  });
  await staff(operatorContext, "operator");
  const operator = await operatorContext.newPage();
  await openSupport(operator);
  await operator
    .getByRole("button", { name: /Open Case .* for Guest visitor/ })
    .click();
  await operator
    .getByRole("button", { name: "Accept case", exact: true })
    .click();
  await expect(
    operator.getByRole("button", { name: "Send reply", exact: true }),
  ).toBeVisible();
  await operator
    .getByRole("button", { name: "Internal note", exact: true })
    .click();
  await operator
    .getByLabel("Private note", { exact: true })
    .fill("PRIVATE: identity reviewed by staff");
  await operator
    .getByRole("button", { name: "Save internal note", exact: true })
    .click();
  await expect(operator.getByRole("log")).toContainText(
    "PRIVATE: identity reviewed by staff",
  );
  await expect(
    visitor.getByText("PRIVATE: identity reviewed by staff"),
  ).toHaveCount(0);
  await operator
    .getByRole("button", { name: "Customer reply", exact: true })
    .click();
  await operator
    .getByRole("textbox", { name: "Reply to customer", exact: true })
    .fill("I am reviewing your billing request.");
  await operator
    .getByRole("button", { name: "Send reply", exact: true })
    .click();
  await expect(
    visitor.getByText("I am reviewing your billing request.", { exact: false }),
  ).toBeVisible({ timeout: 15000 });
  await visitor
    .getByLabel("Message to support")
    .fill("Thank you for reviewing");
  await visitor
    .getByRole("button", { name: "Send to support", exact: true })
    .click();
  await expect(operator.getByRole("log")).toContainText(
    "Thank you for reviewing",
    { timeout: 15000 },
  );
  await expect(operator).toHaveURL(new RegExp(caseId));
  await operator.reload();
  await expect(operator.getByRole("log")).toContainText(
    "PRIVATE: identity reviewed by staff",
  );
  analystContext = await browser.newContext({
    baseURL: "http://localhost:3000",
  });
  await staff(analystContext, "analyst");
  const analyst = await analystContext.newPage();
  await openSupport(analyst);
  await analyst
    .getByRole("button", { name: /Open Case .* for Guest visitor/ })
    .click();
  await expect(analyst.getByRole("log")).toContainText(
    "PRIVATE: identity reviewed by staff",
  );
  await expect(
    analyst.getByRole("button", { name: "Send reply", exact: true }),
  ).toHaveCount(0);
  await expect(
    analyst.getByRole("button", {
      name: "Resolve and return to AI",
      exact: true,
    }),
  ).toHaveCount(0);
  await operator
    .getByRole("button", { name: "Resolve and return to AI", exact: true })
    .click();
  const resolve = operator.getByRole("dialog");
  await resolve
    .getByLabel("Private resolution summary")
    .fill("PRIVATE: billing request reviewed successfully");
  await resolve
    .getByLabel("Final reply to customer (optional)")
    .fill("Your billing request has been reviewed.");
  await resolve
    .getByRole("button", { name: "Confirm resolution", exact: true })
    .click();
  await expect(resolve).toBeHidden();
  await expect(
    visitor.getByText(
      "Support resolved this request. You can chat with the agent again.",
    ),
  ).toBeVisible({ timeout: 15000 });
  await expect(visitor.getByText("PRIVATE:", { exact: false })).toHaveCount(0);
  await expect(
    visitor.getByText("Your billing request has been reviewed.", {
      exact: false,
    }),
  ).toBeVisible();
  await visitor
    .getByLabel("Message", { exact: true })
    .fill("Can I continue chatting?");
  await visitor
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(
    visitor.getByText("Support browser fixture answer", { exact: true }),
  ).toHaveCount(2);
  await page.getByLabel("Cases", { exact: true }).selectOption("all");
  await page
    .getByLabel("Queue", { exact: true })
    .selectOption({ label: "Billing" });
  await page.getByLabel("Status", { exact: true }).selectOption("resolved");
  await expect(
    page.getByRole("button", { name: /Open Case .* for Guest visitor/ }),
  ).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  await page
    .getByRole("button", { name: /Open Case .* for Guest visitor/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Conversation", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.scrollTo(0, 0);
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({
    path: "docs/support-console/mobile.png",
    fullPage: false,
  });
  await page
    .getByRole("button", { name: "Back to inbox", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Open Case .* for Guest visitor/ }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", { name: /Open Case .* for Guest visitor/ })
    .click();
  await visitor
    .getByRole("button", { name: "Request human support", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Reset filters", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Open Case .* for Guest visitor/ }),
  ).toBeVisible({ timeout: 15000 });
  await page
    .getByRole("button", { name: /Open Case .* for Guest visitor/ })
    .click();
  await page.getByRole("button", { name: "Claim case", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Send reply", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.scrollTo(0, 0);
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({
    path: "docs/support-console/desktop.png",
    fullPage: false,
  });
  await page.bringToFront();
  await page
    .getByRole("textbox", { name: "Reply to customer", exact: true })
    .fill("Unsaved support draft");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("button", { name: "Back to inbox", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Reply to customer", exact: true }),
  ).toHaveValue("Unsaved support draft");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Back to inbox", exact: true })
    .click();
});
test("Inbox shows an accessible empty state and retries a failed case request", async ({
  page,
  context,
}) => {
  await staff(context, "owner");
  await openSupport(page);
  await page.getByLabel("Cases", { exact: true }).selectOption("mine");
  await page
    .getByRole("textbox", { name: "Search cases" })
    .fill("not-a-real-support-case");
  await page.getByRole("button", { name: "Search cases", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No matching cases" }),
  ).toBeVisible();
  await page.route("**/support/cases?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Support fixture outage" }),
    }),
  );
  await page.getByRole("button", { name: "Refresh support inbox" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Support fixture outage" }),
  ).toBeVisible();
  await page.unroute("**/support/cases?*");
  await page.getByRole("button", { name: "Retry cases", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No matching cases" }),
  ).toBeVisible();
});
