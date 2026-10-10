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
let agent,
  deployment,
  customer,
  operatorContext,
  analystContext,
  failCopilot = false;
const provider = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (raw.includes("<approved_support_context>")) {
    expect(raw).toContain("DSP-29219");
    expect(raw).toContain("Identity verification");
    expect(raw).not.toContain("INTERNAL STAFF NOTE");
    expect(raw).not.toContain("PRIVATE RESOLUTION NOTE");
  }
  const triage = JSON.parse(raw).messages.some(
    (m) =>
      m.role === "system" &&
      m.content.includes("private human-support handoff brief"),
  );
  const decision = JSON.parse(raw).messages.some(
    (m) => m.role === "system" && m.content.includes("request_human_handoff"),
  );
  const copilot = JSON.parse(raw).messages.some(
    (m) =>
      m.role === "system" &&
      m.content.includes("PRIVATE support operator copilot"),
  );
  if (copilot) {
    expect(raw).not.toContain("PRIVATE: copilot note");
    if (failCopilot) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Fixture outage" } }));
      return;
    }
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    "data: " +
      JSON.stringify({
        choices: [
          {
            delta: {
              content: triage
                ? JSON.stringify({
                    intent: "billing",
                    category: "accounts",
                    priority: "normal",
                    language: "en",
                    requiredSkills: [],
                    preferredSkills: [],
                    sentiment: "neutral",
                    complexity: "medium",
                    summary:
                      "Customer needs a specialist to review an unauthorized transaction.",
                    reason: "Repeated explicit requests.",
                    customerContext: [],
                    actionsAttempted: ["AI asked about the transaction."],
                    suggestedNextAction:
                      "Review the transaction with the customer.",
                  })
                : decision
                  ? JSON.stringify({
                      requestHandoff: false,
                      intent: "general",
                      sentiment: "neutral",
                      reason: "",
                    })
                  : copilot
                    ? JSON.stringify({
                        reply: "Please send your order number.",
                        summary: "Customer has a billing question.",
                        sentiment: "unknown",
                        nextAction: "request_information",
                        rationale: "An order number will help.",
                        toolRecommendations: [],
                      })
                    : raw.includes("<approved_support_context>")
                      ? "Your card is blocked. Dispute DSP-29219 is open; wait five to seven days."
                      : "Support browser fixture answer",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      }) +
      "\n\ndata: [DONE]\n\n",
  );
});
test.beforeAll(async () => {
  const budget = await fetch("http://localhost:4000/auth/me");
  if (Number(budget.headers.get("x-ratelimit-remaining") ?? 300) < 200) {
    await new Promise((r) =>
      setTimeout(
        r,
        Math.min(
          59000,
          Number(
            budget.headers.get("retry-after") ??
              budget.headers.get("x-ratelimit-reset") ??
              60,
          ) * 1000,
        ),
      ),
    );
  }
  await new Promise((r) => provider.listen(4551, "127.0.0.1", r));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Human support browser')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Support workspace')`;
    await tx`INSERT INTO support_policies(id,organization_id,workspace_id,scope,target_id,policy) VALUES (${randomUUID()},${org},${workspace},'workspace',${workspace},${tx.json({ humanEntryMode: "policy_controlled", explicitRequestThreshold: 2, aiTriageEnabled: true, generateHandoffSummary: true })})`;
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
test("Complete support lifecycle includes automatic assignment, reviewed assistance, transfer, SLA alerts and AI continuation", async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  await staff(context, "owner");
  async function send(method, path, data, ctx = context) {
    const r = await ctx.request[method]("http://localhost:4000" + path, {
      headers: { origin: "http://localhost:3000" },
      data,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  }
  const base = `/workspaces/${workspace}/support`;
  const model = await send("post", `/workspaces/${workspace}/models`, {
    name: "Full support fixture",
    provider: "openai-compatible",
    modelId: "fixture",
    baseUrl: "http://127.0.0.1:4551/v1",
  });
  const a = await send("post", `/workspaces/${workspace}/agents`, {
    name: "Support assistant",
    config: { modelId: model.id },
  });
  agent = a.id;
  const v = await send("post", `/agents/${agent}/publish`, {
    revision: a.revision,
  });
  deployment = (
    await send("post", `/agents/${agent}/deployments`, {
      name: "Full journey",
      versionId: v.id,
    })
  ).id;
  const q = await send("post", base + "/queues", {
    name: "Billing",
    isDefault: true,
    routingStrategy: "least_loaded",
    assignmentMode: "automatic",
  });
  const review = await send("post", base + "/queues", { name: "Review" });
  await send("put", base + "/operators/" + users.operator + "/profile", {
    capacityLimit: 2,
    languages: ["en"],
  });
  await send("put", base + "/queues/" + q.id + "/members", {
    members: [{ userId: users.operator }],
  });
  await openSupport(page);
  await page
    .getByRole("button", { name: "Operators & routing", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Configure queue Billing", exact: true })
    .click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Assignment target (seconds)", { exact: true })
    .fill("3600");
  await dialog
    .getByLabel("First response target (seconds)", { exact: true })
    .fill("3600");
  await dialog
    .getByLabel("Resolution target (seconds)", { exact: true })
    .fill("3600");
  await dialog
    .getByLabel("Acceptance timeout (seconds)", { exact: true })
    .fill("120");
  await dialog
    .getByRole("button", { name: "Save queue routing", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await send("put", base + "/policy", {
    humanEntryMode: "policy_controlled",
    explicitRequestThreshold: 2,
    defaultQueueId: q.id,
    aiTriageEnabled: true,
    generateHandoffSummary: true,
  });
  operatorContext = await browser.newContext({
    baseURL: "http://localhost:3000",
  });
  await staff(operatorContext, "operator");
  const operator = await operatorContext.newPage();
  operator.setDefaultTimeout(15000);
  await openSupport(operator);
  await operator
    .getByLabel("My presence", { exact: true })
    .selectOption("available");
  customer = await browser.newContext({ baseURL: "http://localhost:3000" });
  const visitor = await customer.newPage();
  await visitor.goto("/chat/" + deployment);
  async function chat(text) {
    await visitor.getByLabel("Message", { exact: true }).fill(text);
    await visitor
      .getByRole("button", { name: "Send message", exact: true })
      .click();
  }
  await chat("An unauthorized transaction appeared.");
  await expect(
    visitor.getByText("Support browser fixture answer", { exact: true }),
  ).toBeVisible();
  await expect(
    visitor.getByRole("button", { name: "Request human support", exact: true }),
  ).toHaveCount(0);
  await chat("I want a human");
  await expect(
    visitor.getByText("Support browser fixture answer", { exact: true }).last(),
  ).toBeVisible();
  await expect(
    visitor.getByRole("button", { name: "Connect me", exact: true }),
  ).toHaveCount(0);
  await chat("I need a human");
  await expect(
    visitor.getByRole("button", { name: "Connect me", exact: true }),
  ).toBeVisible();
  await visitor
    .getByRole("button", { name: "Connect me", exact: true })
    .click();
  await expect
    .poll(
      async () => {
        const [s] =
          await sql`SELECT status FROM support_cases WHERE workspace_id=${workspace}`;
        return s?.status;
      },
      { timeout: 20000 },
    )
    .toBe("assigned");
  const [s] =
    await sql`SELECT * FROM support_cases WHERE workspace_id=${workspace}`;
  await operator
    .getByRole("button", { name: /Open Case .* for Guest visitor/ })
    .click();
  await operator
    .getByRole("button", { name: "Accept case", exact: true })
    .click();
  await expect(
    operator.getByText(
      "Customer needs a specialist to review an unauthorized transaction.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    visitor.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  const copilot = operator.getByRole("region", {
    name: "Private operator copilot",
  });
  await copilot
    .getByRole("button", { name: "Suggest reply", exact: true })
    .click();
  await expect(
    copilot.getByText("Please send your order number.", { exact: true }),
  ).toBeVisible();
  await expect(
    visitor.getByText("Please send your order number.", { exact: true }),
  ).toHaveCount(0);
  await operator
    .getByLabel("Reply to customer", { exact: true })
    .fill(
      "Your identity is checked. The card is blocked and dispute DSP-29219 is open.",
    );
  await operator
    .getByRole("button", { name: "Send reply", exact: true })
    .click();
  await expect(visitor.getByText(/Your identity is checked/)).toBeVisible();
  await operator
    .getByRole("button", { name: "Internal note", exact: true })
    .click();
  await operator
    .getByLabel("Private note", { exact: true })
    .fill("INTERNAL STAFF NOTE");
  await operator
    .getByRole("button", { name: "Save internal note", exact: true })
    .click();
  await operator
    .getByRole("button", { name: "Transfer case", exact: true })
    .click();
  dialog = operator.getByRole("dialog");
  await dialog
    .getByLabel("Transfer queue", { exact: true })
    .selectOption(review.id);
  await dialog
    .getByLabel("Transfer operator", { exact: true })
    .selectOption(users.operator);
  await dialog
    .getByLabel("Reason for change", { exact: true })
    .fill("Second review before closure");
  await operator.setViewportSize({ width: 360, height: 800 });
  expect(
    await operator.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(360);
  await operator.screenshot({
    path: "docs/support-console/operations-mobile.png",
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Confirm transfer", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await operator.setViewportSize({ width: 1440, height: 1000 });
  await operator
    .getByRole("button", { name: "Accept case", exact: true })
    .click();
  await sql`UPDATE support_cases SET requested_at=clock_timestamp()-interval '3060 seconds',operations_next_attempt_at=clock_timestamp() WHERE id=${s.id}`;
  await expect
    .poll(
      async () => {
        const [current] =
          await sql`SELECT sla_state FROM support_cases WHERE id=${s.id}`;
        return current?.sla_state;
      },
      { timeout: 15000 },
    )
    .toBe("warning");
  await page.getByRole("button", { name: "Supervision", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Supervisor overview", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".support-count")
      .filter({ hasText: "Warning" })
      .getByText("1", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/support-console/supervision-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
  await expect(
    page.getByText("Sla Warning", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Inbox", exact: true }).click();
  await page
    .getByRole("button", { name: /Open Case .* for Guest visitor/ })
    .click();
  await page
    .getByRole("button", { name: "Change priority", exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Case priority", { exact: true })
    .selectOption("urgent");
  await dialog
    .getByLabel("Reason for change", { exact: true })
    .fill("Confirmed urgent review");
  await dialog
    .getByRole("button", { name: "Save priority", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await operator
    .getByRole("button", { name: "Resolve and return to AI", exact: true })
    .click();
  dialog = operator.getByRole("dialog");
  await dialog
    .getByLabel("Private resolution summary", { exact: true })
    .fill("PRIVATE RESOLUTION NOTE");
  await dialog
    .getByLabel("Share approved resolution facts with the AI")
    .check();
  await dialog
    .getByLabel("Issue for AI", { exact: true })
    .fill("Unauthorized transaction");
  await dialog
    .getByLabel("Approved resolution for AI", { exact: true })
    .fill("Card blocked and dispute opened.");
  await dialog
    .getByLabel("Completed actions (one per line)")
    .fill("Identity verification\nCard blocked\nDispute opened");
  await dialog
    .getByLabel("Reference IDs (one name=value per line)")
    .fill("disputeId=DSP-29219");
  await dialog
    .getByLabel("Expected next step", { exact: true })
    .fill("Wait five to seven days.");
  await dialog
    .getByLabel("Do not repeat (one action per line)")
    .fill("Identity verification");
  await dialog
    .getByRole("button", { name: "Confirm resolution", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(
    visitor.getByText(/The AI has the approved resolution/),
  ).toBeVisible();
  await chat("What happens next?");
  await expect(
    visitor.getByText(
      "Your card is blocked. Dispute DSP-29219 is open; wait five to seven days.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Analytics", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Support analytics", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".support-count")
      .filter({ hasText: "Cases resolved" })
      .getByText("1", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".support-count")
      .filter({ hasText: "AI returns" })
      .getByText("1", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/support-console/analytics-desktop.png",
    fullPage: true,
  });
  analystContext = await browser.newContext({
    baseURL: "http://localhost:3000",
  });
  await staff(analystContext, "analyst");
  const analyst = await analystContext.newPage();
  await openSupport(analyst);
  await expect(
    analyst.getByRole("button", { name: "Supervision", exact: true }),
  ).toHaveCount(0);
  await analyst.getByRole("button", { name: "Analytics", exact: true }).click();
  await expect(
    analyst.getByRole("heading", { name: "Support analytics", exact: true }),
  ).toBeVisible();
  const [final] =
    await sql`SELECT c.conversation_mode,s.status,s.transfer_count FROM conversations c JOIN support_cases s ON s.conversation_id=c.id WHERE s.id=${s.id}`;
  expect(final.conversation_mode).toBe("ai");
  expect(final.status).toBe("resolved");
  expect(final.transfer_count).toBe(1);
});
