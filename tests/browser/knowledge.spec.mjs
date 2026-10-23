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
let visionCalls = 0;
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
    if (req.url === "/website") {
      res.writeHead(301, { location: "/landing/" }).end();
      return;
    }
    res
      .writeHead(200, { "content-type": "text/html" })
      .end(
        '<html><title>Refund website</title><body><nav><a href="/details">Policy details</a><a href="/private">Private</a></nav><main>Website-only refund policy: refunds are available within 30 days.</main></body></html>',
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
          embedding: text.toLowerCase().includes("website-only")
            ? [0.1, 1, 0.3]
            : text.toLowerCase().includes("refund")
              ? [1, 0.2, 0.3]
              : [0.1, 1, 0.3],
        })),
      }),
    );
    return;
  }
  if (
    req.url === "/v1/chat/completions" &&
    Array.isArray(input.messages.at(-1)?.content)
  ) {
    visionCalls++;
    const image = input.messages
      .at(-1)
      .content.find((part) => part.type === "image_url");
    if (!image?.image_url.url.startsWith("data:image/png;base64,")) {
      res.writeHead(400).end();
      return;
    }
    const text = JSON.stringify({
      language: "Burmese, Thai, English",
      warnings: ["Verify uncertain cells"],
      blocks: [
        {
          kind: "text",
          heading: "Financial statement",
          text: "မြန်မာ รายงาน",
          rows: [],
          headerRows: 0,
        },
        {
          kind: "table",
          heading: "Amounts in MMK",
          text: "",
          rows: [
            ["Period", "2026", "2025"],
            ["Revenue", "1,250.00", "(900.00)"],
            ["Footnote"],
          ],
          headerRows: 1,
        },
      ],
    });
    res.writeHead(200, { "content-type": "text/event-stream" }).end(
      "data: " +
        JSON.stringify({
          choices: [{ delta: { content: text }, finish_reason: "stop" }],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
    return;
  }
  if (
    req.url === "/v1/chat/completions" &&
    input.model === "financial-benchmark"
  ) {
    const raw = input.messages[0].content
      .split("<reference_passages>\n")[1]
      ?.split("\n</reference_passages>")[0];
    const passages = raw ? JSON.parse(raw) : [];
    const reference =
      passages.find((p) => p.text.includes("(950.00)"))?.reference ?? "1";
    res.writeHead(200, { "content-type": "text/event-stream" }).end(
      "data: " +
        JSON.stringify({
          choices: [
            {
              delta: { content: `Revenue is (950.00) MMK [${reference}].` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 12 },
        }) +
        "\n\ndata: [DONE]\n\n",
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
  const budget = await fetch("http://localhost:4000/auth/me");
  if (Number(budget.headers.get("x-ratelimit-remaining") ?? 300) < 200) {
    console.log(
      "Pacing agent configuration browser regression for the API rate-limit window",
    );
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
      "evaluation_results",
      "evaluation_runs",
      "agent_quality_gates",
      "evaluation_datasets",
      "tool_executions",
      "tools",
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
  await expect(
    page.getByRole("checkbox", {
      name: "Enable advanced document processing",
      exact: true,
    }),
  ).not.toBeChecked();
  await expect(
    page.getByLabel("Target chunk size (tokens)", { exact: true }),
  ).toHaveCount(0);
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
  await page.getByLabel("Document files").setInputFiles({
    name: "refund-policy.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "# Refund policy\nCustomers can request refunds within 30 days of purchase.",
    ),
  });
  await page
    .getByRole("button", { name: "Start uploads", exact: true })
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
    .getByRole("navigation", { name: "Configure sections" })
    .getByRole("button", { name: "Knowledge", exact: true })
    .click();
  await page
    .getByRole("checkbox", {
      name: "Refund knowledge · Public chat enabled",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByText("Draft saved. Start a new chat to use these changes."),
  ).toBeVisible();
  if (process.env.PRODUCT_SCREENSHOTS) {
    await page.setViewportSize({ width: 1440, height: 1400 });
    await page.evaluate(() => {
      document.activeElement?.blur();
      window.scrollTo(0, 350);
    });
    await page.screenshot({
      path: "docs/screenshots/rag-agent-knowledge.png",
      fullPage: false,
    });
    await page
      .getByRole("navigation", { name: "Configure sections" })
      .getByRole("button", { name: "Overview", exact: true })
      .click();
    await page.evaluate(() => {
      document.activeElement?.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({
      path: "docs/screenshots/rag-agent-overview.png",
      fullPage: false,
    });
    await page
      .getByRole("button", { name: "Switch to dark theme", exact: true })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({
      path: "docs/screenshots/rag-agent-dark.png",
      fullPage: false,
    });
    await page
      .getByRole("button", { name: "Switch to light theme", exact: true })
      .click();
    await page
      .getByRole("navigation", { name: "Configure sections" })
      .getByRole("button", { name: "Prompt", exact: true })
      .click();
    await page.evaluate(() => {
      document.activeElement?.blur();
      window.scrollTo(0, 350);
    });
    await page.screenshot({
      path: "docs/screenshots/rag-agent-prompt.png",
      fullPage: false,
    });
  }
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
    if (process.env.PRODUCT_SCREENSHOTS) {
      await chat.setViewportSize({ width: 1280, height: 900 });
      await chat.screenshot({
        path: "docs/screenshots/rag-agent-chat.png",
        fullPage: true,
      });
    }
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
  await page.getByLabel("Document files").setInputFiles({
    name: "refund-policy.pdf",
    mimeType: "application/pdf",
    buffer: pdfFixture("Refunds within 30 days"),
  });
  await page
    .getByRole("button", { name: "Start uploads", exact: true })
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

  await page
    .getByRole("button", { name: "Ingest website", exact: true })
    .click();
  await expect(page.getByLabel("Crawler", { exact: true })).toHaveValue(
    "builtin",
  );
  await page.getByLabel("Crawler", { exact: true }).selectOption("firecrawl");
  await expect(
    page.getByLabel("Firecrawl credential", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Crawler", { exact: true }).selectOption("builtin");
  await page
    .getByLabel("Website URL", { exact: true })
    .fill("http://127.0.0.1:4546/website");
  await expect(page.getByLabel("Page limit", { exact: true })).toHaveValue(
    "20",
  );
  await expect(page.getByLabel("Crawl depth", { exact: true })).toHaveValue(
    "2",
  );
  await page
    .getByRole("button", { name: "Start website crawl", exact: true })
    .click();
  const websiteRow = page
    .getByRole("row")
    .filter({ hasText: "http://127.0.0.1:4546/website" });
  await expect(websiteRow.getByText("ready", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await expect(
    websiteRow.getByText("2 pages indexed", { exact: true }),
  ).toBeVisible();
  const websiteGuest = await browser.newContext();
  try {
    const chat = await websiteGuest.newPage();
    await chat.goto("http://localhost:3000" + href);
    await chat
      .getByLabel("Message", { exact: true })
      .fill("What is the website-only refund policy?");
    await chat.getByRole("button", { name: "Send message" }).click();
    await expect(
      chat.getByText("[1] Refund website", { exact: true }),
    ).toBeVisible();
  } finally {
    await websiteGuest.close();
  }
  await page.getByRole("button", { name: "settings", exact: true }).click();
  const advanced = page.getByRole("checkbox", {
    name: "Enable advanced document processing",
    exact: true,
  });
  await expect(advanced).not.toBeChecked();
  await advanced.check();
  await page
    .getByLabel("Target chunk size (tokens)", { exact: true })
    .fill("100");
  await page
    .getByRole("checkbox", { name: "Use LLM-assisted boundaries", exact: true })
    .check();
  await page
    .getByLabel("Processing model", { exact: true })
    .selectOption({ label: "Grounded chat fixture" });
  await page
    .getByRole("checkbox", { name: "Use LLM-assisted boundaries", exact: true })
    .uncheck();
  await page
    .getByRole("checkbox", {
      name: "Expand retrieved passages with parent context",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "Save knowledge settings", exact: true })
    .click();
  await expect(
    page.getByText("Knowledge settings saved", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "sources", exact: true }).click();
  await expect(
    page.getByText("Processing changed · Reingest to apply").first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Upload document", exact: true })
    .click();
  await page.getByLabel("Document files").setInputFiles({
    name: "financial-statement.html",
    mimeType: "text/html",
    buffer: Buffer.from(
      '<main><p>Amounts in USD thousands</p><table><caption>Annual results</caption><tr><th rowspan="2">Metric</th><th colspan="2">Group</th><th colspan="2">Company</th></tr><tr><th>2026</th><th>2025</th><th>2026</th><th>2025</th></tr><tr><td>Revenue</td><td>125,000</td><td>110,000</td><td>80,000</td><td>72,000</td></tr></table></main>',
    ),
  });
  await page
    .getByRole("button", { name: "Start uploads", exact: true })
    .click();
  const financial = page.getByRole("row").filter({
    has: page.getByText("financial-statement.html", { exact: true }),
  });
  await expect(financial.getByText("ready", { exact: true })).toBeVisible({
    timeout: 20000,
  });
  await financial
    .getByRole("button", { name: "Extraction preview", exact: true })
    .click();
  const extracted = page.getByRole("region", {
    name: "Extraction preview",
    exact: true,
  });
  await expect(
    extracted.getByText("Review before publishing", { exact: true }),
  ).toBeVisible();
  await extracted.getByText("Annual results · 1 row", { exact: true }).click();
  await expect(
    extracted.getByText(
      "Columns: Metric | Group / 2026 | Group / 2025 | Company / 2026 | Company / 2025",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(extracted.locator("pre")).toContainText("Group / 2026: 125,000");
  await expect(extracted.locator("pre")).toContainText(
    "Company / 2025: 72,000",
  );
  await expect(extracted.locator("pre")).toContainText(
    "Amounts in USD thousands",
  );
  await page
    .getByRole("button", { name: "Close extraction preview", exact: true })
    .click();
  await page.getByRole("button", { name: "settings", exact: true }).click();
  await expect(advanced).toBeChecked();
  await advanced.uncheck();
  await page
    .getByRole("button", { name: "Save knowledge settings", exact: true })
    .click();
  await expect(
    page.getByText("Knowledge settings saved", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "sources", exact: true }).click();
  await financial
    .getByRole("button", { name: "Extraction preview", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Extraction preview", exact: true })
      .getByText("Review before publishing", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close extraction preview", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Retrieval playground", exact: true })
    .click();
  await page.getByLabel("Retrieval query").fill("Revenue 125,000 2026 Company");
  await page
    .getByRole("button", { name: "Search knowledge", exact: true })
    .click();
  const financialCitation = page.getByText("[1] financial-statement.html", {
    exact: true,
  });
  await expect(financialCitation).toBeVisible();
  await financialCitation.click();
  await expect(
    page.locator(".citations .source-snippet").first(),
  ).toContainText("Group / 2026: 125,000");
  await expect(
    page.locator(".citations .source-snippet").first(),
  ).toContainText("Company / 2025: 72,000");
  expect(generated).toBe(3);
  expect(embedded).toBeGreaterThanOrEqual(4);
  const [message] =
    await sql`SELECT citations FROM messages WHERE workspace_id=${workspace} AND role='assistant' LIMIT 1`;
  expect(message.citations).toHaveLength(1);
  expect(message.citations[0].title).toBe("refund-policy.md");
});

test("AI extraction settings ingest multilingual images and rendered PDF pages with complete table previews", async ({
  page,
  context,
}) => {
  test.setTimeout(180000);
  const budget = await fetch("http://localhost:4000/auth/me");
  if (Number(budget.headers.get("x-ratelimit-remaining") ?? 300) < 150) {
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
  await context.addCookies([
    {
      name: "session",
      value: session,
      url: "http://localhost:3000",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const response = await page.request.post(
    `http://localhost:4000/workspaces/${workspace}/models`,
    {
      headers: { origin: "http://localhost:3000" },
      data: {
        name: "Vision fixture",
        provider: "openai-compatible",
        modelId: "vision-fixture",
        baseUrl: "http://127.0.0.1:4546/v1",
        contextWindow: 32768,
        maxOutputTokens: 8192,
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  const model = await response.json();
  const embeddingResponse = await page.request.post(
    `http://localhost:4000/workspaces/${workspace}/embedding-models`,
    {
      headers: { origin: "http://localhost:3000" },
      data: {
        name: "Multilingual embedding fixture",
        provider: "openai-compatible",
        modelId: "fixture-embeddings",
        baseUrl: "http://127.0.0.1:4546/v1",
        dimensions: 3,
      },
    },
  );
  expect(embeddingResponse.ok(), await embeddingResponse.text()).toBe(true);
  const embeddingModel = await embeddingResponse.json();

  await page.goto(
    `/#view=Knowledge&organization=${org}&workspace=${workspace}`,
  );
  await page
    .getByRole("button", { name: "Create knowledge base", exact: true })
    .click();
  await page.getByLabel("Knowledge base name").fill("Multilingual scans");
  await page
    .getByLabel("Embedding model", { exact: true })
    .selectOption(embeddingModel.id);
  await page
    .getByRole("checkbox", {
      name: "Enable advanced document processing",
      exact: true,
    })
    .check();
  await expect(
    page.getByRole("checkbox", {
      name: "Enable advanced document processing",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "AI document extraction", exact: true }),
  ).toBeVisible({ timeout: 5000 });
  await page
    .getByRole("checkbox", { name: "AI document extraction", exact: true })
    .check();
  await page
    .getByLabel("Vision extraction model", { exact: true })
    .selectOption(model.id);
  await page.getByLabel("Pages to extract").selectOption("all");
  await page.getByLabel("Document languages").fill("Burmese, Thai, English");
  await page.getByLabel("Maximum AI pages per document").fill("5");
  await page
    .getByRole("button", { name: "Save knowledge base", exact: true })
    .click();
  await expect(
    page.getByText("Knowledge base created", { exact: true }),
  ).toBeVisible();
  for (const file of [
    {
      name: "multilingual.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==",
        "base64",
      ),
    },
    {
      name: "multilingual.pdf",
      mimeType: "application/pdf",
      buffer: pdfFixture(
        "Financial statement native text; all-page extraction requested.",
      ),
    },
  ]) {
    await page
      .getByRole("button", { name: "Upload document", exact: true })
      .click();
    await page.getByLabel("Document files").setInputFiles(file);
    await page
      .getByRole("button", { name: "Start uploads", exact: true })
      .click();
    const row = page.getByRole("row").filter({ hasText: file.name });
    await expect(row.getByText("ready", { exact: true })).toBeVisible({
      timeout: 20000,
    });
    await row
      .getByRole("button", { name: "Extraction preview", exact: true })
      .click();
    const preview = page.getByRole("region", { name: "Extraction preview" });
    await expect(
      preview.getByRole("textbox", {
        name: "Block 1 transcription",
        exact: true,
      }),
    ).toHaveValue("မြန်မာ รายงาน");
    await expect(
      preview.getByRole("textbox", {
        name: "Block 2 row 2 column 3",
        exact: true,
      }),
    ).toHaveValue("(900.00)");
    if (file.name.endsWith(".pdf")) {
      const review = page.getByRole("region", {
        name: "Extraction correction workspace",
      });
      await expect(
        review.getByAltText("Original document page 1"),
      ).toBeVisible();
      await expect
        .poll(() =>
          review
            .getByAltText("Original document page 1")
            .evaluate((image) => image.naturalWidth),
        )
        .toBeGreaterThan(0);
      const removeRow = review.getByRole("button", {
        name: "Remove row 1",
        exact: true,
      });
      await expect(removeRow).toHaveCSS("white-space", "nowrap");
      await review
        .getByLabel("Original page zoom", { exact: true })
        .press("ArrowRight");
      await expect(review.getByAltText("Original document page 1")).toHaveCSS(
        "max-width",
        "none",
      );
      await review
        .getByRole("button", { name: "Pad missing cells", exact: true })
        .click();
      await expect(
        review.getByLabel("Block 2 row 3 column 3", { exact: true }),
      ).toHaveValue("");
      const before = visionCalls;
      expect(before).toBeGreaterThan(0);
      await review
        .getByLabel("Block 2 row 2 column 3", { exact: true })
        .fill("(950.00)");
      await expect(review.getByRole("status")).toHaveText(
        "Unsaved corrections",
      );
      await page.screenshot({
        path: "/tmp/document-review-desktop.png",
        fullPage: true,
      });
      await review
        .getByRole("button", {
          name: "Save correction and reindex",
          exact: true,
        })
        .click();
      await expect
        .poll(
          async () => {
            const [source] =
              await sql`SELECT revision,status FROM knowledge_sources WHERE workspace_id=${workspace} AND filename=${file.name}`;
            return `${source.revision}:${source.status}`;
          },
          { timeout: 20000 },
        )
        .toBe("2:ready");
      await expect(row.getByText("ready", { exact: true })).toBeVisible({
        timeout: 20000,
      });
      expect(visionCalls).toBe(before);
      await row
        .getByRole("button", { name: "Extraction preview", exact: true })
        .click();
      await expect(
        page.getByLabel("Block 2 row 2 column 3", { exact: true }),
      ).toHaveValue("(950.00)");
      await expect(
        page.getByText("Correction history", { exact: true }),
      ).toBeVisible();
      await page.setViewportSize({ width: 390, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: "/tmp/document-review-mobile.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await page
      .getByRole("button", { name: "Close extraction preview", exact: true })
      .click();
    await row
      .getByRole("button", { name: "Usage & traces", exact: true })
      .click();
    await page.getByText("Extraction usage & tracing", { exact: true }).click();
    await expect(page.locator(".extraction-usage")).toContainText(
      "model attempts",
    );
    await expect(page.locator(".extraction-usage")).toContainText(
      file.name.endsWith(".pdf") ? "reused" : "completed",
    );
    await page.setViewportSize({ width: 390, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "/tmp/extraction-usage-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page
      .getByRole("button", { name: "Close usage", exact: true })
      .click();
  }
  await page.getByRole("button", { name: "settings", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "AI document extraction", exact: true }),
  ).toBeChecked();
  await expect(page.getByLabel("Document languages")).toHaveValue(
    "Burmese, Thai, English",
  );
  await page.setViewportSize({ width: 390, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  const [kbRow] =
    await sql`SELECT id FROM knowledge_bases WHERE workspace_id=${workspace} AND name='Multilingual scans'`;
  const [sourceRow] =
    await sql`SELECT id FROM knowledge_sources WHERE knowledge_base_id=${kbRow.id} AND filename='multilingual.pdf'`;
  const modelResponse = await page.request.post(
    `http://localhost:4000/workspaces/${workspace}/models`,
    {
      headers: { origin: "http://localhost:3000" },
      data: {
        name: "Financial benchmark engine",
        provider: "openai-compatible",
        modelId: "financial-benchmark",
        baseUrl: "http://127.0.0.1:4546/v1",
        contextWindow: 32768,
        maxOutputTokens: 1024,
      },
    },
  );
  expect(modelResponse.ok(), await modelResponse.text()).toBe(true);
  const benchmarkAgent = await page.request.post(
    `http://localhost:4000/workspaces/${workspace}/agents`,
    {
      headers: { origin: "http://localhost:3000" },
      data: {
        name: "Financial benchmark agent",
        config: {
          modelId: (await modelResponse.json()).id,
          rag: {
            knowledgeBaseIds: [kbRow.id],
            usageMode: "always",
            topK: 10,
            minScore: 0,
          },
        },
      },
    },
  );
  expect(benchmarkAgent.ok(), await benchmarkAgent.text()).toBe(true);
  const agent = await benchmarkAgent.json();
  const evaluationBudget = await fetch("http://localhost:4000/auth/me");
  if (
    Number(evaluationBudget.headers.get("x-ratelimit-remaining") ?? 300) < 100
  )
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(
          59000,
          Number(
            evaluationBudget.headers.get("retry-after") ??
              evaluationBudget.headers.get("x-ratelimit-reset") ??
              60,
          ) *
            1000 +
            500,
        ),
      ),
    );
  await page.getByRole("button", { name: "Quality", exact: true }).click();
  await page.getByRole("button", { name: "New dataset", exact: true }).click();
  await page.getByLabel("Dataset name").fill("Verified financial benchmark");
  await page
    .getByText("Add a real-document benchmark case", { exact: true })
    .click();
  await page.getByLabel("Benchmark knowledge base").selectOption(kbRow.id);
  await page.getByLabel("Benchmark source").selectOption(sourceRow.id);
  await page
    .getByLabel("Benchmark question")
    .fill("What is the reported revenue?");
  await page.getByLabel("Required answer text (optional)").fill("(950.00)");
  await page
    .getByRole("button", { name: "Add expected cell", exact: true })
    .click();
  await page.getByLabel("Expected cell 1 row", { exact: true }).fill("2");
  await page.getByLabel("Expected cell 1 column", { exact: true }).fill("3");
  await page
    .getByLabel("Expected cell 1 value", { exact: true })
    .fill("(950.00)");
  await page.getByLabel("Benchmark tags").fill("financial, multilingual");
  await page
    .getByRole("button", { name: "Add benchmark case to dataset", exact: true })
    .click();
  await page.getByRole("button", { name: "Save dataset", exact: true }).click();
  await expect(page.getByText("Dataset saved.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Evaluation", exact: true }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption(agent.id);
  await page
    .getByRole("button", { name: "Run evaluation", exact: true })
    .click();
  await expect(page.getByText(/Run .* · completed/)).toBeVisible({
    timeout: 20000,
  });
  await expect(page.getByText(/Exact cell accuracy: 100.0%/)).toBeVisible();
  await expect(
    page.getByText(/Expected citation coverage: 100.0%/),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/document-benchmark-results.png",
    fullPage: true,
  });
});

test("Financial calculator setup supports progressive help and explicit evidence policy", async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: "session", value: session, domain: "localhost", path: "/" },
  ]);
  await page.goto("/");
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("button", { name: "Tool setup", exact: true }).click();
  await page
    .getByLabel("Name", { exact: true })
    .fill("Verified statement calculator");
  await page.getByLabel("Tool type", { exact: true }).selectOption("financial");
  await page
    .getByLabel("Description for the agent")
    .fill("Calculate sums and revenue changes from financial statements.");
  await expect(
    page.getByRole("checkbox", { name: /Require retrieved evidence/ }),
  ).toBeChecked();
  await expect(page.getByLabel("Encrypted credential")).toBeHidden();
  await page
    .getByRole("checkbox", { name: /I verified this integration/ })
    .check();
  await page
    .getByRole("button", { name: "Register tool", exact: true })
    .click();
  await expect(
    page.getByText("Tool registered. Attach it in an agent's configuration.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/financial-tool-setup.png",
    fullPage: true,
  });
});
