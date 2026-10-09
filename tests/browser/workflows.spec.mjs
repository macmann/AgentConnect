import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
import { PostgresSaver } from "../../apps/api/node_modules/@langchain/langgraph-checkpoint-postgres/dist/index.js";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const org = randomUUID(),
  workspace = randomUUID(),
  user = randomUUID(),
  session = randomUUID();
const calls = [];
const fixture = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const data = JSON.parse(raw);
  calls.push(data);
  const text =
    data.model === "research"
      ? "Research findings: assess the proposed launch."
      : "Final report: " + data.messages.at(-1).content;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    "data: " +
      JSON.stringify({
        choices: [{ delta: { content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      }) +
      "\n\ndata: [DONE]\n\n",
  );
});
async function api(path, body) {
  const res = await fetch("http://localhost:4000" + path, {
    method: "POST",
    headers: {
      cookie: "session=" + session,
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  expect(res.ok, JSON.stringify(data)).toBe(true);
  return data;
}
test.beforeAll(async () => {
  const health = await fetch("http://localhost:4000/health/live");
  if (
    health.status === 429 ||
    Number(health.headers.get("x-ratelimit-remaining") ?? 300) < 150
  ) {
    const reset = Number(
      health.headers.get("retry-after") ??
        health.headers.get("x-ratelimit-reset") ??
        1,
    );
    await new Promise((r) =>
      setTimeout(r, Math.min(59000, Math.max(1000, reset * 1000 + 500))),
    );
  }
  await new Promise((r) => fixture.listen(4548, "127.0.0.1", r));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${user},${user + "@example.com"},'Workflow Builder','unused-fixture',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(session).digest("hex")},${user},now()+interval '1 hour')`;
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Browser workflows')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Workflow workspace')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${user},'owner')`;
  });
  for (const [name, modelId] of [
    ["Research", "research"],
    ["Writer", "writer"],
  ]) {
    const m = await api(`/workspaces/${workspace}/models`, {
      name,
      provider: "openai-compatible",
      modelId,
      baseUrl: "http://127.0.0.1:4548/v1",
    });
    const a = await api(`/workspaces/${workspace}/agents`, {
      name,
      config: { modelId: m.id },
    });
    await api(`/agents/${a.id}/publish`, { revision: 1 });
  }
});
test.afterAll(async () => {
  fixture.closeAllConnections();
  await new Promise((r) => fixture.close(r));
  const runs =
    await sql`SELECT id FROM workflow_runs WHERE workspace_id=${workspace}`;
  if (runs.length) {
    const saver = PostgresSaver.fromConnString(process.env.DATABASE_URL, {
      schema: "workflow_checkpoints",
    });
    for (const run of runs) await saver.deleteThread(run.id);
    await saver.end();
  }
  await sql.begin(async (tx) => {
    for (const table of [
      "audit_events",
      "tool_executions",
      "workflow_approvals",
      "workflow_node_runs",
      "workflow_runs",
      "workflow_versions",
      "workflows",
      "agent_versions",
      "agents",
      "model_configurations",
      "memberships",
      "workspaces",
      "organizations",
    ])
      await tx.unsafe(
        `DELETE FROM ${table} WHERE ${table === "organizations" ? "id" : "organization_id"}=$1`,
        [org],
      );
    await tx`DELETE FROM sessions WHERE user_id=${user}`;
    await tx`DELETE FROM users WHERE id=${user}`;
  });
  await sql.end();
});
test("Visual workflow publishes, pauses for review and resumes two agent handoffs", async ({
  page,
  context,
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
  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  await page.getByRole("button", { name: "Create workflow" }).click();
  await page.getByLabel("Workflow name", { exact: true }).fill("Launch review");
  await page.getByRole("button", { name: "Two-agent review template" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(5);
  await page
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  await page.getByRole("button", { name: "Validate workflow" }).click();
  await expect(
    page.getByText("Workflow is valid and its dependencies are available.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Publish workflow" }).click();
  await page.getByLabel("Run version").selectOption({ label: "Published v1" });
  await page
    .getByLabel("Workflow input", { exact: true })
    .fill("Assess our launch plan");
  await page.getByRole("button", { name: "Run workflow", exact: true }).click();
  const inspector = page.getByLabel("Workflow run inspector");
  await expect(inspector.getByText("waiting", { exact: true })).toBeVisible();
  await page
    .getByLabel("Edited input (optional JSON)")
    .fill('"Reviewed findings"');
  await page.getByRole("button", { name: "Approve and resume" }).click();
  await expect(
    inspector.getByText("completed", { exact: true }).first(),
  ).toBeVisible();
  await expect(inspector).toContainText("Final report: Reviewed findings");
  await expect(page.locator(".react-flow__node")).toHaveCount(5);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  expect(calls.map((c) => c.model)).toEqual(["research", "writer"]);
  await page.screenshot({
    path: "test-results/workflow-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/workflow-mobile.png",
    fullPage: true,
  });
});
