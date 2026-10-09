import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";

// Explicit local protocol fixture. This does not validate a live model provider.
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production mode");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const org = randomUUID(),
  workspace = randomUUID(),
  user = randomUUID(),
  session = randomUUID();
let requests = 0;
const provider = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const data = JSON.parse(body);
  if (req.url !== "/v1/chat/completions" || !data.stream) {
    res.writeHead(400).end();
    return;
  }
  requests++;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    "data: " +
      JSON.stringify({
        choices: [{ delta: { content: "Browser fixture " } }],
      }) +
      "\n\n",
  );
  const timer = setTimeout(
    () => {
      res.write(
        "data: " +
          JSON.stringify({
            choices: [
              { delta: { content: "response" }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 4 },
          }) +
          "\n\n",
      );
      res.end("data: [DONE]\n\n");
    },
    data.messages.at(-1)?.content === "Slow response" ? 5000 : 250,
  );
  res.on("close", () => clearTimeout(timer));
});
test.beforeAll(async () => {
  await new Promise((resolve) => provider.listen(4545, "127.0.0.1", resolve));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${user},${user + "@example.com"},'Agent Builder','unused-browser-fixture',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(session).digest("hex")},${user},now()+interval '1 hour')`;
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Browser agents')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Agent workspace')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${user},'owner')`;
  });
});
test.afterAll(async () => {
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  await sql.begin(async (tx) => {
    for (const table of [
      "messages",
      "agent_runs",
      "conversations",
      "deployments",
      "agent_versions",
      "agents",
      "model_configurations",
      "secrets",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    await tx`DELETE FROM users WHERE id=${user}`;
  });
  await sql.end();
});
test("model registration, agent editor, streaming playground, publish and anonymous hosted chat", async ({
  page,
  context,
  browser,
}) => {
  await context.addCookies([
    {
      name: "session",
      value: session,
      url: "http://localhost:3000",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Create agent", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "To enable Create agent, register a model in Models for this workspace.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page
    .getByRole("button", { name: "Register model", exact: true })
    .click();
  await page.getByLabel("Display name").fill("Explicit browser fixture");
  await page.getByLabel(/^Provider/).selectOption("openai-compatible");
  await page.getByLabel("Model identifier").fill("fixture-only");
  await page.getByLabel(/^Base URL/).fill("http://127.0.0.1:4545/v1");
  await page.getByRole("button", { name: "Save model", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "Explicit browser fixture", exact: true }),
  ).toBeVisible();
  const modelRow = page
    .getByRole("row")
    .filter({
      has: page.getByRole("cell", {
        name: "Explicit browser fixture",
        exact: true,
      }),
    });
  await modelRow.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel("Model identifier")).toHaveValue("fixture-only");
  await expect(page.getByLabel(/^Base URL/)).toHaveValue(
    "http://127.0.0.1:4545/v1",
  );
  await page.getByLabel("Display name").fill("Edited browser fixture");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "Edited browser fixture", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Register model", exact: true })
    .click();
  await page.getByLabel("Display name").fill("Disposable browser fixture");
  await page.getByLabel(/^Provider/).selectOption("openai-compatible");
  await page.getByLabel("Model identifier").fill("fixture-disposable");
  await page.getByLabel(/^Base URL/).fill("http://127.0.0.1:4545/v1");
  await page.getByRole("button", { name: "Save model", exact: true }).click();
  const disposable = page
    .getByRole("row")
    .filter({
      has: page.getByRole("cell", {
        name: "Disposable browser fixture",
        exact: true,
      }),
    });
  await disposable.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete model", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "Disposable browser fixture", exact: true }),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await page.getByLabel("Agent name").fill("Browser assistant");
  await page
    .getByLabel("Instructions", { exact: true })
    .fill("Answer with concise guidance.");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByText("Draft saved. Start a new chat to use these changes."),
  ).toBeVisible();
  await page.getByRole("button", { name: "playground", exact: true }).click();
  await page.getByLabel("Message", { exact: true }).fill("Hello fixture");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByText("Browser fixture response", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Slow response");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByRole("button", { name: "Cancel response" }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      Number(
        (
          await sql`SELECT count(*) AS n FROM agent_runs WHERE workspace_id=${workspace} AND status='running'`
        )[0].n,
      ),
    )
    .toBe(1);
  const [active] =
    await sql`SELECT conversation_id FROM agent_runs WHERE workspace_id=${workspace} AND status='running'`;
  const [agent] =
    await sql`SELECT id FROM agents WHERE workspace_id=${workspace}`;
  const overlapping = await page.evaluate(
    async ({ agent, conversation }) => {
      const r = await fetch("http://localhost:4000/agents/" + agent + "/chat", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "Overlapping",
          conversationId: conversation,
        }),
      });
      return r.status;
    },
    { agent: agent.id, conversation: active.conversation_id },
  );
  expect(overlapping).toBe(409);
  await page.getByRole("button", { name: "Cancel response" }).click();
  await expect(page.getByText("Response cancelled.")).toBeVisible();
  await expect
    .poll(async () =>
      Number(
        (
          await sql`SELECT count(*) AS n FROM agent_runs WHERE workspace_id=${workspace} AND status='cancelled'`
        )[0].n,
      ),
    )
    .toBe(1);
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await page.getByRole("button", { name: "Publish saved draft" }).click();
  await expect(page.getByText("Version 1 published")).toBeVisible();
  await page.getByRole("button", { name: "Create hosted deployment" }).click();
  const hosted = await page
    .getByRole("link", { name: "Open hosted chat" })
    .getAttribute("href");
  const guest = await browser.newContext();
  try {
    const chat = await guest.newPage();
    await chat.goto("http://localhost:3000" + hosted);
    await chat
      .getByLabel("Message", { exact: true })
      .fill("Anonymous question");
    await chat.getByRole("button", { name: "Send message" }).click();
    await expect(
      chat.getByText("Browser fixture response", { exact: true }),
    ).toBeVisible();
    await expect(
      chat.getByRole("button", { name: "Send message" }),
    ).toBeVisible();
    await chat
      .getByLabel("Message", { exact: true })
      .fill("Continue anonymously");
    await chat.getByRole("button", { name: "Send message" }).click();
    await expect(
      chat.getByText("Browser fixture response", { exact: true }),
    ).toHaveCount(2);
    await expect(
      chat.getByRole("button", { name: "Send message" }),
    ).toBeVisible();
    await chat.setViewportSize({ width: 390, height: 844 });
    expect(
      await chat.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await chat.screenshot({
      path: "test-results/hosted-chat-mobile.png",
      fullPage: true,
    });
  } finally {
    await guest.close();
  }
  await page
    .getByRole("button", { name: "Conversations", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Browser assistant/ }),
  ).toHaveCount(2);
  expect(requests).toBe(4);
  const runs =
    await sql`SELECT status FROM agent_runs WHERE workspace_id=${workspace}`;
  expect(runs).toHaveLength(4);
  expect(runs.filter((r) => r.status === "completed")).toHaveLength(3);
  expect(runs.filter((r) => r.status === "cancelled")).toHaveLength(1);
});
