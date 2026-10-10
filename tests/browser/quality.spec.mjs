import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
// Explicit local protocol fixture; temporarily grant MODEL_PRIVATE_HOSTS=127.0.0.1:4552 to API and worker.
const sql = postgres(process.env.DATABASE_URL, { max: 1 }),
  org = randomUUID(),
  workspace = randomUUID(),
  user = randomUUID(),
  session = randomUUID();
const fixture = createServer(async (req, res) => {
  for await (const chunk of req) void chunk;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    "data: " +
      JSON.stringify({
        choices: [
          { delta: { content: "Hello quality" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }) +
      "\n\ndata: [DONE]\n\n",
  );
});
test.beforeAll(async () => {
  await new Promise((r) => fixture.listen(4552, "127.0.0.1", r));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${user},${user + "@example.com"},'Quality Builder','unused',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(session).digest("hex")},${user},now()+interval '1 hour')`;
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Quality browser')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Quality workspace')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${user},'owner')`;
  });
});
test.afterAll(async () => {
  fixture.closeAllConnections();
  await new Promise((r) => fixture.close(r));
  await sql.begin(async (tx) => {
    for (const table of [
      "evaluation_results",
      "evaluation_runs",
      "agent_quality_gates",
      "evaluation_datasets",
      "conversation_reviews",
      "messages",
      "agent_runs",
      "conversations",
      "agent_versions",
      "agents",
      "model_configurations",
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
test("Quality lab creates datasets, imports conversations, evaluates, gates publication and compares regressions", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.addCookies([
    {
      name: "session",
      value: session,
      url: "http://localhost:3000",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const headers = { origin: "http://localhost:3000" },
    base = `http://localhost:4000/workspaces/${workspace}`;
  async function post(url, data) {
    const r = await context.request.post(url, { headers, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  }
  const model = await post(base + "/models", {
      name: "Quality fixture",
      provider: "openai-compatible",
      modelId: "fixture",
      baseUrl: "http://127.0.0.1:4552/v1",
    }),
    agent = await post(base + "/agents", {
      name: "Quality assistant",
      config: { modelId: model.id },
    });
  await page.goto("/");
  await page.getByRole("button", { name: "Quality", exact: true }).click();
  await expect(
    page.getByText("No datasets yet.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New dataset", exact: true }).click();
  await page
    .getByLabel("Dataset name", { exact: true })
    .fill("Greeting checks");
  await page.getByLabel("Examples (JSON array)", { exact: true }).fill(
    JSON.stringify(
      [
        {
          input: "Hi",
          expectedBehavior: "Greet",
          contains: ["Hello"],
          tags: ["greeting"],
        },
      ],
      null,
      2,
    ),
  );
  await page.getByRole("button", { name: "Save dataset", exact: true }).click();
  await expect(page.getByText("Dataset saved.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Evaluation", exact: true }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption(agent.id);
  const chat = await context.request.post(
    `http://localhost:4000/agents/${agent.id}/chat`,
    { headers, data: { message: "Hello imported" } },
  );
  expect(await chat.text()).toContain("Hello quality");
  const [message] =
    await sql`SELECT id FROM messages WHERE workspace_id=${workspace} AND role='assistant' ORDER BY created_at DESC LIMIT 1`;
  await page.getByRole("button", { name: "Datasets", exact: true }).click();
  await page
    .getByText("Import conversation responses", { exact: true })
    .click();
  await page
    .getByLabel("Assistant message IDs (comma separated)", { exact: true })
    .fill(message.id);
  await page
    .getByRole("button", { name: "Import messages", exact: true })
    .click();
  await expect(
    page.getByText("Conversation examples imported.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Publication gates", exact: true })
    .click();
  await page.getByRole("button", { name: "Enable gate", exact: true }).click();
  await expect(
    page.getByText(
      "Publication gate saved for the selected dataset and evaluator.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(
    (
      await context.request.post(
        `http://localhost:4000/agents/${agent.id}/publish`,
        { headers, data: { revision: 1 } },
      )
    ).status(),
  ).toBe(409);
  await page.getByRole("button", { name: "Evaluation", exact: true }).click();
  await page
    .getByRole("button", { name: "Run evaluation", exact: true })
    .click();
  await expect(page.getByText(/Pass rate: 100%/)).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByText("Hello quality", { exact: true })).toHaveCount(2);
  await post(`http://localhost:4000/agents/${agent.id}/publish`, {
    revision: 1,
  });
  const runs = await (await context.request.get(base + "/evaluations")).json();
  await page.getByRole("button", { name: "Evaluation", exact: true }).click();
  await page
    .getByLabel("Regression baseline (optional)", { exact: true })
    .selectOption(runs[0].id);
  await page.getByRole("button", { name: "Evaluation", exact: true }).click();
  await page
    .getByRole("button", { name: "Run evaluation", exact: true })
    .click();
  await expect(
    page.getByText(/Pass rate change: 0.0 percentage points/),
  ).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "Datasets", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit examples", exact: true })
    .click();
  await page.getByLabel("Examples (JSON array)", { exact: true }).fill(
    JSON.stringify(
      [
        {
          input: "Hi",
          expectedBehavior: "Say goodbye",
          contains: ["Goodbye"],
          tags: ["coverage-gap"],
        },
      ],
      null,
      2,
    ),
  );
  await page.getByRole("button", { name: "Save dataset", exact: true }).click();
  await expect(page.getByText("Dataset saved.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Evaluation", exact: true }).click();
  await page
    .getByLabel("Regression baseline (optional)", { exact: true })
    .selectOption("");
  expect(
    (
      await context.request.post(
        `http://localhost:4000/agents/${agent.id}/publish`,
        { headers, data: { revision: 1 } },
      )
    ).status(),
  ).toBe(409);
  await page.getByRole("button", { name: "Evaluation", exact: true }).click();
  await page
    .getByRole("button", { name: "Run evaluation", exact: true })
    .click();
  await expect(page.getByText(/Pass rate: 0%/)).toBeVisible({ timeout: 30000 });
  await expect(
    page.getByText("Tags: coverage-gap", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
