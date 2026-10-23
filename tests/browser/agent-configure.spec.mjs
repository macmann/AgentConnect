import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
test.setTimeout(180000);
const sql = postgres(process.env.DATABASE_URL, { max: 1 }),
  org = randomUUID(),
  workspace = randomUUID(),
  model = randomUUID(),
  agent = randomUUID(),
  kb = randomUUID(),
  embedding = randomUUID(),
  tool = randomUUID(),
  source = randomUUID();
const users = {},
  sessions = {};
const config = {
  schemaVersion: 1,
  modelId: model,
  category: "hybrid",
  prompt: {
    role: "Customer guide",
    objective: "Resolve product questions",
    instructions: "Give concise guidance.",
    constraints: "Never invent policy",
    tone: "Calm",
    outputFormat: "Plain text",
    escalationPolicy: "Escalate complex cases",
    advanced: null,
  },
  temperature: 0.63,
  topP: 0.87,
  maxOutputTokens: 1000000,
  historyWindow: 17,
  language: "English",
  timezone: "Asia/Yangon",
  welcomeMessage: "Welcome to product support",
  fallbackResponse: "Our model is temporarily unavailable",
  conversationStarters: ["Reset password", "Card support"],
  rag: {
    knowledgeBaseIds: [kb],
    topK: 7,
    minScore: 0.35,
    mode: "hybrid",
    requireCitations: true,
  },
  tools: { toolIds: [tool], maxCalls: 4 },
  generative: {
    enabled: true,
    allowedBlocks: ["table"],
    allowPublicForms: false,
  },
};
const answerRequests = [];
const provider = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const input = body ? JSON.parse(body) : {};
  const planning = input.messages?.some(
    (m) => m.role === "system" && m.content.startsWith("Decide whether"),
  );
  const system =
    input.messages?.find((m) => m.role === "system")?.content ?? "";
  const query = input.messages?.at(-1)?.content ?? "";
  let answer = "Configure fixture answer";
  if (!planning) {
    answerRequests.push({ system, query });
    if (system.includes("Response language policy:") && query === "Hola")
      answer = "Hola, ¿en qué puedo ayudarte?";
    if (system.includes("Response language policy:") && query === "Bonjour")
      answer = "Bonjour, comment puis-je vous aider ?";
    if (
      system.endsWith("Respond in French.") ||
      system.includes("Respond in French.")
    )
      answer = "Bonjour, comment puis-je vous aider ?";
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    "data: " +
      JSON.stringify({
        choices: [
          {
            delta: {
              content: planning
                ? '{"retrieve":false}'
                : JSON.stringify({
                    version: 1,
                    message: answer,
                    blocks: [],
                  }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 4 },
      }) +
      "\n\ndata: [DONE]\n\n",
  );
});
async function waitForApiBudget(minRemaining = 200) {
  const budget = await fetch("http://localhost:4000/auth/me");
  if (Number(budget.headers.get("x-ratelimit-remaining") ?? 300) < minRemaining)
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(
          59000,
          Number(
            budget.headers.get("retry-after") ??
              budget.headers.get("x-ratelimit-reset") ??
              60,
          ) *
            1000 +
            500,
        ),
      ),
    );
}
test.beforeAll(async () => {
  await waitForApiBudget();
  await new Promise((r) => provider.listen(4551, "127.0.0.1", r));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Agent configure browser')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Configure workspace')`;
    for (const role of ["owner", "analyst"]) {
      users[role] = randomUUID();
      sessions[role] = randomUUID();
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${users[role]},${users[role] + "@example.invalid"},${role},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(sessions[role]).digest("hex")},${users[role]},now()+interval '1 hour')`;
      await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${role === "owner" ? null : workspace},${users[role]},${role})`;
    }
    await tx`INSERT INTO model_configurations(id,organization_id,workspace_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES (${model},${org},${workspace},'Configure model','openai-compatible','fixture','http://127.0.0.1:4551/v1',2000000,1500000,'{"streaming":true,"temperature":true,"topP":true}')`;
    await tx`INSERT INTO embedding_models(id,organization_id,workspace_id,name,provider,model_id,base_url,dimensions) VALUES (${embedding},${org},${workspace},'Fixture embeddings','openai-compatible','fixture','http://127.0.0.1:4551/v1',3)`;
    await tx`INSERT INTO knowledge_bases(id,organization_id,workspace_id,name,description,embedding_model_id,dimensions,chunk_size,chunk_overlap,chunk_strategy) VALUES (${kb},${org},${workspace},'Product FAQ','Synthetic health fixture',${embedding},3,500,50,'recursive')`;
    await tx`INSERT INTO knowledge_sources(id,knowledge_base_id,organization_id,workspace_id,kind,title,status) VALUES (${source},${kb},${org},${workspace},'text','Product facts','ready')`;
    await tx`INSERT INTO tools(id,organization_id,workspace_id,name,description,kind,config,input_schema,timeout_ms) VALUES (${tool},${org},${workspace},'Read-only lookup','Lookup facts','http',${tx.json({ url: "http://127.0.0.1:4551/facts", method: "GET" })},'{"type":"object","properties":{}}',5000)`;
    await tx`INSERT INTO agents(id,organization_id,workspace_id,name,description,public_description,draft_config,created_by) VALUES (${agent},${org},${workspace},'Product assistant','Internal team notes','Public product guidance',${tx.json(config)},${users.owner})`;
  });
});
test.afterAll(async () => {
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
      "knowledge_sources",
      "knowledge_bases",
      "embedding_models",
      "tools",
      "rerankers",
      "model_configurations",
      "secrets",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    for (const id of Object.values(users))
      await tx`DELETE FROM users WHERE id=${id}`;
  });
  await sql.end();
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
const url = (section) =>
  `/#view=Agents&organization=${org}&workspace=${workspace}&agent=${agent}&stage=configure&section=${section}`;
async function section(page, name) {
  await page
    .getByRole("navigation", { name: "Configure sections" })
    .getByRole("button", { name, exact: true })
    .click();
  await expect(
    page
      .locator(".configure-section-header")
      .getByRole("heading", { name, exact: true }),
  ).toBeVisible();
}
test("Configure preserves a single draft across sections, validates locally, previews prompts, saves and tests, and handles conflicts", async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  await waitForApiBudget();
  await auth(context);
  await page.goto(url("overview"));
  await expect(page.getByLabel("Agent name", { exact: true })).toHaveValue(
    "Product assistant",
  );
  await expect(page.getByText("Ready to test", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeInViewport();
  await expect(page.getByLabel("Instructions", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Change model", exact: true }).click();
  await expect(page.getByLabel("Model", { exact: true })).toBeFocused();
  await page
    .getByRole("button", { name: "Configure knowledge", exact: true })
    .click();
  await expect(
    page
      .locator(".configure-section-header")
      .getByRole("heading", { name: "Knowledge", exact: true }),
  ).toBeVisible();
  await section(page, "Overview");

  await page
    .getByLabel("Agent name", { exact: true })
    .fill("Updated product assistant");
  await section(page, "Prompt");
  await page
    .getByLabel("Instructions", { exact: true })
    .fill("Explain the approved product steps.");
  await page.getByText("Preview compiled prompt", { exact: true }).click();
  await expect(page.locator(".configure-prompt-preview")).toContainText(
    "instructions: Explain the approved product steps.",
  );
  await page.getByLabel("Advanced prompt mode", { exact: true }).check();
  await page
    .getByLabel("System prompt", { exact: true })
    .fill("Raw customer guidance");
  await expect(page.locator(".configure-prompt-preview")).toHaveText(
    "Raw customer guidance\n\nRespond in English.",
  );
  await page.getByLabel("Advanced prompt mode", { exact: true }).uncheck();
  await expect(page.getByLabel("Instructions", { exact: true })).toHaveValue(
    "Explain the approved product steps.",
  );
  await section(page, "Tools");
  await expect(
    page.getByLabel("Read-only lookup · Workspace only", { exact: true }),
  ).toBeChecked();
  await page.getByText("Advanced tool settings", { exact: true }).click();
  await expect(
    page.getByLabel("Maximum tool calls per response", { exact: true }),
  ).toHaveValue("4");
  await section(page, "Knowledge");
  await expect(
    page.getByText("1 / 1 sources ready", { exact: true }),
  ).toBeVisible();
  await page.getByText("Advanced retrieval settings", { exact: true }).click();
  await expect(
    page.getByLabel("Retrieved passages", { exact: true }),
  ).toHaveValue("7");
  await page.getByLabel("Minimum relevance", { exact: true }).fill("1.5");
  await page.getByLabel("Retrieved passages", { exact: true }).focus();
  await expect(page.locator("#agent-config-rag-minScore")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await section(page, "Overview");
  await page.getByLabel("Agent name", { exact: true }).fill("");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  const errors = page.getByRole("alert", { name: "Unable to save agent" });
  await expect(errors).toContainText("2 settings require attention");
  await errors.getByRole("button", { name: /Minimum relevance:/ }).click();
  await page.getByLabel("Minimum relevance", { exact: true }).fill("0.45");
  await section(page, "Overview");
  await page
    .getByLabel("Agent name", { exact: true })
    .fill("Updated product assistant");

  await section(page, "Behavior");
  await expect(page.getByText(/Advanced customization active/)).toBeVisible();
  await page.getByText("Advanced model settings", { exact: true }).click();
  await expect(page.getByLabel("Temperature", { exact: true })).toHaveValue(
    "0.63",
  );
  await expect(
    page.getByLabel("Top-P (optional)", { exact: true }),
  ).toHaveValue("0.87");
  await expect(
    page.getByLabel("Maximum output tokens", { exact: true }),
  ).toHaveValue("1000000");
  await section(page, "Experience");
  await page
    .getByRole("button", { name: "+ Add starter", exact: true })
    .click();
  await page.getByLabel("Starter 3", { exact: true }).fill("Branch directory");
  await page
    .getByRole("button", { name: "Remove starter 1", exact: true })
    .click();
  await section(page, "Overview");
  await expect(page.getByLabel("Agent name", { exact: true })).toHaveValue(
    "Updated product assistant",
  );
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await expect(page.getByLabel("Agent name", { exact: true })).toBeVisible();
  await section(page, "Prompt");
  await section(page, "Knowledge");
  await page.goBack();
  await expect(page.getByLabel("Instructions", { exact: true })).toHaveValue(
    "Explain the approved product steps.",
  );
  await section(page, "Knowledge");
  await page
    .getByLabel("Usage policy", { exact: true })
    .selectOption("automatic");
  await page
    .getByLabel("Usage instructions", { exact: true })
    .fill("Skip greetings; search policies");
  await expect(
    page.getByLabel("Answer source policy", { exact: true }),
  ).toHaveValue("balanced");
  await page
    .getByLabel("Answer source policy", { exact: true })
    .selectOption("prefer_approved_qa");
  await page
    .getByLabel("Approved Q&A minimum relevance", { exact: true })
    .fill("0.85");
  await section(page, "Tools");
  await page
    .getByLabel("Usage policy", { exact: true })
    .selectOption("disabled");
  await page
    .getByLabel("Usage instructions", { exact: true })
    .fill("Use only for current weather");
  await section(page, "Knowledge");
  await expect(page.getByLabel("Usage policy", { exact: true })).toHaveValue(
    "automatic",
  );
  await section(page, "Overview");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByText("Draft saved. Start a new chat to use these changes.", {
      exact: true,
    }),
  ).toBeVisible();
  const saved = (
    await sql`SELECT draft_config,revision,name FROM agents WHERE id=${agent}`
  )[0];
  expect(saved.revision).toBe(2);
  expect(saved.name).toBe("Updated product assistant");
  expect(saved.draft_config).toMatchObject({
    ...config,
    prompt: {
      ...config.prompt,
      instructions: "Explain the approved product steps.",
    },
    rag: {
      ...config.rag,
      minScore: 0.45,
      answerSourcePolicy: "prefer_approved_qa",
      qaMinScore: 0.85,
      rerankerId: null,
      rerankMaxOutputTokens: 1024,
      usageMode: "automatic",
      usageInstructions: "Skip greetings; search policies",
    },
    tools: {
      ...config.tools,
      usageMode: "disabled",
      usageInstructions: "Use only for current weather",
    },
    conversationStarters: ["Card support", "Branch directory"],
  });
  await page.getByLabel("Agent name", { exact: true }).fill("Discard me");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByLabel("Agent name", { exact: true })).toHaveValue(
    "Updated product assistant",
  );
  await expect(
    page.locator(".configure-save-bar").getByText("Saved", { exact: true }),
  ).toBeVisible();
  await section(page, "Prompt");
  await page.getByLabel("Advanced prompt mode", { exact: true }).check();
  await expect(page.getByLabel("System prompt", { exact: true })).toHaveValue(
    "Raw customer guidance",
  );
  await page.getByLabel("Advanced prompt mode", { exact: true }).uncheck();
  await page
    .getByRole("button", { name: "Save and test in Playground", exact: true })
    .click();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  const message = page.getByLabel("Message", { exact: true });
  await expect(
    page.getByText("You can ask for a human specialist in this chat.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await message.fill("hi");
  await message.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    bubbles: true,
  });
  await expect(message).toHaveValue("hi");
  await message.press("Shift+Enter");
  await expect(message).toHaveValue("hi\n");
  await expect(
    page.getByText("Configure fixture answer", { exact: true }),
  ).toHaveCount(0);
  await message.press("Enter");
  await expect(
    page.getByText("Configure fixture answer", { exact: true }),
  ).toBeVisible();
  const debug = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Debug / Advanced" }) })
    .last();
  await expect(debug).not.toHaveAttribute("open");
  await expect(
    page.getByRole("button", { name: "Load run token counts" }),
  ).toBeHidden();
  await page.getByText("Debug / Advanced", { exact: true }).click();
  await page.getByText("Token and context breakdown", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Load run token counts" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "configure", exact: true }).click();
  await section(page, "Knowledge");
  await page.reload();
  await expect(
    page
      .locator(".configure-section-header")
      .getByRole("heading", { name: "Knowledge", exact: true }),
  ).toBeVisible();
  await section(page, "Tools");
  await page.goBack();
  await expect(
    page
      .locator(".configure-section-header")
      .getByRole("heading", { name: "Knowledge", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(
    page.getByLabel("Configure section", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Configure section", { exact: true })
    .selectOption("behavior");
  await expect(
    page.getByLabel("Conversation memory (turns)", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    document.activeElement?.blur();
    const y =
      document
        .querySelector(".configure-section-header")
        .getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, y - 95));
  });
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: "docs/agent-configure/mobile.png",
    fullPage: false,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await section(page, "Overview");
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: "docs/agent-configure/overview.png",
    fullPage: true,
  });
  await page.getByLabel("Agent name", { exact: true }).fill("Conflicting edit");
  await sql`UPDATE agents SET name='Server edit',revision=revision+1 WHERE id=${agent}`;
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByText(/This agent was updated elsewhere/),
  ).toBeVisible();
  await expect(page.getByLabel("Agent name", { exact: true })).toHaveValue(
    "Conflicting edit",
  );
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Reload latest draft", exact: true })
    .click();
  await expect(page.getByLabel("Agent name", { exact: true })).toHaveValue(
    "Server edit",
  );
  await sql`UPDATE knowledge_sources SET status='failed' WHERE id=${source}`;
  await sql`UPDATE tools SET enabled=false WHERE id=${tool}`;
  await page.reload();
  await expect(
    page.getByText("Needs configuration", { exact: true }),
  ).toBeVisible();
  await section(page, "Tools");
  await expect(
    page.getByText("Disabled · http", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Read-only lookup · Workspace only", { exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Publish saved draft", exact: true }),
  ).toBeDisabled();
  const readContext = await browser.newContext({
    baseURL: "http://localhost:3000",
  });
  await auth(readContext, "analyst");
  const read = await readContext.newPage();
  await read.goto(url("prompt"));
  await expect(read.getByLabel("Instructions", { exact: true })).toBeDisabled();
  await expect(
    read.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await readContext.close();
});

test("Approved rerankers are managed in Models and selected inside agent retrieval settings", async ({
  page,
  context,
}) => {
  await auth(context);
  await page.goto(`/#view=Models&organization=${org}&workspace=${workspace}`);
  await page
    .getByRole("button", { name: "Register reranker", exact: true })
    .click();
  await page
    .getByLabel("Reranker name", { exact: true })
    .fill("Dedicated ranking model");
  await page.getByLabel("Reranking model", { exact: true }).selectOption(model);
  await page
    .getByRole("button", { name: "Save reranker", exact: true })
    .click();
  await expect(
    page.getByText("Dedicated ranking model", { exact: true }),
  ).toBeVisible();
  const created = (
    await sql`SELECT id FROM rerankers WHERE workspace_id=${workspace} AND name='Dedicated ranking model'`
  )[0];
  expect(created).toBeTruthy();
  const secret = await context.request.post(
    `http://localhost:4000/workspaces/${workspace}/secrets`,
    {
      headers: { origin: "http://localhost:3000" },
      data: { name: "COHERE_BROWSER", value: "fixture-not-a-live-key" },
    },
  );
  expect(secret.ok()).toBeTruthy();
  await page.reload();
  await page
    .getByRole("button", { name: "Register reranker", exact: true })
    .click();
  await page
    .getByLabel("Reranker name", { exact: true })
    .fill("Cohere ranking");
  await page
    .getByLabel("Reranker provider", { exact: true })
    .selectOption("cohere");
  await page
    .getByLabel("Reranker workspace credential", { exact: true })
    .selectOption({ label: "COHERE_BROWSER" });
  await page
    .getByRole("button", { name: "Save reranker", exact: true })
    .click();
  await expect(page.getByText("Cohere ranking", { exact: true })).toBeVisible();
  const native = (
    await sql`SELECT id FROM rerankers WHERE workspace_id=${workspace} AND name='Cohere ranking'`
  )[0];
  await page.goto(url("knowledge"));
  await page.getByText("Advanced retrieval settings", { exact: true }).click();
  await page.getByLabel("Rerank retrieved passages", { exact: true }).check();
  await page
    .getByLabel("Reranking model", { exact: true })
    .selectOption(created.id);
  await expect(
    page.getByLabel("Reranking output budget", { exact: true }),
  ).toHaveValue("1024");
  await page
    .getByLabel("Reranking model", { exact: true })
    .selectOption(native.id);
  await expect(
    page.getByLabel("Reranking output budget", { exact: true }),
  ).toHaveCount(0);
  await section(page, "Advanced");
  await expect(page.getByLabel("Reranking model", { exact: true })).toHaveCount(
    0,
  );
  const metadata = page
    .locator("summary")
    .filter({ hasText: /^Draft metadata$/ });
  await expect(metadata).toBeVisible();
  await expect(page.locator(".configure-metadata")).toBeHidden();
  await metadata.click();
  await expect(page.locator(".configure-metadata")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Discard", exact: true }).click();
});

test("Response language saves, appears in compiled prompts, and is snapshotted for new Playground chats", async ({
  page,
  context,
}) => {
  page.setDefaultTimeout(15000);
  await waitForApiBudget(280);
  await auth(context);
  await sql`UPDATE agents SET draft_config=jsonb_set(jsonb_set(draft_config,'{tools,usageMode}','"disabled"',true),'{rag,usageMode}','"automatic"',true) WHERE id=${agent}`;
  await sql`UPDATE knowledge_sources SET status='ready' WHERE id=${source}`;
  await sql`UPDATE tools SET enabled=true WHERE id=${tool}`;
  await page.goto(url("overview"));
  await expect(
    page.getByLabel("Response language", { exact: true }),
  ).toHaveValue("fixed");
  await page
    .getByLabel("Response language", { exact: true })
    .selectOption("auto");
  await expect(
    page.getByLabel("Fallback language", { exact: true }),
  ).toHaveValue("English");
  await section(page, "Prompt");
  await page.getByText("Preview compiled prompt", { exact: true }).click();
  await expect(page.locator(".configure-prompt-preview")).toContainText(
    "language of the latest user message",
  );
  await page
    .getByRole("button", { name: "Save and test in Playground", exact: true })
    .click();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  const message = page.getByLabel("Message", { exact: true });
  await message.fill("Hola");
  await message.press("Enter");
  await expect(
    page.getByText("Hola, ¿en qué puedo ayudarte?", { exact: true }),
  ).toBeVisible();
  expect(answerRequests.at(-1).system).toContain("Response language policy:");
  await message.fill("Bonjour");
  await message.press("Enter");
  await expect(
    page.getByText("Bonjour, comment puis-je vous aider ?", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "configure", exact: true }).click();
  await section(page, "Overview");
  await page
    .getByLabel("Response language", { exact: true })
    .selectOption("fixed");
  await page.getByLabel("Language", { exact: true }).fill("French");
  await page
    .getByRole("button", { name: "Save and test in Playground", exact: true })
    .click();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await message.fill("Hello");
  await message.press("Enter");
  await expect(
    page.getByText("Bonjour, comment puis-je vous aider ?", { exact: true }),
  ).toBeVisible();
  expect(answerRequests.at(-1).system).toContain("Respond in French.");
  expect(answerRequests.at(-1).system).not.toContain(
    "Response language policy:",
  );
  const saved = (
    await sql`SELECT draft_config FROM agents WHERE id=${agent}`
  )[0];
  expect(saved.draft_config.languageMode).toBe("fixed");
  expect(saved.draft_config.language).toBe("French");
  await page.reload();
  await page.getByRole("button", { name: "configure", exact: true }).click();
  await section(page, "Overview");
  await expect(
    page.getByLabel("Response language", { exact: true }),
  ).toHaveValue("fixed");
  await expect(page.getByLabel("Language", { exact: true })).toHaveValue(
    "French",
  );
});
