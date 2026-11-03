import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const sql = postgres(process.env.DATABASE_URL, { max: 1 }),
  org = randomUUID(),
  workspace = randomUUID(),
  users = {},
  sessions = {};
const schema = {
  type: "object",
  properties: { query: { type: "string" } },
  required: ["query"],
  additionalProperties: false,
};
const fixture = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const m = JSON.parse(raw);
  if (m.id === undefined) {
    res.writeHead(202).end();
    return;
  }
  const result =
    m.method === "initialize"
      ? {
          protocolVersion: m.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "Template fixture", version: "1" },
        }
      : m.method === "tools/list"
        ? {
            tools: [
              {
                name: "search",
                description: "Search fixture data",
                inputSchema: schema,
                annotations: { readOnlyHint: true },
              },
              {
                name: "lookup",
                description: "Look up fixture records",
                inputSchema: schema,
                annotations: { readOnlyHint: true },
              },
            ],
          }
        : m.method === "tools/call"
          ? { content: [{ type: "text", text: "Fixture answer" }] }
          : {};
  res
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
});
test.beforeAll(async () => {
  await new Promise((r) => fixture.listen(4548, "127.0.0.1", r));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES(${org},'Tool setup browser')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES(${workspace},${org},'Tool wizard')`;
    for (const role of ["owner", "builder"]) {
      users[role] = randomUUID();
      sessions[role] = randomUUID();
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES(${users[role]},${users[role] + "@example.invalid"},${role},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(${createHash("sha256").update(sessions[role]).digest("hex")},${users[role]},now()+interval '1 hour')`;
      await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES(${randomUUID()},${org},${role === "owner" ? null : workspace},${users[role]},${role})`;
    }
  });
});
test.afterAll(async () => {
  fixture.closeAllConnections();
  await new Promise((r) => fixture.close(r));
  await sql.begin(async (tx) => {
    for (const table of [
      "tool_executions",
      "tools",
      "mcp_connectors",
      "secrets",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    for (const user of Object.values(users)) {
      await tx`DELETE FROM sessions WHERE user_id=${user}`;
      await tx`DELETE FROM users WHERE id=${user}`;
    }
  });
  await sql.end();
});
async function open(page, context, role = "owner", view = "Connections") {
  await context.addCookies([
    {
      name: "session",
      value: sessions[role],
      url: "http://localhost:3000",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("about:blank");
  await page.goto(`/#view=${view}&organization=${org}&workspace=${workspace}`);
  await expect(
    page.getByRole("heading", { name: view, exact: true }).last(),
  ).toBeVisible();
}
test("Connections opens a clean registry; templates save directly and custom MCP discovers multiple agent tools", async ({
  page,
  context,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, context);
  await expect(page.getByText("No tools connected yet")).toBeVisible();
  await expect(page.getByLabel("Tool name", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Add tools", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Add tools" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Code executor/ }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("tool-templates.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: /Financial calculator/ }).click();
  await page.getByLabel("Tool name", { exact: true }).fill("Finance helper");
  await page.getByRole("button", { name: "Validate & continue" }).click();
  await expect(page.getByText("Review discovered tools")).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByLabel("Tool name", { exact: true })).toHaveValue(
    "Finance helper",
  );
  await page.getByRole("button", { name: "Validate & continue" }).click();
  await page.getByRole("checkbox", { name: /I reviewed/ }).check();
  await page.getByRole("button", { name: "Save tool", exact: true }).click();
  await expect(page.getByText("Finance helper", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add tools", exact: true }).click();
  await page.getByRole("button", { name: /MCP server HTTP or STDIO/ }).click();
  await page.getByLabel("Tool name", { exact: true }).fill("Support");
  await page
    .getByRole("combobox", { name: "Transport", exact: true })
    .selectOption("stdio");
  await expect(
    page.getByRole("combobox", {
      name: "Installed server profile",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Transport", exact: true })
    .selectOption("http");
  await page
    .getByLabel("Server URL", { exact: true })
    .fill("http://127.0.0.1:4548/mcp");
  await page
    .getByLabel("API key / token", { exact: true })
    .fill("browser-test-key");
  await page.getByRole("button", { name: "Validate & continue" }).click();
  await expect(
    page.getByText("Search fixture data", { exact: true }),
  ).toBeVisible();
  const [count] =
    await sql`SELECT count(*)::int AS n FROM secrets WHERE workspace_id=${workspace}`;
  expect(count.n).toBe(0);
  await page.getByRole("checkbox", { name: /I reviewed/ }).check();
  await page.getByRole("button", { name: "Save 2 tools", exact: true }).click();
  await expect(
    page.getByText("Support · search", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Support · lookup", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search tools", { exact: true }).fill("Support");
  await expect(page.locator(".tools-registry-table tbody tr")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Actions for Support · search", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Edit tool", exact: true }).click();
  await page
    .getByLabel("Tool name", { exact: true })
    .fill("Support search updated");
  await page.getByRole("button", { name: "Save tool", exact: true }).click();
  await expect(
    page.getByText("Support search updated", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Actions for Support search updated",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Disable", exact: true }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "Support search updated" }),
  ).toContainText("Disabled");
  await page.screenshot({
    path: info.outputPath("tools-registry.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  await page.getByRole("button", { name: "Add tools", exact: true }).click();
  expect(
    await page
      .getByRole("dialog")
      .evaluate((el) => el.getBoundingClientRect().width <= innerWidth),
  ).toBeTruthy();
  await page.screenshot({
    path: info.outputPath("tool-wizard-mobile.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("OpenAPI reports invalid input and preserves the draft; builders can view the registry but cannot add tools", async ({
  page,
  context,
}) => {
  await open(page, context);
  await page.getByRole("button", { name: "Add tools", exact: true }).click();
  await page.getByRole("button", { name: /API \/ OpenAPI/ }).click();
  await page.getByLabel("Tool name", { exact: true }).fill("My API");
  await page
    .getByRole("combobox", { name: "Credential", exact: true })
    .selectOption("none");
  await page
    .getByLabel("OpenAPI specification", { exact: true })
    .fill("not a spec");
  await page.getByRole("button", { name: "Validate & continue" }).click();
  await expect(page.getByRole("alert")).toContainText("valid OpenAPI");
  await expect(page.getByLabel("Tool name", { exact: true })).toHaveValue(
    "My API",
  );
  await page.getByRole("button", { name: "Close tool setup" }).click();
  await open(page, context, "builder", "Tools");
  await expect(
    page.getByRole("button", { name: "Add tools", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Search tools")).toBeVisible();
});
