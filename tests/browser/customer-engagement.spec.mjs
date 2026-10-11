import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const sql = postgres(process.env.DATABASE_URL, { max: 2 }),
  org = randomUUID(),
  workspace = randomUUID(),
  owner = randomUUID(),
  model = randomUUID(),
  agent = randomUUID(),
  version = randomUUID(),
  deployment = randomUUID(),
  workflow = randomUUID(),
  workflowVersion = randomUUID(),
  session = randomUUID();
const chartData = [
  { label: "North", value: 4 },
  { label: "South", value: 7 },
];
const blocks = [
  {
    type: "table",
    title: "Branch hours",
    columns: [
      { key: "branch", label: "Branch" },
      { key: "hours", label: "Hours" },
    ],
    rows: [{ branch: "Main branch", hours: "09:00–16:00" }],
  },
  ...["bar", "line", "area", "pie", "donut", "scatter"].map((chartType) => ({
    type: "chart",
    title: chartType + " chart",
    chartType,
    data: chartData,
  })),
  {
    type: "form",
    id: "contact",
    title: "Contact request",
    action: "data.collect",
    confirmation: "confirm",
    submitLabel: "Submit contact",
    fields: [{ name: "email", label: "Email", type: "email", required: true }],
  },
  {
    type: "file",
    title: "Branch guide",
    format: "txt",
    content: "Approved branch guide",
  },
];
const provider = createServer(async (req, res) => {
  for await (const chunk of req) {
    void chunk;
  }
  const content = JSON.stringify({
    version: 1,
    message: "Here are our branch hours and support options.",
    blocks,
  });
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    "data: " +
      JSON.stringify({
        choices: [{ delta: { content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 80 },
      }) +
      "\n\ndata: [DONE]\n\n",
  );
});
const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    `<html><body><h1>Customer Support</h1><script src="http://localhost:4000/widget.js" data-deployment="${deployment}"></script></body></html>`,
  );
});
const graph = {
  schemaVersion: 1,
  nodes: [
    {
      id: "input",
      type: "input",
      position: { x: 0, y: 0 },
      data: { label: "Input" },
    },
    {
      id: "output",
      type: "output",
      position: { x: 200, y: 0 },
      data: { label: "Result", prefix: "Completed: " },
    },
  ],
  edges: [{ id: "io", source: "input", target: "output" }],
};
const capabilities = { streaming: true, temperature: true, topP: true };
const c = {
  modelId: model,
  generative: { enabled: true, allowPublicForms: true },
  welcomeMessage: "How can we help you today?",
  quickActions: [
    {
      id: "lookup",
      label: "Start lookup",
      message: "Lookup reference",
      behavior: "workflow",
      workflowVersionId: workflowVersion,
      workflowFields: [
        { name: "reference", label: "Reference", type: "text", required: true },
      ],
    },
  ],
};
test.beforeAll(async () => {
  await new Promise((r) => provider.listen(4568, "127.0.0.1", r));
  await new Promise((r) => site.listen(4569, "127.0.0.1", r));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES(${owner},${owner + "@example.com"},'Customer Support','not-login',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(${createHash("sha256").update(session).digest("hex")},${owner},now()+interval '1 hour')`;
    await tx`INSERT INTO organizations(id,name) VALUES(${org},'Customer browser fixture')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES(${workspace},${org},'Customer Support')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES(${randomUUID()},${org},${owner},'owner')`;
    await tx`INSERT INTO model_configurations(id,workspace_id,organization_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES(${model},${workspace},${org},'Fixture','openai-compatible','fixture','http://127.0.0.1:4568/v1',32768,4096,${tx.json(capabilities)})`;
    await tx`INSERT INTO workflows(id,workspace_id,organization_id,name,description,draft_graph,created_by) VALUES(${workflow},${workspace},${org},'Customer lookup','',${tx.json(graph)},${owner})`;
    await tx`INSERT INTO workflow_versions(id,workflow_id,workspace_id,organization_id,version,name,graph,published_by) VALUES(${workflowVersion},${workflow},${workspace},${org},1,'Customer lookup',${tx.json(graph)},${owner})`;
    await tx`INSERT INTO agents(id,workspace_id,organization_id,name,description,public_description,draft_config,created_by) VALUES(${agent},${workspace},${org},'Customer Support','','',${tx.json(c)},${owner})`;
    const snapshot = {
      id: model,
      provider: "openai-compatible",
      modelId: "fixture",
      baseUrl: "http://127.0.0.1:4568/v1",
      secretId: null,
      capabilities,
      contextWindow: 32768,
      maxOutputTokens: 4096,
    };
    await tx`INSERT INTO agent_versions(id,agent_id,workspace_id,organization_id,version,name,public_description,config,model_snapshot,model_id,published_by) VALUES(${version},${agent},${workspace},${org},1,'Customer Support','',${tx.json(c)},${tx.json(snapshot)},${model},${owner})`;
    await tx`INSERT INTO deployments(id,workspace_id,organization_id,agent_id,version_id,name,environment,widget_settings) VALUES(${deployment},${workspace},${org},${agent},${version},'Customer Support','development',${tx.json({ enabled: true, access: "restricted", allowedOrigins: ["http://localhost:4569"], theme: "light", position: "right", launcher: "Chat", greeting: "How can we help you today?", width: 420, height: 720, language: "en" })})`;
  });
});
test.afterAll(async () => {
  provider.closeAllConnections();
  site.closeAllConnections();
  await new Promise((r) => provider.close(r));
  await new Promise((r) => site.close(r));
  // Object storage cleanup uses the same credentials locally, never printed.
  const { S3Client, DeleteObjectCommand } = createRequire(
    process.cwd() + "/apps/api/package.json",
  )("@aws-sdk/client-s3");
  const storage = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
  });
  const artifacts =
    await sql`SELECT storage_key FROM generated_artifacts WHERE organization_id=${org}`;
  for (const a of artifacts)
    await storage.send(
      new DeleteObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: a.storage_key,
      }),
    );
  storage.destroy();
  await sql.begin(async (tx) => {
    const runs =
      await tx`SELECT id FROM workflow_runs WHERE organization_id=${org}`;
    for (const table of [
      "checkpoint_writes",
      "checkpoint_blobs",
      "checkpoints",
    ])
      if (runs.length)
        await tx.unsafe(
          `DELETE FROM workflow_checkpoints.${table} WHERE thread_id=ANY($1::text[])`,
          [runs.map((r) => r.id)],
        );
    for (const table of [
      "workflow_approvals",
      "workflow_node_runs",
      "tool_executions",
      "workflow_runs",
      "workflow_versions",
      "workflows",
      "collected_submissions",
      "generated_artifacts",
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
    await tx`DELETE FROM users WHERE id=${owner}`;
  });
  await sql.end();
});
test("Customer workflow, rich widget controls, downloads and feedback persist on desktop and mobile", async ({
  page,
  browser,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4569");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "Agent Connex", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Switch to dark theme", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Switch to light theme", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Switch to light theme", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Switch to light theme", exact: true })
    .click();
  await expect
    .poll(() =>
      page
        .getByRole("img", { name: "Agent Connex", exact: true })
        .evaluate((img) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Start lookup", exact: true }).click();
  await expect(page.getByLabel("Reference", { exact: true })).toBeVisible();
  await page.getByLabel("Reference", { exact: true }).fill("REF-BROWSER");
  await page
    .getByRole("button", { name: "Start workflow", exact: true })
    .click();
  await expect(
    page.getByText("Workflow · completed", { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  const result = page
    .locator("details")
    .filter({ has: page.getByText("Workflow · completed", { exact: true }) });
  if (!(await result.evaluate((n) => n.open)))
    await page.getByText("Workflow · completed", { exact: true }).click();
  await expect(page.getByText("REF-BROWSER", { exact: true })).toBeVisible();
  await page
    .getByLabel("Message", { exact: true })
    .fill("Show rich information");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Branch hours", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Main branch", exact: true }),
  ).toBeVisible();
  for (const type of ["bar", "line", "area", "pie", "donut", "scatter"])
    await expect(
      page.getByRole("img", {
        name: `${type} chart, ${type} chart`,
        exact: true,
      }),
    ).toHaveCount(1);
  const form = page.locator("form").filter({
    has: page.getByRole("button", { name: "Submit contact", exact: true }),
  });
  await form.getByLabel("Email", { exact: true }).fill("customer@example.com");
  page.once("dialog", (dialog) => dialog.accept());
  await form
    .getByRole("button", { name: "Submit contact", exact: true })
    .click();
  await expect(
    page.getByText("Submitted. Your values were saved.", { exact: true }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download TXT", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/Branch-guide.txt/);
  await page.getByText("Rate this conversation", { exact: true }).click();
  await page
    .getByLabel("Satisfaction (1–5)", { exact: true })
    .selectOption("5");
  await page
    .getByLabel("Was your question resolved?", { exact: true })
    .selectOption("true");
  await page
    .getByRole("button", { name: "Save feedback", exact: true })
    .click();
  await expect(
    page.getByText("Thank you. Your feedback was saved.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Branch hours", exact: true }),
  ).toBeVisible();
  await page.getByText("Rate this conversation", { exact: true }).click();
  await expect(
    page.getByLabel("Satisfaction (1–5)", { exact: true }),
  ).toHaveValue("5");
  await expect(
    page.getByLabel("Was your question resolved?", { exact: true }),
  ).toHaveValue("true");
  await expect(
    page.getByText("Workflow · completed", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("widget-desktop.png") });
  if (process.env.PRODUCT_SCREENSHOTS) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByText("Rate this conversation", { exact: true }).click();
    await page
      .getByRole("button", { name: "Close chat", exact: true })
      .locator("..")
      .locator("..")
      .screenshot({ path: "docs/screenshots/chat-widget-desktop.png" });
  }
  await page
    .getByRole("button", { name: "Switch to dark theme", exact: true })
    .click();
  await expect(page.locator("section.dark .rich-block").first()).toHaveCSS(
    "background-color",
    "rgb(18, 22, 32)",
  );
  await expect(page.locator("section.dark table").first()).toHaveCSS(
    "color",
    "rgb(238, 240, 250)",
  );
  if (process.env.PRODUCT_SCREENSHOTS)
    await page
      .getByRole("button", { name: "Close chat", exact: true })
      .locator("..")
      .locator("..")
      .screenshot({ path: "docs/screenshots/chat-widget-dark.png" });
  await page.setViewportSize({ width: 360, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "Close chat", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("widget-mobile.png") });
  if (process.env.PRODUCT_SCREENSHOTS)
    await page.screenshot({ path: "docs/screenshots/chat-widget-mobile.png" });
  expect(errors).toEqual([]);
  const hosted = await browser.newContext();
  const chat = await hosted.newPage();
  await chat.goto("/chat/" + deployment);
  await chat.getByRole("button", { name: "Start lookup", exact: true }).click();
  await chat.getByLabel("Reference", { exact: true }).fill("HOSTED-REF");
  await chat
    .getByRole("button", { name: "Start workflow", exact: true })
    .click();
  await expect(
    chat.getByText("Workflow · completed", { exact: true }),
  ).toBeVisible({ timeout: 20000 });
  await chat.reload();
  await expect(
    chat.getByText("Workflow · completed", { exact: true }),
  ).toBeVisible();
  await hosted.close();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.context().addCookies([
    {
      name: "session",
      value: session,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto(
    `/#view=Channels&organization=${org}&workspace=${workspace}&channelsSection=messaging`,
  );
  await page
    .getByRole("button", { name: "Customer messaging", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Customer messaging", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Provider", { exact: true })).toBeVisible();
  for (const provider of ["messenger", "viber", "telegram", "teams"]) {
    await page.getByLabel("Provider", { exact: true }).selectOption(provider);
    await expect(
      page.getByText(/Credentials stay encrypted on the server/),
    ).toBeVisible();
  }
  await page
    .getByRole("button", { name: "Switch to dark theme", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  await page
    .getByRole("button", { name: "Assisted answer", exact: true })
    .click();
  await page.getByText("Prepare answer", { exact: true }).click();
  await page
    .getByLabel("Published agent version", { exact: true })
    .selectOption(version);
  await page.getByText("Failure recovery", { exact: true }).click();
  await page.getByLabel("Total attempts", { exact: true }).fill("2");
  await page
    .getByLabel("Initial retry delay (milliseconds)", { exact: true })
    .fill("100");
  await page
    .getByTestId("rf__node-output")
    .getByText("Answer", { exact: true })
    .click();
  await page.getByLabel("Result title", { exact: true }).fill("Lookup summary");
  await page
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  await expect(
    page.getByText("Workflow draft saved.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Publish workflow", exact: true })
    .click();
  await expect
    .poll(async () => {
      const rows =
        await sql`SELECT v.graph FROM workflow_versions v JOIN workflows w ON w.id=v.workflow_id WHERE w.workspace_id=${workspace} AND w.name='Assisted answer'`;
      return rows.length;
    })
    .toBe(1);
  const [published] =
    await sql`SELECT v.graph FROM workflow_versions v JOIN workflows w ON w.id=v.workflow_id WHERE w.workspace_id=${workspace} AND w.name='Assisted answer'`;
  expect(
    published.graph.nodes.find((n) => n.id === "answer").data.retry.maxAttempts,
  ).toBe(2);
  expect(
    published.graph.nodes.find((n) => n.id === "output").data.resultTitle,
  ).toBe("Lookup summary");
  await page
    .getByRole("button", { name: "Create reusable copy", exact: true })
    .click();
  await expect(page.getByLabel("Workflow name", { exact: true })).toHaveValue(
    "Assisted answer copy",
  );
  await page
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  await expect
    .poll(async () => {
      const rows =
        await sql`SELECT draft_graph FROM workflows WHERE workspace_id=${workspace} AND name='Assisted answer copy'`;
      return rows.length;
    })
    .toBe(1);
  if (process.env.PRODUCT_SCREENSHOTS)
    await page.screenshot({
      path: "docs/screenshots/workflow-dark.png",
      fullPage: true,
    });
  for (const view of [
    "Models",
    "Knowledge",
    "Tools",
    "Connectors",
    "Operations",
    "Quality",
    "Secrets",
  ]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(
      page.getByRole("heading", { name: view, exact: true }).first(),
    ).toBeVisible();
  }
  await page.setViewportSize({ width: 360, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("button", { name: "Switch to light theme", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
