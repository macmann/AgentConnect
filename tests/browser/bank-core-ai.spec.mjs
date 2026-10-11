import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const sql = postgres(process.env.DATABASE_URL, { max: 1 }),
  org = randomUUID(),
  workspace = randomUUID(),
  model = randomUUID(),
  kb = randomUUID(),
  embedding = randomUUID(),
  source = randomUUID(),
  agent = randomUUID();
const users = { owner: randomUUID(), reviewer: randomUUID() },
  sessions = {};
const provider = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const input = JSON.parse(body || "{}");
  if (req.url.includes("embeddings")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: input.input.map((_, index) => ({ index, embedding: [1, 0, 0] })),
      }),
    );
    return;
  }
  const system =
    input.messages?.find((m) => m.role === "system")?.content ?? "";
  const content = system.includes("Approved-knowledge-only")
    ? JSON.stringify({
        kind: "answer",
        message: "Follow the approved recovery screen [1].",
      })
    : "Fixture response";
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    "data: " +
      JSON.stringify({
        choices: [{ delta: { content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 5 },
      }) +
      "\n\ndata: [DONE]\n\n",
  );
});
const site = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    `<html><body><h1>Bank integration fixture</h1><script src="http://localhost:4000/widget.js" data-deployment="${deployment}"></script></body></html>`,
  );
});
let deployment = "";
test.beforeAll(async () => {
  await new Promise((r) => provider.listen(4566, "127.0.0.1", r));
  await new Promise((r) => site.listen(4567, "127.0.0.1", r));
  await sql.begin(async (tx) => {
    for (const [role, id] of Object.entries(users)) {
      const raw = randomUUID();
      sessions[role] = raw;
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${id},${id + "@example.com"},${role},'fixture-no-login',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(raw).digest("hex")},${id},now()+interval '1 hour')`;
    }
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Bank browser fixture')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Bank browser fixture')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${users.owner},'owner')`;
    await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${workspace},${users.reviewer},'workspace_admin')`;
    await tx`INSERT INTO model_configurations(id,workspace_id,organization_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES (${model},${workspace},${org},'Bank fixture model','openai-compatible','fixture','http://127.0.0.1:4566/v1',32768,4096,${tx.json({ streaming: true, temperature: true, topP: true })})`;
    await tx`INSERT INTO embedding_models(id,workspace_id,organization_id,name,provider,model_id,base_url,dimensions) VALUES (${embedding},${workspace},${org},'Bank fixture embeddings','openai-compatible','fixture','http://127.0.0.1:4566/v1',3)`;
    await tx`INSERT INTO knowledge_bases(id,workspace_id,organization_id,name,description,embedding_model_id,dimensions,chunk_size,chunk_overlap,chunk_strategy,public_access,approval_required) VALUES (${kb},${workspace},${org},'Bank recovery','Approved steps',${embedding},3,1600,200,'recursive',true,true)`;
    await tx`INSERT INTO knowledge_sources(id,knowledge_base_id,workspace_id,organization_id,kind,title,status) VALUES (${source},${kb},${workspace},${org},'text','Recovery guidance','ready')`;
    const doc = randomUUID();
    await tx`INSERT INTO knowledge_documents(id,source_id,knowledge_base_id,workspace_id,organization_id,title,metadata,page_count,content_hash,revision) VALUES (${doc},${source},${kb},${workspace},${org},'Recovery guidance',${tx.json({})},1,'fixture',1)`;
    await tx`INSERT INTO knowledge_chunks(id,document_id,source_id,knowledge_base_id,workspace_id,organization_id,embedding_model_id,dimensions,ordinal,content,metadata,embedding) VALUES (${randomUUID()},${doc},${source},${kb},${workspace},${org},${embedding},3,0,'Follow the approved recovery screen.',${tx.json({})},'[1,0,0]'::vector)`;
    await tx`INSERT INTO agents(id,workspace_id,organization_id,name,description,public_description,draft_config,created_by) VALUES (${agent},${workspace},${org},'Bank assistant','','',${tx.json({ schemaVersion: 1, modelId: model, prompt: { role: "Bank support assistant", objective: "", instructions: "", constraints: "", tone: "", outputFormat: "", escalationPolicy: "", advanced: null }, rag: { knowledgeBaseIds: [kb] }, tools: { toolIds: [], maxCalls: 3 }, category: "hybrid", temperature: 0.5, topP: null, maxOutputTokens: 1024, historyWindow: 10, language: "English", timezone: "UTC", welcomeMessage: "Welcome to bank support", fallbackResponse: "Unavailable", conversationStarters: [] })},${users.owner})`;
  });
});
test.afterAll(async () => {
  await new Promise((r) => provider.close(r));
  await new Promise((r) => site.close(r));
  try {
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
        "knowledge_jobs",
        "knowledge_documents",
        "knowledge_sources",
        "knowledge_bases",
        "embedding_models",
        "audit_events",
        "memberships",
        "workspaces",
      ])
        await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
      await tx`DELETE FROM organizations WHERE id=${org}`;
      for (const uid of Object.values(users))
        await tx`DELETE FROM users WHERE id=${uid}`;
    });
  } finally {
    await sql.end();
  }
});
async function auth(context, role = "owner") {
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
const url = (view, extra = "") =>
  `/#view=${view}&organization=${org}&workspace=${workspace}${extra}`;
async function post(context, path, data, method = "post") {
  const r = await context.request[method]("http://localhost:4000" + path, {
    headers: { origin: "http://localhost:3000" },
    data,
  });
  expect(r.ok(), await r.text()).toBe(true);
  return r.json();
}
test("Reviewed knowledge, banking quick actions, grounded guidance and transfer handoff work across hosted and widget UI", async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(20000);
  await auth(context);
  await page.goto(url("Knowledge"));
  await page.getByText("Bank recovery", { exact: true }).click();
  await page.getByRole("button", { name: "releases", exact: true }).click();
  await page.getByText("Create a release", { exact: true }).click();
  await page
    .getByLabel("Release name", { exact: true })
    .fill("Approved recovery v1");
  await page.getByLabel("Recovery guidance", { exact: true }).check();
  await page
    .getByRole("button", { name: "Create frozen draft", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Submit for review", exact: true })
    .click();
  await expect(
    page.getByText("review · 1 sources · 1 passages", { exact: true }),
  ).toBeVisible();
  const reviewer = await browser.newContext();
  try {
    await auth(reviewer, "reviewer");
    const review = await reviewer.newPage();
    await review.goto(url("Knowledge"));
    await review.getByText("Bank recovery", { exact: true }).click();
    await review.getByRole("button", { name: "releases", exact: true }).click();
    await review
      .getByRole("button", { name: "Review passages", exact: true })
      .click();
    await expect(review.locator(".source-snippet")).toContainText(
      "approved recovery",
    );
    await review
      .getByLabel("Review note", { exact: true })
      .fill("Verified approved bank procedure");
    await review.getByRole("button", { name: "Approve", exact: true }).click();
    await review
      .getByRole("button", { name: "Publish release", exact: true })
      .click();
    await expect(review.getByText(/Current published release/)).toBeVisible();
  } finally {
    await reviewer.close();
  }
  await page.goto(
    url("Agents", `&agent=${agent}&stage=configure&section=experience`),
  );
  await page
    .getByRole("button", { name: "Add banking templates", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("navigation", { name: "Configure sections" })
    .getByRole("button", { name: "Knowledge", exact: true })
    .click();
  await page
    .getByLabel("Answer policy", { exact: true })
    .selectOption("grounded");
  await page
    .getByLabel("Bank recovery — knowledge release", { exact: true })
    .selectOption({ label: "Version 1 · Approved recovery v1" });
  const savedResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/agents/${agent}`) && r.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  expect((await savedResponse).status()).toBe(200);
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(
    0,
  );
  const [saved] =
    await sql`SELECT revision,draft_config FROM agents WHERE id=${agent}`;
  expect(saved.draft_config.quickActions).toHaveLength(8);
  expect(saved.draft_config.journeys).toHaveLength(4);
  expect(saved.draft_config.answerPolicy.mode).toBe("grounded");
  const v = await post(context, `/agents/${agent}/publish`, {
    revision: saved.revision,
  });
  deployment = (
    await post(context, `/agents/${agent}/deployments`, {
      name: "Bank support",
      versionId: v.id,
    })
  ).id;
  await post(
    context,
    `/workspaces/${workspace}/support/policy`,
    {
      humanEntryMode: "policy_controlled",
      aiTriageEnabled: false,
      generateHandoffSummary: false,
    },
    "put",
  );
  await sql`UPDATE deployments SET widget_settings=${sql.json({ enabled: true, access: "restricted", allowedOrigins: ["http://localhost:4567"], theme: "light", position: "right", launcher: "Chat", greeting: "Bank support", width: 380, height: 560, language: "en" })} WHERE id=${deployment}`;
  const guest = await browser.newContext();
  try {
    const chat = await guest.newPage();
    await chat.goto(`/chat/${deployment}`);
    await expect(
      chat.getByRole("button", { name: "Bill Payment", exact: true }),
    ).toBeVisible();
    await chat
      .getByRole("button", { name: "Forgot Password", exact: true })
      .click();
    await expect(
      chat.getByText(/Which app or service are you trying to access/),
    ).toBeVisible();
    for (const answer of ["Next app", "I cannot find recovery"]) {
      await chat.getByLabel("Message", { exact: true }).fill(answer);
      await chat
        .getByRole("button", { name: "Send message", exact: true })
        .click();
    }
    await expect(
      chat.getByText("Follow the approved recovery screen [1].", {
        exact: true,
      }),
    ).toBeVisible();
    const widget = await guest.newPage();
    await widget.goto("http://localhost:4567");
    await widget.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(
      widget.getByRole("button", { name: "Transfer Issue", exact: true }),
    ).toBeVisible();
    await widget
      .getByRole("button", { name: "Transfer Issue", exact: true })
      .click();
    for (const [i, answer] of [
      "Next app",
      "2026-10-11",
      "REF-456",
      "Pending",
    ].entries()) {
      await expect(
        widget.getByRole("button", { name: "Send", exact: true }),
      ).toBeEnabled();
      await widget.getByLabel("Message", { exact: true }).fill(answer);
      await widget.getByRole("button", { name: "Send", exact: true }).click();
      if (i < 3)
        await expect(
          widget.getByText(/transfer|transaction|went wrong/i).last(),
        ).toBeVisible();
    }
    await expect(
      widget.getByText(/has not verified or changed any transaction/),
    ).toBeVisible();
    await widget
      .getByRole("button", { name: "Connect me", exact: true })
      .click();
    await expect(
      widget.getByText("Waiting for human support. You can leave a message.", {
        exact: true,
      }),
    ).toBeVisible();
    await chat.setViewportSize({ width: 360, height: 800 });
    await expect(
      chat.getByRole("button", { name: "Find Nearest Branch", exact: true }),
    ).toBeVisible();
    expect(
      await chat.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await guest.close();
  }
});
