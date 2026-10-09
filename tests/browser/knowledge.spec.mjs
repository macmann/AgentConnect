import { cleanupKnowledgeFixtures } from "../../apps/api/test/knowledge-cleanup.mjs";
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
// Explicit local protocol fixture, not a live embedding or generation model.
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production mode");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const org = randomUUID(),
  workspace = randomUUID(),
  user = randomUUID(),
  session = randomUUID();
let embedded = 0,
  generated = 0,
  grounded = false;
const provider = createServer(async (req, res) => {
  if (req.method === "GET") {
    if (req.url === "/robots.txt") {
      res
        .writeHead(200, { "content-type": "text/plain" })
        .end("User-agent: *\nDisallow: /private\n");
      return;
    }
    res
      .writeHead(200, { "content-type": "text/html" })
      .end(
        "<html><title>Refund website</title><body><main>Refunds are available within 30 days.</main></body></html>",
      );
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const input = JSON.parse(raw);
  if (req.url === "/v1/embeddings") {
    embedded += input.input.length;
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        data: input.input.map((text, index) => ({
          index,
          embedding: text.toLowerCase().includes("refund")
            ? [1, 0.2, 0.3]
            : [0.1, 1, 0.3],
        })),
      }),
    );
    return;
  }
  if (req.url === "/v1/chat/completions") {
    generated++;
    grounded =
      input.messages[0].content.includes("<reference_passages>") &&
      input.messages[0].content.includes("30 days");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      "data: " +
        JSON.stringify({
          choices: [
            { delta: { content: "Refunds are available within 30 days " } },
          ],
        }) +
        "\n\n",
    );
    res.end(
      "data: " +
        JSON.stringify({
          choices: [{ delta: { content: "[1]." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 30, completion_tokens: 10 },
        }) +
        "\n\ndata: [DONE]\n\n",
    );
    return;
  }
  res.writeHead(404).end();
});
function pdfFixture(text) {
  const parts = ["%PDF-1.4\n"],
    offsets = [];
  const content = `BT /F1 12 Tf 40 250 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(parts.join("").length);
    parts.push(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
  }
  const xref = parts.join("").length;
  parts.push(
    "xref\n0 6\n0000000000 65535 f \n" +
      offsets.map((n) => String(n).padStart(10, "0") + " 00000 n \n").join("") +
      `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`,
  );
  return Buffer.from(parts.join(""));
}
test.beforeAll(async () => {
  await new Promise((resolve) => provider.listen(4546, "127.0.0.1", resolve));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${user},${user + "@example.com"},'Knowledge Builder','unused-browser-fixture',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(session).digest("hex")},${user},now()+interval '1 hour')`;
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Browser knowledge')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Knowledge workspace')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${user},'owner')`;
  });
});
test.afterAll(async () => {
  await cleanupKnowledgeFixtures(sql, org);
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
      "knowledge_jobs",
      "knowledge_documents",
      "knowledge_sources",
      "knowledge_bases",
      "embedding_models",
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
test("knowledge upload and worker ingestion support retrieval, attached agents and hosted citations", async ({
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
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await page
    .getByRole("button", { name: "Register embedding model", exact: true })
    .click();
  await page
    .getByLabel("Embedding display name")
    .fill("Browser embedding fixture");
  await page
    .getByLabel("Embedding provider", { exact: true })
    .selectOption("openai-compatible");
  await page
    .getByLabel("Embedding model identifier")
    .fill("fixture-embeddings");
  await page.getByLabel("Embedding dimensions").fill("3");
  await page.getByLabel("Embedding base URL").fill("http://127.0.0.1:4546/v1");
  await page
    .getByRole("button", { name: "Save embedding model", exact: true })
    .click();
  await expect(page.getByText("Embedding model registered")).toBeVisible();
  await page
    .getByRole("button", { name: "Create knowledge base", exact: true })
    .click();
  await page.getByLabel("Knowledge base name").fill("Refund knowledge");
  await page
    .getByRole("checkbox", { name: "Allow knowledge in public hosted chat" })
    .check();
  await page
    .getByRole("button", { name: "Save knowledge base", exact: true })
    .click();
  await expect(page.getByText("Knowledge base created")).toBeVisible();
  await page
    .getByRole("button", { name: "Upload document", exact: true })
    .click();
  await page.getByLabel("Document file").setInputFiles({
    name: "refund-policy.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "# Refund policy\nCustomers can request refunds within 30 days of purchase.",
    ),
  });
  await page
    .getByRole("button", { name: "Upload and ingest", exact: true })
    .click();
  const row = page.getByRole("row").filter({ hasText: "refund-policy.md" });
  await expect(row.getByText("ready", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await row
    .getByRole("button", { name: "Inspect chunks", exact: true })
    .click();
  await page.locator(".chunk-preview summary").click();
  await expect(
    page
      .getByText("Customers can request refunds within 30 days of purchase.", {
        exact: false,
      })
      .last(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close preview" }).click();
  await page
    .getByRole("button", { name: "Retrieval playground", exact: true })
    .click();
  await page.getByLabel("Retrieval query").fill("What is the refund policy?");
  await page
    .getByRole("button", { name: "Search knowledge", exact: true })
    .click();
  await expect(
    page.getByText("[1] refund-policy.md", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Models", exact: true }).click();
  await page
    .getByRole("button", { name: "Register model", exact: true })
    .click();
  await page.getByLabel("Display name").fill("Grounded chat fixture");
  await page.getByLabel(/^Provider/).selectOption("openai-compatible");
  await page.getByLabel("Model identifier").fill("fixture-chat");
  await page.getByLabel(/^Base URL/).fill("http://127.0.0.1:4546/v1");
  await page.getByRole("button", { name: "Save model", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "Grounded chat fixture", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await page.getByLabel("Agent name").fill("Refund assistant");
  await page
    .getByRole("checkbox", {
      name: "Refund knowledge · Public chat enabled",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByText("Draft saved. Start a new chat to use these changes."),
  ).toBeVisible();
  await page.getByRole("button", { name: "playground", exact: true }).click();
  await page
    .getByLabel("Message", { exact: true })
    .fill("What is the refund window?");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByText("Refunds are available within 30 days [1].", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("[1] refund-policy.md", { exact: true }),
  ).toBeVisible();
  expect(grounded).toBe(true);
  await page.getByRole("button", { name: "publish", exact: true }).click();
  await page.getByRole("button", { name: "Publish saved draft" }).click();
  await expect(page.getByText("Version 1 published")).toBeVisible();
  await page.getByRole("button", { name: "Create hosted deployment" }).click();
  const href = await page
    .getByRole("link", { name: "Open hosted chat" })
    .getAttribute("href");
  const guest = await browser.newContext();
  try {
    const chat = await guest.newPage();
    await chat.goto("http://localhost:3000" + href);
    await chat
      .getByLabel("Message", { exact: true })
      .fill("What is the refund policy?");
    await chat.getByRole("button", { name: "Send message" }).click();
    await expect(
      chat.getByText("[1] refund-policy.md", { exact: true }),
    ).toBeVisible();
    await chat.getByText("[1] refund-policy.md", { exact: true }).click();
    await expect(
      chat
        .getByText(
          "Customers can request refunds within 30 days of purchase.",
          { exact: false },
        )
        .last(),
    ).toBeVisible();
    await chat.setViewportSize({ width: 390, height: 844 });
    expect(
      await chat.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await chat.screenshot({
      path: "test-results/grounded-chat-mobile.png",
      fullPage: true,
    });
  } finally {
    await guest.close();
  }
  await page.getByRole("button", { name: "Knowledge", exact: true }).click();
  await page.getByRole("button", { name: /^Refund knowledge/ }).click();
  await page
    .getByRole("button", { name: "Upload document", exact: true })
    .click();
  await page
    .getByLabel("Document file")
    .setInputFiles({
      name: "refund-policy.pdf",
      mimeType: "application/pdf",
      buffer: pdfFixture("Refunds within 30 days"),
    });
  await page
    .getByRole("button", { name: "Upload and ingest", exact: true })
    .click();
  const pdfRow = page.getByRole("row").filter({ hasText: "refund-policy.pdf" });
  await expect(pdfRow.getByText("ready", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await pdfRow
    .getByRole("button", { name: "Inspect chunks", exact: true })
    .click();
  await expect(page.locator(".chunk-preview summary")).toContainText("Page 1");
  await page.locator(".chunk-preview summary").click();
  await expect(page.locator(".chunk-preview .source-snippet")).toContainText(
    "Refunds within 30 days",
  );
  await page.screenshot({
    path: "test-results/knowledge-desktop.png",
    fullPage: true,
  });
  expect(generated).toBe(2);
  expect(embedded).toBeGreaterThanOrEqual(4);
  const [message] =
    await sql`SELECT citations FROM messages WHERE workspace_id=${workspace} AND role='assistant' LIMIT 1`;
  expect(message.citations).toHaveLength(1);
  expect(message.citations[0].title).toBe("refund-policy.md");
});
