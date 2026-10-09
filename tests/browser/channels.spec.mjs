import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
// Explicit protocol fixtures; requires temporary MODEL_PRIVATE_HOSTS=127.0.0.1:4551.
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const org = randomUUID(),
  workspace = randomUUID(),
  user = randomUUID(),
  session = randomUUID();
let deployment, agent;
const provider = createServer(async (req, res) => {
  for await (const chunk of req) {
    void chunk;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    "data: " +
      JSON.stringify({
        choices: [
          {
            delta: { content: "Website fixture answer" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      }) +
      "\n\n",
  );
  res.end("data: [DONE]\n\n");
});
const website = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    '<!doctype html><html><head><title>Customer website</title></head><body><h1>Customer website</h1><script async src="http://localhost:4000/widget.js" data-deployment="' +
      deployment +
      '"></script></body></html>',
  );
});
test.beforeAll(async () => {
  await Promise.all([
    new Promise((r) => provider.listen(4551, "127.0.0.1", r)),
    new Promise((r) => website.listen(4500, "127.0.0.1", r)),
  ]);
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${user},${user + "@example.com"},'Channel Builder','unused',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(session).digest("hex")},${user},now()+interval '1 hour')`;
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Channels browser')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Channel workspace')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${user},'owner')`;
  });
});
test.afterAll(async () => {
  for (const s of [provider, website]) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
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
    await tx`DELETE FROM users WHERE id=${user}`;
  });
  await sql.end();
});
test("Configure website widget, stream, hand off to operator, resolve and test browser voice", async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(90000);
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
  const headers = { origin: "http://localhost:3000" };
  async function post(path, data) {
    const r = await context.request.post("http://localhost:4000" + path, {
      headers,
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  }
  const model = await post(`/workspaces/${workspace}/models`, {
    name: "Channel fixture",
    provider: "openai-compatible",
    modelId: "fixture",
    baseUrl: "http://127.0.0.1:4551/v1",
  });
  agent = await post(`/workspaces/${workspace}/agents`, {
    name: "Website assistant",
    config: { modelId: model.id },
  });
  const version = await post(`/agents/${agent.id}/publish`, { revision: 1 });
  const deployed = await post(`/agents/${agent.id}/deployments`, {
    name: "Website support",
    versionId: version.id,
  });
  deployment = deployed.id;
  await page.goto("/");
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page
    .getByText("Website support · Website assistant", { exact: true })
    .click();
  await page.getByLabel("Enable website widget", { exact: true }).check();
  await page
    .getByLabel(/^Allowed website origins/)
    .fill("http://localhost:4500");
  await page
    .getByRole("button", { name: "Save widget settings", exact: true })
    .click();
  await expect(page.getByText("Widget settings saved.")).toBeVisible();
  await expect(page.getByLabel("Website embed code")).toHaveValue(
    new RegExp(deployment),
  );
  const guest = await browser.newContext();
  try {
    const web = await guest.newPage();
    const errors = [];
    web.on("pageerror", (e) => errors.push(e.message));
    await web.goto("http://localhost:4500");
    await web.getByRole("button", { name: "Chat", exact: true }).click();
    await web.getByLabel("Message", { exact: true }).fill("Hello website");
    await web.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      web.getByText("Website fixture answer", { exact: true }),
    ).toBeVisible();
    await web
      .getByRole("button", { name: "Request human support", exact: true })
      .click();
    await expect(
      web.getByText("Waiting for human support. You can leave a message."),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Website assistant · widget · pending" })
      .click();
    await page
      .getByRole("button", { name: "Join support conversation" })
      .click();
    await page
      .getByLabel("Operator reply", { exact: true })
      .fill("A human operator can help.");
    const replyRequest = page.waitForResponse(
      (r) => r.url().endsWith("/handoff") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Send operator reply" }).click();
    const replyResponse = await replyRequest;
    expect(replyResponse.status(), await replyResponse.text()).toBe(201);
    await page.screenshot({
      path: "test-results/channel-operator.png",
      fullPage: true,
    });
    await expect(
      web.getByText("A human operator can help.", { exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await web.getByLabel("Message", { exact: true }).fill("Thank you support");
    await web.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("user message: Thank you support")).toBeVisible(
      { timeout: 15000 },
    );
    await page
      .getByRole("button", { name: "Resolve and return to agent" })
      .click();
    await expect(
      web.getByText("Support resolved. You can talk to the agent again."),
    ).toBeVisible({ timeout: 15000 });
    await web.getByLabel("Message", { exact: true }).fill("Ask agent again");
    await web.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      web.getByText("Website fixture answer", { exact: true }),
    ).toHaveCount(2);
    await web.setViewportSize({ width: 390, height: 844 });
    expect(
      await web.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await web.screenshot({
      path: "test-results/channel-widget-mobile.png",
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await guest.close();
  }
  // Deterministic browser API fixture: does not test microphone or speech service.
  await page.addInitScript(() => {
    class Recognition {
      start() {
        this.onresult?.({
          results: [[{ transcript: "Editable dictated question" }]],
        });
        this.onend?.();
      }
      abort() {
        this.onend?.();
      }
    }
    window.SpeechRecognition = Recognition;
  });
  await page.goto("/chat/" + deployment);
  await page.getByLabel("Enable browser voice", { exact: true }).check();
  await page.getByRole("button", { name: "Dictate message" }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
    "Editable dictated question",
  );
  await page.getByLabel("Message", { exact: true }).fill("Edited before send");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByText("Website fixture answer", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Read latest response" }),
  ).toBeEnabled();
  await page.evaluate(() => {
    window.__played = "";
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speak: (utterance) => {
          window.__played = utterance.text;
          queueMicrotask(() => utterance.onend?.());
        },
        cancel: () => {},
      },
    });
    class DeniedRecognition {
      start() {
        queueMicrotask(() => this.onerror?.({ error: "not-allowed" }));
      }
      abort() {
        this.onend?.();
      }
    }
    window.SpeechRecognition = DeniedRecognition;
  });
  await page.getByRole("button", { name: "Read latest response" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__played))
    .toBe("Website fixture answer");
  await page.getByRole("button", { name: "Dictate message" }).click();
  await expect(
    page.getByText(
      "Microphone permission was denied. You can type your message.",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Message", { exact: true })).toBeEnabled();
});
