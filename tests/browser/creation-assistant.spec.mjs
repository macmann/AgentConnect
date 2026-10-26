import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
import { agentConfig } from "../../packages/schemas/src/agents.ts";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production mode");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const org = randomUUID(),
  workspace = randomUUID(),
  user = randomUUID(),
  session = randomUUID(),
  model = randomUUID(),
  agent = randomUUID(),
  version = randomUUID();
let calls = 0;
const provider = createServer(async (req, res) => {
  let body = "";
  for await (const part of req) body += part;
  const input = JSON.parse(body);
  calls++;
  const workflow = input.messages[0].content.includes(
    "for nontechnical builders. Help create a workflow",
  );
  const guided = input.messages[0].content.includes("Mode: guided");
  const answers = input.messages.filter((m) => m.role === "user").length;
  const response = workflow
    ? {
        message: "Review this research and review chain.",
        workflow: {
          name: "Customer answer chain",
          description: "Research then verify",
          steps: [
            {
              agentVersionId: version,
              label: "Research",
              instructions: "Find an accurate answer",
            },
            {
              agentVersionId: version,
              label: "Verify",
              instructions: "Check the previous result",
            },
          ],
        },
      }
    : guided && answers === 1
      ? {
          message: "Who will use this agent?",
          suggestions: ["Customers", "Employees"],
        }
      : {
          message: "Your draft is ready to review.",
          agent: {
            name: "Customer helper",
            description: "Helps with product questions",
            publicDescription: "Product support",
            modelId: model,
            prompt: {
              role: "You help customers understand products",
              objective: "Explain clearly",
              instructions: "Use approved information. Ask if unsure.",
              constraints: "Do not invent details",
            },
            knowledgeBaseIds: [],
            toolIds: [],
            welcomeMessage: "How can I help?",
            conversationStarters: ["Explain the service"],
          },
        };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(response) }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 25 } })}\n\ndata: [DONE]\n\n`,
  );
});
const url = (view, extra = "") =>
  `/#view=${view}&organization=${org}&workspace=${workspace}${extra}`;
test.beforeAll(async () => {
  await new Promise((resolve) => provider.listen(4566, "127.0.0.1", resolve));
  const config = agentConfig.parse({
    modelId: model,
    prompt: { role: "Research assistant" },
  });
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES(${user},${user + "@example.com"},'Builder','unused',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(${createHash("sha256").update(session).digest("hex")},${user},now()+interval '1 hour')`;
    await tx`INSERT INTO organizations(id,name) VALUES(${org},'Creation browser fixture')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES(${workspace},${org},'Creation workspace')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES(${randomUUID()},${org},${user},'owner')`;
    await tx`INSERT INTO model_configurations(id,workspace_id,organization_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES(${model},${workspace},${org},'Builder model','openai-compatible','fixture','http://127.0.0.1:4566/v1',32768,8192,${tx.json({ streaming: true, temperature: true, topP: true })})`;
    await tx`INSERT INTO agents(id,workspace_id,organization_id,name,description,public_description,draft_config,created_by) VALUES(${agent},${workspace},${org},'Research assistant','','',${tx.json(config)},${user})`;
    await tx`INSERT INTO agent_versions(id,agent_id,workspace_id,organization_id,version,name,public_description,config,model_snapshot,model_id,published_by) VALUES(${version},${agent},${workspace},${org},1,'Research assistant','',${tx.json(config)},${tx.json({})},${model},${user})`;
  });
});
test.afterAll(async () => {
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  try {
    await sql.begin(async (tx) => {
      for (const table of [
        "workflows",
        "agent_versions",
        "agents",
        "workspace_creation_settings",
        "model_configurations",
        "audit_events",
        "memberships",
        "workspaces",
      ])
        await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
      await tx`DELETE FROM organizations WHERE id=${org}`;
      await tx`DELETE FROM users WHERE id=${user}`;
    });
  } finally {
    await sql.end();
  }
});
test("Settings, guided and assisted agent creation, workflow proposals and manual fallback work on desktop and mobile", async ({
  page,
  context,
}) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  await context.addCookies([
    {
      name: "session",
      value: session,
      url: "http://localhost:3000",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto(url("Agents"));
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(page.getByRole("button", { name: /AI guide/ })).toBeDisabled();
  await page
    .getByRole("button", { name: "Open Settings", exact: true })
    .click();
  await page.getByLabel("Assistant model", { exact: true }).selectOption(model);
  await page.getByLabel("Enable AI-guided creation", { exact: false }).check();
  await page
    .getByRole("button", { name: "Save assistant settings", exact: true })
    .click();
  await expect(
    page.getByText("Ready · Builder model", { exact: true }),
  ).toBeVisible();
  await page.goto(url("Agents"));
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await page.getByRole("button", { name: /AI guide/ }).click();
  await page
    .getByLabel("Message to creation assistant", { exact: true })
    .fill("Create a product support agent");
  await page
    .getByLabel("Message to creation assistant", { exact: true })
    .press("Enter");
  await expect(
    page.getByText("Who will use this agent?", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Customers", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Customer helper",
  );
  await page
    .getByLabel("Name", { exact: true })
    .fill("Reviewed customer helper");
  await page.screenshot({
    path: test.info().outputPath("guided-agent-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Switch to dark theme", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: test.info().outputPath("guided-agent-dark.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Switch to light theme", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: test.info().outputPath("guided-agent-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .getByRole("button", { name: "Use draft in Configure", exact: true })
    .click();
  await expect(page.getByLabel("Agent name", { exact: true })).toHaveValue(
    "Reviewed customer helper",
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Draft saved. Start a new chat to use these changes.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.goto(url("Workflows"));
  await page
    .getByRole("button", { name: "Create workflow", exact: true })
    .click();
  await page.getByRole("button", { name: /AI-assisted draft/ }).click();
  await page
    .getByLabel("Message to creation assistant", { exact: true })
    .fill("Use the research assistant to research an answer, then verify it");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Customer answer chain",
  );
  await expect(page.getByLabel("Draft review")).toContainText(
    "Research assistant",
  );
  await page.screenshot({
    path: test.info().outputPath("assisted-workflow.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Create workflow draft", exact: true })
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await expect(
    page.getByText("Workflow draft saved. Test it before publishing.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create workflow", exact: true })
    .click();
  await page.getByRole("button", { name: /Manual setup/ }).click();
  await expect(
    page
      .locator(".workflow-wizard")
      .getByLabel("Workflow name", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel setup", exact: true }).click();
  await page.goto(url("Agents"));
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await page.getByRole("button", { name: /AI-assisted draft/ }).click();
  await page
    .getByLabel("Message to creation assistant", { exact: true })
    .fill("A friendly product assistant for employees");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Customer helper",
  );
  await page.getByRole("button", { name: "Cancel setup", exact: true }).click();
  const previous = calls;
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await page.getByRole("button", { name: /Manual setup/ }).click();
  await expect(page.getByLabel("Agent name", { exact: true })).toHaveValue("");
  expect(calls).toBe(previous);
});
