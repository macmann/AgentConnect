import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const org = randomUUID(),
  workspace = randomUUID(),
  user = randomUUID(),
  session = randomUUID();
let grounded = false,
  plans = 0;
const fixture = createServer(async (req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        city: new URL(req.url, "http://localhost").searchParams.get("city"),
        forecast: "sunny",
      }),
    );
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const data = JSON.parse(raw);
  let text;
  const system = data.messages[0].content;
  if (system.startsWith("Choose useful read-only tools")) {
    plans++;
    const tools = JSON.parse(system.slice(system.lastIndexOf("\n") + 1));
    text = JSON.stringify({
      calls: [{ toolId: tools[0].toolId, arguments: { city: "Yangon" } }],
    });
  } else {
    grounded = system.includes("<tool_results>") && system.includes("sunny");
    text = "The weather in Yangon is sunny.";
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    "data: " +
      JSON.stringify({
        choices: [{ delta: { content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 5 },
      }) +
      "\n\ndata: [DONE]\n\n",
  );
});
test.beforeAll(async () => {
  // Browser scenarios share an IP and the real API limiter. Preserve the policy
  // and start this integration flow with room for its normal UI requests.
  const health = await fetch("http://localhost:4000/auth/me", {
    signal: AbortSignal.timeout(5000),
  });
  const remaining = Number(
    health.headers.get("x-ratelimit-remaining") ?? "300",
  );
  if (health.status === 429 || remaining < 150) {
    const reset = Number(
      health.headers.get("retry-after") ??
        health.headers.get("x-ratelimit-reset") ??
        "1",
    );
    console.log(
      "Pacing tooling browser scenario for the API rate-limit window",
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(59000, Math.max(1000, reset * 1000 + 500))),
    );
  }

  await new Promise((r) => fixture.listen(4547, "127.0.0.1", r));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${user},${user + "@example.com"},'Tools Builder','unused-fixture',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(session).digest("hex")},${user},now()+interval '1 hour')`;
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Browser tools')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Tools workspace')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${user},'owner')`;
  });
});
test.afterAll(async () => {
  fixture.closeAllConnections();
  await new Promise((r) => fixture.close(r));
  await sql.begin(async (tx) => {
    for (const t of [
      "tool_executions",
      "messages",
      "agent_runs",
      "conversations",
      "deployments",
      "agent_versions",
      "agents",
      "tools",
      "mcp_connectors",
      "model_configurations",
      "secrets",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(t)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    await tx`DELETE FROM users WHERE id=${user}`;
  });
  await sql.end();
});
test("register, test, attach and trace a read-only tool in playground and hosted chat", async ({
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
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Weather lookup");
  await page
    .getByLabel("Description for the agent")
    .fill("Read the weather for a city.");
  await page
    .getByLabel("Fixed endpoint URL")
    .fill("http://127.0.0.1:4547/weather");
  await page
    .getByLabel("Allowed query parameters (comma separated)")
    .fill("city");
  await page.getByRole("checkbox", { name: /Allow anonymous hosted/ }).check();
  await page.getByRole("checkbox", { name: /I verified/ }).check();
  await page
    .getByRole("button", { name: "Register tool", exact: true })
    .click();
  await expect(
    page.getByText("Tool registered. Attach it in an agent's configuration."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await page.getByLabel("Tool test arguments").fill('{"city":"Yangon"}');
  await page.getByRole("button", { name: "Execute read-only test" }).click();
  await expect(
    page
      .locator(".tool-traces")
      .first()
      .getByText(/Weather lookup · completed/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page
    .getByRole("button", { name: "Register model", exact: true })
    .click();
  await page.getByLabel("Display name").fill("Tool chat fixture");
  await page.getByLabel(/^Provider/).selectOption("openai-compatible");
  await page.getByLabel("Model identifier").fill("fixture");
  await page.getByLabel(/^Base URL/).fill("http://127.0.0.1:4547/v1");
  await page.getByRole("button", { name: "Save model", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "Tool chat fixture", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await page.getByLabel("Agent name").fill("Weather assistant");
  await page
    .getByRole("navigation", { name: "Configure sections" })
    .getByRole("button", { name: "Tools", exact: true })
    .click();
  await page
    .getByRole("checkbox", {
      name: "Weather lookup · Public chat enabled",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByText("Draft saved. Start a new chat to use these changes."),
  ).toBeVisible();
  await page.getByRole("button", { name: "playground", exact: true }).click();
  await page
    .getByLabel("Message", { exact: true })
    .fill("What is the weather in Yangon?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByText("The weather in Yangon is sunny.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Weather lookup · completed/)).toBeVisible();
  expect(grounded).toBe(true);
  expect(plans).toBe(1);
  await page.getByText(/Weather lookup · completed/).click();
  await expect(page.locator(".tool-traces pre")).toContainText("sunny");
  await page.screenshot({
    path: "test-results/tool-playground-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await page.getByRole("button", { name: "Publish saved draft" }).click();
  await expect(page.getByText("Version 1 published")).toBeVisible();
  await page.getByRole("button", { name: "Create hosted deployment" }).click();
  const href = await page
    .getByRole("link", { name: "Open hosted chat" })
    .getAttribute("href");
  const guest = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    const chat = await guest.newPage();
    await chat.goto("http://localhost:3000" + href);
    await chat
      .getByLabel("Message", { exact: true })
      .fill("Weather in Yangon?");
    await chat.getByRole("button", { name: "Send message" }).click();
    await expect(
      chat.getByText("The weather in Yangon is sunny.", { exact: true }),
    ).toBeVisible();
    await expect(chat.getByText(/Weather lookup · completed/)).toBeVisible();
    expect(
      await chat.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await chat.screenshot({
      path: "test-results/tool-hosted-mobile.png",
      fullPage: true,
    });
  } finally {
    await guest.close();
  }
  await page
    .getByRole("button", { name: "Conversations", exact: true })
    .click();
  await page.locator(".conversation-row").first().click();
  await expect(page.getByText(/Weather lookup · completed/)).toBeVisible();
  const [count] =
    await sql`SELECT count(*) AS n FROM tool_executions WHERE workspace_id=${workspace} AND status='completed'`;
  expect(Number(count.n)).toBe(3);
});
