import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
test.use({ actionTimeout: 15000 });
const sql = postgres(process.env.DATABASE_URL, { max: 1 }),
  org = randomUUID(),
  workspace = randomUUID(),
  users = {},
  sessions = {};
let deployment, agentId;
const website = createServer((_req, res) =>
  res
    .writeHead(200, { "content-type": "text/html" })
    .end(
      `<!doctype html><title>Widget reference</title><body><script src="http://localhost:4000/widget.js" data-deployment="${deployment}"></script>`,
    ),
);
test.beforeAll(async ({ request }) => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES(${org},'Widget editor browser')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES(${workspace},${org},'Widget workspace')`;
    for (const role of ["owner", "analyst"]) {
      const uid = randomUUID(),
        raw = randomUUID();
      users[role] = uid;
      sessions[role] = raw;
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES(${uid},${uid + "@example.invalid"},${role},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(${createHash("sha256").update(raw).digest("hex")},${uid},now()+interval '1 hour')`;
      await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES(${randomUUID()},${org},${role === "owner" ? null : workspace},${uid},${role})`;
    }
  });
  const headers = {
    origin: "http://localhost:3000",
    cookie: `session=${sessions.owner}`,
  };
  async function post(path, data) {
    const r = await request.post("http://localhost:4000" + path, {
      headers,
      data,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  }
  const model = await post(`/workspaces/${workspace}/models`, {
    name: "Preview fixture",
    provider: "openai-compatible",
    modelId: "fixture",
    baseUrl: "https://api.openai.com/v1",
    capabilities: {
      streaming: true,
      temperature: true,
      topP: true,
      imageInput: true,
    },
  });
  const agent = await post(`/workspaces/${workspace}/agents`, {
    name: "Published support",
    config: {
      modelId: model.id,
      welcomeMessage: "Hello from the published agent",
      conversationStarters: ["What can you help with?"],
    },
  });
  agentId = agent.id;
  const version = await post(`/agents/${agent.id}/publish`, { revision: 1 });
  deployment = (
    await post(`/agents/${agent.id}/deployments`, {
      name: "Website support",
      versionId: version.id,
    })
  ).id;
  await sql`UPDATE agents SET name='Renamed draft' WHERE id=${agent.id}`;
  await new Promise((resolve) => website.listen(4509, "127.0.0.1", resolve));
});
test.afterAll(async () => {
  website.closeAllConnections();
  await new Promise((r) => website.close(r));
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
    for (const uid of Object.values(users)) {
      await tx`DELETE FROM sessions WHERE user_id=${uid}`;
      await tx`DELETE FROM users WHERE id=${uid}`;
    }
  });
  await sql.end();
});
async function open(page, context, role = "owner") {
  await context.addCookies([
    {
      name: "session",
      value: sessions[role],
      url: "http://localhost:3000",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto(`/#view=Channels&organization=${org}&workspace=${workspace}`);
  await expect(
    page.getByRole("tab", { name: "Appearance", exact: true }),
  ).toBeVisible();
}
async function snapshot(frame) {
  return frame.locator("body").evaluate((body) => {
    const root = [...body.children].find((e) => e.shadowRoot)?.shadowRoot,
      panel = root.querySelector("section"),
      style = getComputedStyle(panel),
      host = panel.getRootNode().host;
    return {
      title: root.querySelector("h2").textContent,
      greeting: root.querySelector(".message-bubble").textContent,
      width: panel.getBoundingClientRect().width,
      height: panel.getBoundingClientRect().height,
      background: style.backgroundColor,
      color: style.color,
      button: getComputedStyle(root.querySelector("header button"))
        .backgroundColor,
      left: host.style.left,
      right: host.style.right,
      lang: host.lang,
      css: root.querySelector("style").textContent,
    };
  });
}
test("Tabs preserve drafts and production-script preview exactly matches the saved widget without leaking preview requests", async ({
  page,
  context,
  browser,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const publicCalls = [];
  page.on("request", (r) => {
    if (r.url().includes("/public/widgets/")) publicCalls.push(r.url());
  });
  await open(page, context);
  const preview = page.getByLabel("Widget live preview", { exact: true });
  await expect(preview).toContainText("Example conversation only", {
    timeout: 15000,
  });
  const frame = page.frameLocator(
    'iframe[title="Live website widget preview"]',
  );
  await expect(
    frame.getByRole("heading", { name: "Published support", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Width", { exact: true }).fill("420");
  await page.getByLabel("Height", { exact: true }).fill("600");
  await page
    .getByRole("combobox", { name: "Position", exact: true })
    .selectOption("left");
  await page.getByLabel("Launcher text", { exact: true }).fill("Talk to us");
  await page.getByLabel("Greeting", { exact: true }).fill("Widget greeting");
  await page.getByRole("tab", { name: "Branding", exact: true }).click();
  await page.getByLabel("Chatbot name", { exact: true }).fill("Acme Care");
  await page
    .getByLabel("Welcome message", { exact: true })
    .fill("Welcome to Acme Care");
  await page.getByLabel("Button color", { exact: true }).fill("#1357aa");
  await page.getByLabel("Background color", { exact: true }).fill("#f4f7fb");
  await page.getByLabel("Text color", { exact: true }).fill("#172233");
  await expect(
    frame.getByRole("heading", { name: "Acme Care", exact: true }),
  ).toBeVisible();
  await expect(
    frame.getByText("Welcome to Acme Care", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Setup", exact: true }).click();
  await page.getByLabel("Enable website widget", { exact: true }).check();
  await page
    .getByLabel("Allowed website origins", { exact: false })
    .fill("http://localhost:4509");
  await page.getByRole("tab", { name: "Branding", exact: true }).click();
  await expect(page.getByLabel("Chatbot name", { exact: true })).toHaveValue(
    "Acme Care",
  );
  const [before] =
    await sql`SELECT widget_settings,branding FROM deployments WHERE id=${deployment}`;
  expect(before.branding).toEqual({});
  const [counts] =
    await sql`SELECT count(*)::int AS n FROM conversations WHERE deployment_id=${deployment}`;
  expect(counts.n).toBe(0);
  expect(publicCalls).toEqual([]);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Widget settings and branding saved." }),
  ).toBeVisible();
  await expect(preview).toContainText("Example conversation only");
  const [stored] =
    await sql`SELECT widget_settings,branding FROM deployments WHERE id=${deployment}`;
  expect(stored.branding.name).toBe("Acme Care");
  expect(stored.widget_settings.width).toBe(420);
  const guest = await browser.newContext({
    viewport: { width: 460, height: 690 },
  });
  try {
    const actual = await guest.newPage();
    await actual.goto("http://localhost:4509");
    await actual
      .getByRole("button", { name: "Talk to us", exact: true })
      .click();
    await expect(
      actual.getByRole("heading", { name: "Acme Care", exact: true }),
    ).toBeVisible();
    expect(await snapshot(frame)).toEqual(await snapshot(actual));
  } finally {
    await guest.close();
  }
  await frame.getByLabel("Message", { exact: true }).fill("Example question");
  await frame.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    frame.getByText(
      "This is an example reply. Preview messages are not sent to the agent or saved.",
      { exact: true },
    ),
  ).toBeVisible();
  const [runs] =
    await sql`SELECT count(*)::int AS n FROM agent_runs WHERE workspace_id=${workspace}`;
  expect(runs.n).toBe(0);
  expect(publicCalls).toEqual([]);
  await page.getByRole("tab", { name: "Install", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Copy widget code", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Floating chat widget embed code")).toHaveValue(
    new RegExp(deployment),
  );
  await page.getByRole("tab", { name: "Branding", exact: true }).click();
  await preview.scrollIntoViewIfNeeded();
  await expect(
    frame.getByRole("heading", { name: "Acme Care", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("widget-editor-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  await expect(
    page.getByLabel("Widget live preview", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("widget-editor-mobile.png"),
    fullPage: true,
  });
});
test("Read-only users can preview and copy installation code but cannot change settings", async ({
  page,
  context,
}) => {
  await open(page, context, "analyst");
  await expect(
    page.getByRole("combobox", { name: "Theme", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Appearance", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Branding", exact: true }),
  ).toBeFocused();
  await expect(page.getByLabel("Chatbot name", { exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "Install", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Copy widget code", exact: true }),
  ).toBeEnabled();
});

test("Customer widget and hosted iframe use configured colors without platform branding or theme switches", async ({
  page,
  context,
}, info) => {
  const colors = {
    name: "Acme Care",
    welcomeMessage: "Hi, how can we help you today?",
    primaryColor: "#ed0039",
    backgroundColor: "#ffffff",
    textColor: "#151515",
    logoUrl: "",
  };
  await sql`UPDATE deployments SET branding=${sql.json(colors)},widget_settings=widget_settings||${sql.json({ enabled: true, access: "restricted", allowedOrigins: ["http://localhost:4509"], theme: "dark", launcher: "Chat", position: "right", width: 380, height: 600 })} WHERE id=${deployment}`;
  await context.addInitScript(() => {
    localStorage.setItem("agent-connex-theme", "dark");
    localStorage.setItem(
      "agent-connex-widget-theme:" + location.pathname.split("/").at(-1),
      "dark",
    );
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const requests = [];
  page.on("request", (req) => requests.push(req.url()));
  await page.goto("http://localhost:4509");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const widget = page.getByRole("dialog", { name: "Acme Care", exact: true });
  await expect(widget).toBeVisible();
  await expect(widget).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(widget).toHaveCSS("color", "rgb(21, 21, 21)");
  await expect(page.locator(".chat-header")).toHaveCSS(
    "background-color",
    "rgb(237, 0, 57)",
  );
  await expect(page.locator(".chat-header")).toHaveCSS(
    "color",
    "rgb(255, 255, 255)",
  );
  await expect(
    page.getByRole("button", { name: /Switch to .* theme/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("img", { name: /Agent Connex/ })).toHaveCount(0);
  await expect(widget).not.toContainText("Agent Connex");
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(
    page.getByText("Previous conversations", { exact: true }),
  ).toBeHidden();
  await page.getByLabel("Chat options", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "New chat", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const box = await widget.boundingBox();
  expect(Math.round(1280 - box.x - box.width)).toBe(20);
  expect(Math.round(900 - box.y - box.height)).toBe(20);
  await page.screenshot({
    path: info.outputPath("customer-widget-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await widget.boundingBox();
  expect(mobile.x).toBeGreaterThanOrEqual(0);
  expect(mobile.x + mobile.width).toBeLessThanOrEqual(390);
  expect(mobile.y + mobile.height).toBeLessThanOrEqual(844);
  await page.screenshot({
    path: info.outputPath("customer-widget-mobile.png"),
    fullPage: true,
  });
  await page.goto(`http://localhost:3000/chat/${deployment}`);
  await expect(page.locator(".customer-chat .panel-header h3")).toHaveText(
    "Acme Care",
  );
  await expect(page.locator(".hosted-shell")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await expect(page.locator(".hosted-shell")).toHaveCSS(
    "color",
    "rgb(21, 21, 21)",
  );
  await expect(page.locator(".customer-chat>.panel-header")).toHaveCSS(
    "background-color",
    "rgb(237, 0, 57)",
  );
  await expect(
    page.getByRole("button", { name: /Switch to .* theme/ }),
  ).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Agent Connex");
  await expect(
    page.getByText("Published agent · hosted chat", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator('link[rel="icon"][href*="agent-connex"]'),
  ).toHaveCount(0);
  await expect(page.locator(".customer-chat-shell>.brand")).toHaveCount(0);
  expect(
    requests.some((url) => url.includes("/brand/agent-connex")),
  ).toBeFalsy();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollHeight <= innerHeight + 1 &&
        document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  await page.getByLabel("Chat options", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "New chat", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: info.outputPath("customer-hosted-chat-mobile.png"),
    fullPage: true,
  });
});

test("Playground and floating widget select, remove and send document/photo attachments", async ({
  page,
  context,
  browser,
}) => {
  const photo = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=",
    "base64",
  );
  const files = [
    {
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Meeting at 14:30"),
    },
    { name: "photo.png", mimeType: "image/png", buffer: photo },
  ];
  const event = (name, value) =>
    `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
  const respond = (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      headers: {
        "access-control-allow-origin":
          route.request().headers().origin ?? "http://localhost:3000",
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers":
          "content-type, authorization, x-customer-token",
      },
      body:
        event("meta", { conversationId: randomUUID(), guestToken: "fixture" }) +
        event("token", { text: "Files received" }) +
        event("done", { messageId: randomUUID(), citations: [] }),
    });
  await context.addCookies([
    {
      name: "session",
      value: sessions.owner,
      url: "http://localhost:3000",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  let playgroundBody;
  await page.route(`http://localhost:4000/agents/${agentId}/chat`, (route) => {
    playgroundBody = route.request().postDataJSON();
    return respond(route);
  });
  await page.goto(
    `/#view=Agents&organization=${org}&workspace=${workspace}&agent=${agentId}&stage=playground`,
  );
  const playground = page.locator(".playground-chat");
  await expect(
    playground.getByRole("button", { name: "Attach files", exact: true }),
  ).toBeVisible();
  await playground
    .getByLabel("Choose attachments", { exact: true })
    .setInputFiles(files);
  await expect(
    playground.getByLabel("Attached files", { exact: true }),
  ).toContainText("photo.png");
  await playground
    .getByRole("button", { name: "Remove photo.png", exact: true })
    .click();
  await expect(
    playground.getByLabel("Attached files", { exact: true }),
  ).not.toContainText("photo.png");
  await playground
    .getByLabel("Choose attachments", { exact: true })
    .setInputFiles(files.slice(1));
  await playground
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(
    playground.getByText("Files received", { exact: true }),
  ).toBeVisible();
  expect(playgroundBody.attachments.map((f) => f.name)).toEqual([
    "notes.txt",
    "photo.png",
  ]);
  expect(playgroundBody.attachments[1].data).toBe(photo.toString("base64"));
  await expect(
    playground.getByLabel("Message attachments", { exact: true }),
  ).toContainText("notes.txt");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("playground-attachments-mobile.png"),
    fullPage: true,
  });
  const guest = await browser.newContext();
  try {
    const widgetPage = await guest.newPage();
    let widgetBody;
    await widgetPage.route(
      `http://localhost:4000/public/widgets/${deployment}/chat`,
      (route) => {
        widgetBody = route.request().postDataJSON();
        return respond(route);
      },
    );
    await widgetPage.goto("http://localhost:4509");
    await widgetPage.getByRole("button", { name: "Chat", exact: true }).click();
    await widgetPage
      .getByLabel("Choose attachments", { exact: true })
      .setInputFiles(files);
    await expect(
      widgetPage.getByLabel("Attached files", { exact: true }),
    ).toContainText("photo.png");
    await widgetPage.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      widgetPage.getByText("Files received", { exact: true }),
    ).toBeVisible();
    expect(widgetBody.attachments.map((f) => f.name)).toEqual([
      "notes.txt",
      "photo.png",
    ]);
    expect(widgetBody.attachments[1].data).toBe(photo.toString("base64"));
    await expect(
      widgetPage.getByLabel("Message attachments", { exact: true }),
    ).toContainText("photo.png");
    await widgetPage.setViewportSize({ width: 360, height: 800 });
    await widgetPage.screenshot({
      path: test.info().outputPath("widget-attachments-mobile.png"),
    });
    expect(
      await widgetPage.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await guest.close();
  }
});
