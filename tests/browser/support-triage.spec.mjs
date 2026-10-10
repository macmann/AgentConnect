import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const sql = postgres(process.env.DATABASE_URL, { max: 1 }),
  org = randomUUID(),
  workspace = randomUUID(),
  users = {},
  sessions = {};
let customer,
  analystContext,
  agent,
  deployment,
  caseId,
  triageCalls = 0,
  triageFailure = false;
const result = {
  intent: "billing",
  category: "accounts",
  priority: "high",
  language: "en",
  requiredSkills: [],
  preferredSkills: [],
  sentiment: "neutral",
  complexity: "medium",
  summary: "Customer requested a specialist after two attempts.",
  reason: "Repeated explicit requests.",
  customerContext: [],
  actionsAttempted: ["The assistant offered to help with the account."],
  suggestedNextAction: "Review the account issue with the customer.",
};
const provider = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const triage = body.messages?.some(
    (m) =>
      m.role === "system" &&
      m.content.includes("private human-support handoff brief"),
  );
  if (triage) {
    triageCalls++;
    expect(raw).not.toContain("PRIVATE OPERATOR NOTE");
    if (triageFailure) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "invalid_api_key" } }));
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
                ? JSON.stringify(result)
                : "I can help with account issues. What are you trying to do?",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }) +
      "\n\ndata: [DONE]\n\n",
  );
});
test.beforeAll(async () => {
  const budget = await fetch("http://localhost:4000/auth/me");
  if (Number(budget.headers.get("x-ratelimit-remaining") ?? 300) < 200) {
    const reset = Number(budget.headers.get("x-ratelimit-reset") ?? 1);
    console.log(
      "Pacing handoff policy browser scenario for the API rate-limit window",
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(59000, Math.max(1000, reset * 1000 + 500))),
    );
  }
  await new Promise((r) => provider.listen(4551, "127.0.0.1", r));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Handoff policy browser')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Support policy workspace')`;
    for (const role of ["owner", "analyst"]) {
      users[role] = randomUUID();
      sessions[role] = randomUUID();
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${users[role]},${users[role] + "@example.invalid"},${role === "owner" ? "Support Admin" : "Policy Reviewer"},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(sessions[role]).digest("hex")},${users[role]},now()+interval '1 hour')`;
      await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${role === "owner" ? null : workspace},${users[role]},${role})`;
    }
  });
});
test.afterAll(async () => {
  await customer?.close();
  await analystContext?.close();
  provider.closeAllConnections();
  await new Promise((r) => provider.close(r));
  await sql.begin(async (tx) => {
    for (const t of [
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
      await tx`DELETE FROM ${tx(t)} WHERE organization_id=${org}`;
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
async function openSupport(page, id = "") {
  await page.goto(
    "/#view=Human+Support&organization=" +
      org +
      "&workspace=" +
      workspace +
      (id ? "&supportCase=" + id : ""),
  );
  await expect(
    page.getByRole("heading", { name: "Human Support", exact: true }),
  ).toBeVisible();
}
test("Policy-controlled customer offers produce private AI briefs, scoped overrides and responsive read-only settings", async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(10000);
  await staff(context, "owner");
  async function send(method, path, data) {
    const r = await context.request[method]("http://localhost:4000" + path, {
      headers: { origin: "http://localhost:3000" },
      data,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  }
  const m = await send("post", `/workspaces/${workspace}/models`, {
    name: "Handoff browser provider",
    provider: "openai-compatible",
    modelId: "fixture",
    baseUrl: "http://127.0.0.1:4551/v1",
  });
  const a = await send("post", `/workspaces/${workspace}/agents`, {
    name: "Account assistant",
    config: { modelId: m.id },
  });
  agent = a.id;
  const v = await send("post", `/agents/${agent}/publish`, {
    revision: a.revision,
  });
  const d = await send("post", `/agents/${agent}/deployments`, {
    name: "Customer help",
    versionId: v.id,
  });
  deployment = d.id;
  const q = await send("post", `/workspaces/${workspace}/support/queues`, {
    name: "Account support",
    isDefault: true,
  });
  await openSupport(page);
  await page
    .getByRole("button", { name: "Handoff policy", exact: true })
    .click();
  await expect(page.getByLabel("Human access", { exact: true })).toHaveValue(
    "policy_controlled",
  );
  await expect(page.getByLabel("Explicit requests before offer")).toHaveValue(
    "2",
  );
  await page.getByLabel("Default queue", { exact: true }).selectOption(q.id);
  await page.getByRole("button", { name: "Save policy", exact: true }).click();
  await expect(
    page.getByText("Handoff policy saved.", { exact: false }),
  ).toBeVisible();
  // Unsaved fields survive refocus/refetch, and navigating away asks before discarding.
  await page.getByLabel("Explicit requests before offer").fill("3");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("button", { name: "Operators & routing", exact: true })
    .click();
  await expect(page.getByLabel("Explicit requests before offer")).toHaveValue(
    "3",
  );
  await page.getByLabel("Explicit requests before offer").fill("2");
  await page.getByRole("button", { name: "Save policy", exact: true }).click();
  customer = await browser.newContext({ baseURL: "http://localhost:3000" });
  const visitor = await customer.newPage();
  await visitor.goto("/chat/" + deployment);
  await visitor.getByLabel("Message", { exact: true }).fill("I want a human");
  await visitor
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(
    visitor.getByText("I can help with account issues.", { exact: false }),
  ).toBeVisible();
  await expect(
    visitor.getByRole("button", { name: "Connect me", exact: true }),
  ).toHaveCount(0);
  await expect(
    visitor.getByRole("button", { name: "Request human support", exact: true }),
  ).toHaveCount(0);
  await visitor.getByLabel("Message", { exact: true }).fill("I need a human");
  await visitor
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(
    visitor.getByRole("button", { name: "Connect me", exact: true }),
  ).toBeVisible();
  // Declining an offer keeps the conversation in AI mode.
  await visitor
    .getByRole("button", { name: "Keep trying with AI", exact: true })
    .click();
  await expect(
    visitor.getByRole("button", { name: "Connect me", exact: true }),
  ).toHaveCount(0);
  await visitor.getByLabel("Message", { exact: true }).fill("I want a human");
  await visitor
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(
    visitor.getByRole("button", { name: "Connect me", exact: true }),
  ).toHaveCount(0);
  await visitor.getByLabel("Message", { exact: true }).fill("I need a human");
  await visitor
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(
    visitor.getByRole("button", { name: "Connect me", exact: true }),
  ).toBeVisible();
  await visitor
    .getByRole("button", { name: "Connect me", exact: true })
    .click();
  await expect(
    visitor.getByText("Waiting for an operator.", { exact: false }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const [s] =
        await sql`SELECT id,triage_status FROM support_cases WHERE workspace_id=${workspace}`;
      caseId = s?.id;
      return s?.triage_status;
    })
    .toBe("completed");
  expect(triageCalls).toBe(1);
  await openSupport(page, caseId);
  const brief = page.getByRole("region", { name: "AI handoff brief" });
  await expect(brief.getByText(result.summary, { exact: true })).toBeVisible();
  await expect(
    brief.getByText(result.suggestedNextAction, { exact: true }),
  ).toBeVisible();
  await expect(visitor.getByText(result.summary, { exact: true })).toHaveCount(
    0,
  );
  await send(
    "post",
    `/workspaces/${workspace}/support/cases/${caseId}/claim`,
    {},
  );
  await send("post", `/workspaces/${workspace}/support/cases/${caseId}/notes`, {
    content: "PRIVATE OPERATOR NOTE",
  });
  await brief
    .getByRole("button", { name: "Refresh brief", exact: true })
    .click();
  await expect.poll(() => triageCalls).toBe(2);
  await expect
    .poll(async () => {
      const [s] =
        await sql`SELECT triage_status FROM support_cases WHERE id=${caseId}`;
      return s.triage_status;
    })
    .toBe("completed");
  await page.setViewportSize({ width: 1440, height: 1100 });
  await expect(
    brief.getByRole("button", { name: "Refresh brief", exact: true }),
  ).toBeEnabled({ timeout: 10000 });
  triageFailure = true;
  await brief
    .getByRole("button", { name: "Refresh brief", exact: true })
    .click();
  await expect(
    brief.getByText("Manual support remains available", { exact: false }),
  ).toBeVisible({ timeout: 10000 });
  await expect(
    brief.getByText("Failure code: AUTHENTICATION_FAILED", { exact: true }),
  ).toBeVisible();
  await expect(brief.getByText(result.summary, { exact: true })).toBeVisible();
  triageFailure = false;
  await brief
    .getByRole("button", { name: "Refresh brief", exact: true })
    .click();
  await expect
    .poll(async () => {
      const [s] =
        await sql`SELECT triage_status FROM support_cases WHERE id=${caseId}`;
      return s.triage_status;
    })
    .toBe("completed");
  await expect(
    brief.getByRole("button", { name: "Refresh brief", exact: true }),
  ).toBeEnabled({ timeout: 10000 });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: "docs/support-console/triage-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Handoff policy", exact: true })
    .click();
  await page
    .getByLabel("Policy scope", { exact: true })
    .selectOption("deployment");
  await page.getByLabel("Deployment", { exact: true }).selectOption(deployment);
  await expect(
    page.getByText("Using workspace policy", { exact: false }),
  ).toBeVisible();
  await page
    .getByLabel("Human access", { exact: true })
    .selectOption("disabled");
  await page.getByRole("button", { name: "Save policy", exact: true }).click();
  await expect(
    page.getByText("Using deployment policy", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Handoff policy", exact: true })
    .click();
  await page
    .getByLabel("Policy scope", { exact: true })
    .selectOption("deployment");
  await page.getByLabel("Deployment", { exact: true }).selectOption(deployment);
  await expect(page.getByLabel("Human access", { exact: true })).toHaveValue(
    "disabled",
  );
  await page.setViewportSize({ width: 360, height: 900 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: "docs/support-console/policy-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Reset to inherited policy", exact: true })
    .scrollIntoViewIfNeeded();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Reset to inherited policy", exact: true })
    .click();
  await expect(page.getByLabel("Human access", { exact: true })).toHaveValue(
    "policy_controlled",
  );
  analystContext = await browser.newContext({
    baseURL: "http://localhost:3000",
  });
  await staff(analystContext, "analyst");
  const analyst = await analystContext.newPage();
  await openSupport(analyst);
  await analyst
    .getByRole("button", { name: "Handoff policy", exact: true })
    .click();
  await expect(
    analyst.getByLabel("Human access", { exact: true }),
  ).toBeDisabled();
  await expect(
    analyst.getByRole("button", { name: "Save policy", exact: true }),
  ).toHaveCount(0);
});
