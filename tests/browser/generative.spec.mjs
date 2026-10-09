import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
import { createRequire } from "node:module";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
// Requires the API's explicit temporary MODEL_PRIVATE_HOSTS=127.0.0.1:4550.
// This exercises a protocol fixture, not a live model provider.
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const org = randomUUID(),
  workspace = randomUUID(),
  user = randomUUID(),
  session = randomUUID();
const answer = {
  version: 1,
  message: "Your generated report is ready.",
  blocks: [
    {
      type: "chart",
      title: "Revenue",
      chartType: "bar",
      data: [
        { label: "Jan", value: 10 },
        { label: "Feb", value: 20 },
      ],
    },
    {
      type: "table",
      title: "Report data",
      columns: [{ key: "month", label: "Month" }],
      rows: [{ month: "Jan" }],
    },
    {
      type: "form",
      id: "contact",
      title: "Contact details",
      fields: [
        {
          name: "email",
          label: "Email address",
          type: "email",
          required: true,
        },
      ],
      action: "data.collect",
      confirmation: "confirm",
      submitLabel: "Save contact",
    },
    {
      type: "file",
      title: "Revenue report",
      format: "csv",
      columns: [{ key: "amount", label: "Amount" }],
      rows: [{ amount: 20 }],
    },
  ],
};
const provider = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const data = JSON.parse(body);
  if (req.url !== "/v1/chat/completions" || !data.stream)
    return res.writeHead(400).end();
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    "data: " +
      JSON.stringify({
        choices: [
          { delta: { content: JSON.stringify(answer) }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 100 },
      }) +
      "\n\n",
  );
  res.end("data: [DONE]\n\n");
});
test.beforeAll(async () => {
  await new Promise((resolve) => provider.listen(4550, "127.0.0.1", resolve));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${user},${user + "@example.com"},'Generative Builder','unused-browser-fixture',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(session).digest("hex")},${user},now()+interval '1 hour')`;
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Generative browser')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Generative workspace')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${user},'owner')`;
  });
});
test.afterAll(async () => {
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  // Test objects are bounded; remove their storage through the repository helper.
  const artifacts =
    await sql`SELECT storage_key FROM generated_artifacts WHERE organization_id=${org}`;
  const { S3Client, DeleteObjectCommand } = createRequire(
    new URL("../../apps/api/package.json", import.meta.url),
  )("@aws-sdk/client-s3");
  const storage = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
  });
  for (const artifact of artifacts)
    await storage.send(
      new DeleteObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: artifact.storage_key,
      }),
    );
  storage.destroy();
  await sql.begin(async (tx) => {
    for (const table of [
      "collected_submissions",
      "generated_artifacts",
      "webhook_deliveries",
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
test("generated response, confirmation, download, collection and public defaults", async ({
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
  const headers = { origin: "http://localhost:3000" };
  const modelResponse = await context.request.post(
    `http://localhost:4000/workspaces/${workspace}/models`,
    {
      headers,
      data: {
        name: "Generative fixture",
        provider: "openai-compatible",
        modelId: "fixture",
        baseUrl: "http://127.0.0.1:4550/v1",
        contextWindow: 131072,
        maxOutputTokens: 4096,
      },
    },
  );
  expect(modelResponse.ok()).toBe(true);
  await page.goto("/");
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await page.getByLabel("Agent name").fill("Report assistant");
  await page.getByLabel("Enable generative responses", { exact: true }).check();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByText("Draft saved. Start a new chat to use these changes."),
  ).toBeVisible();
  await page.getByRole("button", { name: "playground", exact: true }).click();
  await page
    .getByLabel("Message", { exact: true })
    .fill("Generate a report and contact form");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByText("Your generated report is ready.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("img", { name: "Revenue" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Report data" }),
  ).toBeVisible();
  await page.getByLabel("Email address").fill("browser@example.com");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Save contact", exact: true }).click();
  await expect
    .poll(async () =>
      Number(
        (
          await sql`SELECT count(*) AS n FROM collected_submissions WHERE workspace_id=${workspace}`
        )[0].n,
      ),
    )
    .toBe(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Save contact", exact: true }).click();
  await expect(
    page.getByText("Submitted. Your values were saved."),
  ).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download file", exact: true })
    .click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("Revenue-report.csv");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/generative-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
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
    await chat.getByLabel("Message", { exact: true }).fill("Generate report");
    await chat.getByRole("button", { name: "Send message" }).click();
    await expect(
      chat.getByText("Your generated report is ready.", { exact: true }),
    ).toBeVisible();
    await expect(
      chat.getByRole("button", { name: "Save contact", exact: true }),
    ).toHaveCount(0);
    await expect(
      chat.getByText("Submissions are disabled in this view."),
    ).toBeVisible();
  } finally {
    await guest.close();
  }
  await page
    .getByRole("button", { name: "Collected data", exact: true })
    .click();
  const record = page
    .locator("details")
    .filter({ hasText: "Report assistant" });
  await record.locator("summary").click();
  await expect(record.getByText("browser@example.com")).toBeVisible();
  await page.getByLabel("Search values").fill("no-matching-value");
  await expect(page.getByText("No submissions yet")).toBeVisible();
});
