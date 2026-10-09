import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const org = randomUUID(),
  workspace = randomUUID(),
  user = randomUUID(),
  analyst = randomUUID(),
  session = randomUUID(),
  analystSession = randomUUID(),
  model = randomUUID(),
  agent = randomUUID(),
  conversation = randomUUID(),
  run = randomUUID(),
  message = randomUUID(),
  version = randomUUID(),
  deployment = randomUUID();
test.beforeAll(async () => {
  await sql.begin(async (tx) => {
    for (const [id, raw, name] of [
      [user, session, "Operations owner"],
      [analyst, analystSession, "Operations analyst"],
    ]) {
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${id},${id + "@example.com"},${name},'unused-browser-fixture',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(raw).digest("hex")},${id},now()+interval '1 hour')`;
    }
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Operations browser')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Operations workspace')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${user},'owner')`;
    await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${workspace},${analyst},'analyst')`;
    await tx`INSERT INTO model_configurations(id,organization_id,workspace_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES (${model},${org},${workspace},'Operations browser model','openai-compatible','fixture','https://api.openai.com/v1',4096,1024,'{"streaming":true,"temperature":true,"topP":true}')`;
    const config = tx.json({ modelId: model }),
      snapshot = tx.json({
        id: model,
        provider: "openai-compatible",
        modelId: "fixture",
        baseUrl: "https://api.openai.com/v1",
        secretId: null,
        contextWindow: 4096,
        maxOutputTokens: 1024,
        capabilities: { streaming: true, temperature: true, topP: true },
      });
    await tx`INSERT INTO agents(id,organization_id,workspace_id,name,description,public_description,draft_config,created_by) VALUES (${agent},${org},${workspace},'Operations browser agent','','',${config},${user})`;
    await tx`INSERT INTO conversations(id,organization_id,workspace_id,agent_id,user_id,config_snapshot,model_snapshot) VALUES (${conversation},${org},${workspace},${agent},${user},${config},${snapshot})`;
    await tx`INSERT INTO agent_runs(id,conversation_id,organization_id,workspace_id,status,trace_id,input_tokens,output_tokens,input_usd_per_million,output_usd_per_million,finished_at) VALUES (${run},${conversation},${org},${workspace},'completed',${randomUUID()},100,200,2,4,now())`;
    await tx`INSERT INTO messages(id,conversation_id,organization_id,workspace_id,run_id,role,content) VALUES (${message},${conversation},${org},${workspace},${run},'assistant','Original browser response')`;
    await tx`INSERT INTO agent_versions(id,agent_id,workspace_id,organization_id,version,name,public_description,config,model_snapshot,model_id,published_by) VALUES (${version},${agent},${workspace},${org},1,'Operations browser agent','',${config},${snapshot},${model},${user})`;
    await tx`INSERT INTO deployments(id,organization_id,workspace_id,agent_id,version_id,name,environment) VALUES (${deployment},${org},${workspace},${agent},${version},'Browser deployment','staging')`;
  });
});
test.afterAll(async () => {
  await sql.begin(async (tx) => {
    for (const table of [
      "webhook_deliveries",
      "workspace_webhooks",
      "workspace_api_keys",
      "conversation_reviews",
      "messages",
      "agent_runs",
      "conversations",
      "deployments",
      "agent_versions",
      "agents",
      "model_prices",
      "model_configurations",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    await tx`DELETE FROM users WHERE id=ANY(${[user, analyst]})`;
  });
  await sql.end();
});
async function login(page, context, raw = session) {
  await context.addCookies([
    {
      name: "session",
      value: raw,
      url: "http://localhost:3000",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/");
}
test("operations analytics, pricing, key revocation, review and deployment environment", async ({
  page,
  context,
}) => {
  await login(page, context);
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Workspace operations" }),
  ).toBeVisible();
  await expect(page.getByText("$0.001000").first()).toBeVisible();
  await page.getByRole("tab", { name: "Pricing", exact: true }).click();
  await page.getByLabel("Input USD / million tokens").fill("2");
  await page.getByLabel("Output USD / million tokens").fill("4");
  await page.getByRole("button", { name: "Save pricing" }).click();
  await expect(page.getByText("Pricing saved", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "API keys", exact: true }).click();
  await page.getByLabel("Key label").fill("Browser application");
  await page
    .getByRole("button", { name: "Create API key", exact: true })
    .click();
  await expect(
    page.getByText("Copy this secret now. It is displayed only once."),
  ).toBeVisible();
  await expect(page.locator(".operations-secret code")).toHaveText(/^ac_/);
  await page.getByRole("button", { name: "Dismiss secret" }).click();
  await expect(page.locator(".operations-secret")).toHaveCount(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Deployments", exact: true }).click();
  await page
    .getByLabel("Environment for Browser deployment")
    .selectOption("production");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText("v1 · production · Active")).toBeVisible();
  await page.getByRole("tab", { name: "Webhooks", exact: true }).click();
  await page.getByLabel("Webhook name").fill("Unapproved receiver");
  await page
    .getByLabel("Webhook URL")
    .fill("https://unapproved.example/events");
  await page
    .getByRole("button", { name: "Register webhook", exact: true })
    .click();
  await expect(
    page.locator(".operations-content").getByRole("alert"),
  ).toContainText("WEBHOOK_ALLOWED_HOSTS");
  await page.getByRole("tab", { name: "Audit", exact: true }).click();
  await page.getByLabel("Filter by action").fill("api_key.revoked");
  await expect(
    page.getByRole("cell", { name: "api_key.revoked", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Conversations", exact: true })
    .click();
  await page.getByRole("button", { name: /Operations browser agent/ }).click();
  await expect(
    page.getByText("Original browser response", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review response" }).click();
  await page
    .getByLabel("Response rating", { exact: true })
    .selectOption("dislike");
  await page.getByLabel("Review label").selectOption("incomplete");
  await page.getByLabel("Feedback comment").fill("Needs more detail");
  await page
    .getByLabel("Expected response (optional)")
    .fill("Suggested browser correction");
  await page
    .getByLabel("Correction reason", { exact: true })
    .fill("Missing detail");
  await page.getByRole("button", { name: "Save review" }).click();
  await expect(
    page.getByText("Suggested browser correction", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Original browser response", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Rating filter", { exact: true }).selectOption("like");
  await expect(page.getByText(/No conversations match/)).toBeVisible();
  await page
    .getByLabel("Rating filter", { exact: true })
    .selectOption("dislike");
  await expect(
    page.getByRole("button", { name: /Operations browser agent/ }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Workspace operations" }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/agentconnect-phase5-operations-mobile.png",
    fullPage: true,
  });
});
test("analyst sees operational reports and reviews without administration controls", async ({
  page,
  context,
}) => {
  await login(page, context, analystSession);
  await page.getByRole("button", { name: "Operations", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Analytics", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "API keys", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "Members", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Conversations", exact: true })
    .click();
  await page.getByRole("button", { name: /Operations browser agent/ }).click();
  await expect(
    page.getByText("Original browser response", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review response" }),
  ).toHaveCount(0);
});
