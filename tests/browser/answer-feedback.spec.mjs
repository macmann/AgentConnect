import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
import { cleanupKnowledgeFixtures } from "../../apps/api/test/knowledge-cleanup.mjs";
if (process.env.NODE_ENV === "production")
  throw new Error("No production fixtures");
const sql = postgres(process.env.DATABASE_URL, { max: 1 }),
  org = randomUUID(),
  workspace = randomUUID(),
  kb = randomUUID(),
  embedding = randomUUID(),
  model = randomUUID(),
  source = randomUUID(),
  doc = randomUUID();
const users = {},
  sessions = {};
let agent,
  deployment,
  customer,
  reviewerContext,
  wrong = true;
const markdown =
  '## Recovery steps\n\nYou can **reset online**.\n\n1. Open the app.\n2. Reset your password.\n\n| Item | Status |\n| --- | --- |\n| Password | Pending |\n\n```json\n{"step":1}\n```\n\n[Help](https://example.com/support)\n\n[Unsafe](javascript:alert(1))\n\n<script>window.__markdownExecuted=true</script>\n\n[1]';
const provider = createServer(async (req, res) => {
  let text = "";
  for await (const c of req) text += c;
  const body = JSON.parse(text);
  if (req.url.includes("/embeddings")) {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: inputs.map((_, index) => ({ index, embedding: [1, 0, 0] })),
        usage: { prompt_tokens: 5, total_tokens: 5 },
      }),
    );
    return;
  }
  const system = body.messages.find((m) => m.role === "system")?.content || "";
  const answer =
    system.includes("Branch KYC") && !wrong
      ? "Branch KYC is required [1]"
      : markdown;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    "data: " +
      JSON.stringify({
        choices: [{ delta: { content: answer }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 20 },
      }) +
      "\n\ndata: [DONE]\n\n",
  );
});
const website = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    `<!doctype html><html><body><h1>Customer website</h1><script src="http://localhost:4000/widget.js" data-deployment="${deployment}"></script></body></html>`,
  );
});
async function api(method, path, data, role = "owner") {
  const r = await fetch("http://localhost:4000" + path, {
    method,
    headers: {
      origin: "http://localhost:3000",
      cookie: "session=" + sessions[role],
      ...(data ? { "content-type": "application/json" } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const b = await r.json();
  expect(r.ok, JSON.stringify(b)).toBeTruthy();
  return b;
}
async function staff(context, role) {
  await context.addCookies([
    {
      name: "session",
      value: sessions[role],
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      expires: Math.floor(Date.now() / 1000) + 3600,
    },
  ]);
}
const route = (view, extra = "") =>
  "/#view=" +
  encodeURIComponent(view) +
  "&organization=" +
  org +
  "&workspace=" +
  workspace +
  extra;
test.beforeAll(async () => {
  await expect
    .poll(
      async () => {
        try {
          return (await fetch("http://localhost:4000/health/ready")).status;
        } catch {
          return 0;
        }
      },
      { timeout: 15000 },
    )
    .toBe(200);
  const budget = await fetch("http://localhost:4000/auth/me");
  if (Number(budget.headers.get("x-ratelimit-remaining") ?? 300) < 200)
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
  await new Promise((r) => provider.listen(4551, "127.0.0.1", r));
  await new Promise((r) => website.listen(4569, "127.0.0.1", r));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES(${org},'Feedback browser fixtures')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES(${workspace},${org},'Feedback browser workspace')`;
    for (const role of ["owner", "reviewer"]) {
      users[role] = randomUUID();
      sessions[role] = randomUUID();
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES(${users[role]},${users[role] + "@example.invalid"},${role},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(${createHash("sha256").update(sessions[role]).digest("hex")},${users[role]},now()+interval '1 hour')`;
      await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES(${randomUUID()},${org},${role === "owner" ? null : workspace},${users[role]},${role === "owner" ? "owner" : "workspace_admin"})`;
    }
    await tx`INSERT INTO embedding_models(id,organization_id,workspace_id,name,provider,model_id,base_url,dimensions) VALUES(${embedding},${org},${workspace},'Fixture embeddings','openai-compatible','fixture','http://127.0.0.1:4551/v1',3)`;
    await tx`INSERT INTO model_configurations(id,organization_id,workspace_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES(${model},${org},${workspace},'Fixture chat','openai-compatible','fixture','http://127.0.0.1:4551/v1',32768,4096,${tx.json({ temperature: true, topP: true })})`;
    await tx`INSERT INTO knowledge_bases(id,organization_id,workspace_id,name,description,embedding_model_id,dimensions,chunk_size,chunk_overlap,chunk_strategy,public_access,approval_required) VALUES(${kb},${org},${workspace},'Recovery procedures','Reviewed recovery',${embedding},3,1600,200,'recursive',true,true)`;
    await tx`INSERT INTO knowledge_sources(id,knowledge_base_id,organization_id,workspace_id,kind,title,status) VALUES(${source},${kb},${org},${workspace},'text','Recovery','ready')`;
    await tx`INSERT INTO knowledge_documents(id,source_id,knowledge_base_id,organization_id,workspace_id,title,metadata,page_count,content_hash,revision) VALUES(${doc},${source},${kb},${org},${workspace},'Recovery',${tx.json({})},1,'fixture',1)`;
    await tx`INSERT INTO knowledge_chunks(id,document_id,source_id,knowledge_base_id,workspace_id,organization_id,embedding_model_id,dimensions,ordinal,content,metadata,embedding) VALUES(${randomUUID()},${doc},${source},${kb},${workspace},${org},${embedding},3,0,'Password recovery screen.',${tx.json({})},'[1,0,0]'::vector)`;
    await tx`INSERT INTO support_policies(id,organization_id,workspace_id,scope,target_id,policy) VALUES(${randomUUID()},${org},${workspace},'workspace',${workspace},${tx.json({ humanEntryMode: "disabled", aiTriageEnabled: false, generateHandoffSummary: false })})`;
  });
  const r = await api("POST", `/knowledge-bases/${kb}/releases`, {
    name: "Initial release",
    sourceIds: [source],
  });
  for (const [action, role] of [
    ["submit", "owner"],
    ["approve", "reviewer"],
    ["publish", "reviewer"],
  ])
    await api(
      "POST",
      `/knowledge-bases/${kb}/releases/${r.id}/transition`,
      { action },
      role,
    );
  const a = await api("POST", `/workspaces/${workspace}/agents`, {
    name: "Recovery assistant",
    config: {
      modelId: model,
      prompt: { instructions: "Answer using the approved knowledge." },
      rag: { knowledgeBaseIds: [kb], requireCitations: true },
    },
  });
  agent = a.id;
  const v = await api("POST", `/agents/${agent}/publish`, { revision: 1 });
  deployment = (
    await api("POST", `/agents/${agent}/deployments`, {
      name: "Customer chat",
      versionId: v.id,
    })
  ).id;
});
test.afterAll(async () => {
  await customer?.close();
  await reviewerContext?.close();
  website.closeAllConnections();
  await new Promise((r) => website.close(r));
  provider.closeAllConnections();
  await new Promise((r) => provider.close(r));
  try {
    await cleanupKnowledgeFixtures(sql, org);
    await sql.begin(async (tx) => {
      for (const table of [
        "evaluation_results",
        "evaluation_runs",
        "knowledge_improvements",
        "conversation_reviews",
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
        "evaluation_datasets",
        "embedding_models",
        "audit_events",
        "memberships",
        "workspaces",
      ])
        await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
      await tx`DELETE FROM organizations WHERE id=${org}`;
      await tx`DELETE FROM users WHERE id=ANY(${Object.values(users)}::uuid[])`;
    });
  } finally {
    await sql.end();
  }
});
test("Playground renders safe Markdown and restores formatted replies after navigation", async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  await staff(context, "owner");
  await page.goto(route("Agents", "&agent=" + agent + "&stage=playground"));
  await page
    .getByLabel("Message", { exact: true })
    .fill("I forgot my password.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const answer = page.locator(".chat-markdown").last();
  await expect(
    answer.getByRole("heading", { name: "Recovery steps" }),
  ).toBeVisible();
  await expect(answer.locator("strong")).toHaveText("reset online");
  await expect(answer.locator("ol li")).toHaveCount(2);
  await expect(
    answer.getByRole("cell", { name: "Pending", exact: true }),
  ).toBeVisible();
  await expect(answer.locator("pre code")).toContainText('{"step":1}');
  expect(await page.evaluate(() => window.__markdownExecuted)).toBeUndefined();
  await expect(answer.locator("script")).toHaveCount(0);
  expect(
    await answer
      .getByRole("link", { name: "Unsafe", exact: true })
      .getAttribute("href"),
  ).not.toContain("javascript:");
  await page.goto(route("Operations"));
  await page.goto(route("Agents", "&agent=" + agent + "&stage=playground"));
  await expect(
    page
      .locator(".chat-markdown")
      .getByRole("heading", { name: "Recovery steps" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
test("Customer report becomes an independently reviewed, regression-gated correction", async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  await staff(context, "owner");
  customer = await browser.newContext({ baseURL: "http://localhost:3000" });
  const visitor = await customer.newPage();
  await visitor.goto("/chat/" + deployment);
  await visitor
    .getByLabel("Message", { exact: true })
    .fill("I forgot my password.");
  await visitor
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await visitor
    .getByRole("button", { name: "Report this answer", exact: true })
    .click();
  await visitor.getByLabel("What went wrong?").selectOption("unresolved");
  await visitor.getByLabel("Additional details").fill("Branch KYC is missing.");
  await visitor.getByRole("button", { name: "Submit answer report" }).click();
  await expect(
    visitor.getByText(/Your feedback is saved for review/),
  ).toBeVisible();
  await page.goto(route("Operations", "&operationsSection=Answer+reports"));
  await page.getByRole("button", { name: "Review report" }).click();
  await page.getByRole("button", { name: "Claim report" }).click();
  await page.getByLabel("Report status").selectOption("reviewing");
  await page.getByRole("button", { name: "Review report" }).click();
  await page
    .getByLabel("Review note")
    .fill("The approved procedure requires branch verification.");
  await page.getByLabel("Correction knowledge base").selectOption(kb);
  await page
    .getByLabel("Approved answer proposal")
    .fill("Branch KYC is required");
  await page
    .getByRole("button", { name: "Propose correction for review" })
    .click();
  await expect(
    page.getByRole("button", { name: "Propose correction for review" }),
  ).toBeHidden();
  reviewerContext = await browser.newContext({
    baseURL: "http://localhost:3000",
  });
  await staff(reviewerContext, "reviewer");
  const reviewer = await reviewerContext.newPage();
  reviewer.setDefaultTimeout(15000);
  await reviewer.goto(route("Operations", "&operationsSection=Knowledge+gaps"));
  await reviewer
    .locator("details.knowledge-gap-row")
    .filter({ hasText: "· draft" })
    .locator("summary")
    .click();
  await reviewer
    .getByRole("button", { name: "Approve correction", exact: true })
    .click();
  await reviewer
    .getByRole("button", {
      name: "Add as unpublished knowledge source",
      exact: true,
    })
    .click();
  await expect
    .poll(
      async () => {
        const [i] =
          await sql`SELECT s.status FROM knowledge_improvements i JOIN knowledge_sources s ON s.id=i.source_id WHERE i.workspace_id=${workspace}`;
        return i?.status;
      },
      { timeout: 20000 },
    )
    .toBe("ready");
  const sources =
    await sql`SELECT id FROM knowledge_sources WHERE knowledge_base_id=${kb} AND status='ready'`;
  const release = await api("POST", `/knowledge-bases/${kb}/releases`, {
    name: "Correction release",
    sourceIds: sources.map((s) => s.id),
  });
  await api(
    "POST",
    `/knowledge-bases/${kb}/releases/${release.id}/transition`,
    { action: "submit" },
  );
  await api(
    "POST",
    `/knowledge-bases/${kb}/releases/${release.id}/transition`,
    { action: "approve" },
    "reviewer",
  );
  await reviewer.goto(route("Knowledge"));
  await reviewer.getByRole("button", { name: /Recovery procedures/ }).click();
  await reviewer.getByRole("button", { name: "releases", exact: true }).click();
  const card = reviewer
    .locator("article.configure-group")
    .filter({ hasText: "Correction release" });
  await card.getByText("Correction verification", { exact: true }).click();
  await card
    .getByRole("button", { name: "Run correction regressions" })
    .click();
  await expect
    .poll(
      async () => {
        const rows =
          await sql`SELECT status FROM evaluation_runs WHERE candidate_release_id=${release.id}`;
        return rows.length === 2 && rows.every((r) => r.status === "completed");
      },
      { timeout: 20000 },
    )
    .toBe(true);
  await card
    .getByRole("button", { name: "Publish release", exact: true })
    .click();
  await expect(reviewer.locator(".error-banner[role=alert]")).toContainText(
    "Knowledge regression gate failed",
  );
  wrong = false;
  await card
    .getByRole("button", { name: "Run correction regressions" })
    .click();
  await expect
    .poll(
      async () => {
        const rows =
          await sql`SELECT status,summary FROM evaluation_runs WHERE candidate_release_id=${release.id} ORDER BY created_at DESC LIMIT 2`;
        return (
          rows.length === 2 &&
          rows.every(
            (r) => r.status === "completed" && r.summary.passRate === 1,
          )
        );
      },
      { timeout: 20000 },
    )
    .toBe(true);
  await card
    .getByRole("button", { name: "Publish release", exact: true })
    .click();
  await expect(card).toContainText("Current published release");
  await page.goto(route("Operations", "&operationsSection=Answer+reports"));
  await page.getByLabel("Report status").selectOption("verified");
  await page.getByRole("button", { name: "Review report" }).click();
  await page
    .getByLabel("Review note")
    .fill("Verified the regression replay and corrected publication.");
  await page
    .getByRole("button", { name: "Confirm verification and close" })
    .click();
  await expect(page.getByText("No reports in this status.")).toBeVisible();
  await visitor.reload();
  await visitor
    .getByRole("button", { name: "Report this answer", exact: true })
    .click();
  await expect(visitor.getByText(/Report closed/)).toBeVisible();
});

test("Website widget reports the exact answer and restores its review status", async ({
  page,
}) => {
  test.setTimeout(90000);
  page.setDefaultTimeout(15000);
  await api("PUT", `/workspaces/${workspace}/channels/${deployment}`, {
    enabled: true,
    access: "restricted",
    allowedOrigins: ["http://localhost:4569"],
    theme: "light",
    position: "right",
    launcher: "Chat",
    greeting: "How can we help?",
    width: 420,
    height: 720,
    language: "en",
  });

  page.on("requestfailed", (r) =>
    console.log(
      "Widget request failed:",
      new URL(r.url()).pathname,
      r.failure()?.errorText,
    ),
  );
  page.on("pageerror", (e) => console.log("Widget runtime error:", e.message));
  await page.goto("http://localhost:4569");
  await expect(
    page.getByRole("heading", { name: "Customer website", exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      async () => {
        const labels = await page.getByRole("button").allTextContents();
        if (labels.includes("Chat unavailable"))
          throw new Error(
            await page
              .getByRole("button", { name: "Chat unavailable" })
              .getAttribute("title"),
          );
        return labels.includes("Chat");
      },
      { timeout: 10000 },
    )
    .toBe(true);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByPlaceholder("Your message").fill("I forgot my password.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Report this answer", { exact: true }).click();
  await page.getByLabel("What went wrong?").selectOption("not_helpful");
  await page
    .getByLabel("Additional details")
    .fill("I need more detail about the branch visit.");
  await page.getByRole("button", { name: "Submit answer report" }).click();
  await expect(
    page.getByText(/Your feedback is saved for review/),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByText("Report this answer", { exact: true }).click();
  await expect(page.getByText(/Report reported/)).toBeVisible();
});
