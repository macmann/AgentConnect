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
              content: copilot
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
test("Approved resolution continues the same customer journey without private staff notes", async ({
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
    .fill("INTERNAL STAFF NOTE");
  await operator
    .getByRole("button", { name: "Save internal note", exact: true })
    .click();
  await expect(operator.getByRole("log")).toContainText("INTERNAL STAFF NOTE");
  await operator
    .getByRole("button", { name: "Resolve and return to AI", exact: true })
    .click();
  const resolve = operator.getByRole("dialog");
  await resolve
    .getByLabel("Private resolution summary", { exact: true })
    .fill("PRIVATE RESOLUTION NOTE");
  await resolve
    .getByLabel("Share approved resolution facts with the AI")
    .check();
  await resolve
    .getByLabel("Issue for AI", { exact: true })
    .fill("Unauthorized transaction");
  await resolve
    .getByLabel("Approved resolution for AI", { exact: true })
    .fill("Card blocked and dispute opened.");
  await resolve
    .getByLabel("Completed actions (one per line)")
    .fill("Identity verification\nCard blocked\nDispute opened");
  await resolve
    .getByLabel("Reference IDs (one name=value per line)")
    .fill("disputeId=DSP-29219");
  await resolve
    .getByLabel("Expected next step", { exact: true })
    .fill("Wait five to seven days.");
  await resolve
    .getByLabel("Do not repeat (one action per line)")
    .fill("Identity verification");
  await operator.setViewportSize({ width: 360, height: 800 });
  expect(
    await operator.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(360);
  await operator.screenshot({
    path: "docs/support-console/resolution-mobile.png",
    fullPage: true,
  });
  await resolve
    .getByRole("button", { name: "Confirm resolution", exact: true })
    .click();
  await expect(resolve).toBeHidden();
  await expect(
    visitor.getByText(/The AI has the approved resolution/),
  ).toBeVisible({ timeout: 15000 });
  await visitor
    .getByLabel("Message", { exact: true })
    .fill("What happens next? Do not ask me to verify again.");
  await visitor
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(
    visitor.getByText(
      "Your card is blocked. Dispute DSP-29219 is open; wait five to seven days.",
      { exact: true },
    ),
  ).toBeVisible();
  const [conversation] =
    await sql`SELECT ai_resume_case_id FROM conversations WHERE deployment_id=${deployment}`;
  expect(conversation.ai_resume_case_id).toBeTruthy();
  await operator.setViewportSize({ width: 1440, height: 1000 });
  await operator.screenshot({
    path: "docs/support-console/continuation-desktop.png",
    fullPage: true,
  });
});
