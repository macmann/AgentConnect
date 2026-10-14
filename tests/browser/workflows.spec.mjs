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
  if (data.model === "research")
    await new Promise((resolve) => setTimeout(resolve, 4000));
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
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
    "href",
    "/agent-connex-icon-light.svg",
  );
  const favicon = await page.request.get("/agent-connex-icon-light.svg");
  expect(favicon.ok()).toBe(true);
  expect(await favicon.text()).not.toContain("<text");
  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  await page.getByRole("button", { name: "Create workflow" }).click();
  await page.getByRole("button", { name: "Open canvas directly" }).click();
  await page.getByLabel("Workflow name", { exact: true }).fill("Launch review");
  await page.getByRole("button", { name: "Two-agent review template" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(5);
  const canvasWarnings = [];
  page.on("console", (message) => {
    if (message.text().includes("not initialized"))
      canvasWarnings.push(message.text());
  });
  const researchNode = page.locator('.react-flow__node[data-id="research"]');
  await researchNode.scrollIntoViewIfNeeded();
  const beforeDrag = await researchNode.getAttribute("style");
  for (let i = 0; i < 2; i++) {
    const box = await researchNode.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + 35,
      box.y + box.height / 2 + 30,
      { steps: 10 },
    );
    await page.mouse.up();
  }
  await expect(researchNode).not.toHaveAttribute("style", beforeDrag);
  expect(canvasWarnings).toEqual([]);

  await page
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  await page.getByRole("button", { name: "Validate workflow" }).click();
  await expect(
    page.getByText("Workflow is valid and its dependencies are available.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("button", { name: "Publish workflow" }).click();
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await page
    .getByRole("button", { name: "Test Workflow", exact: true })
    .click();
  await page.getByLabel("Run version").selectOption({ label: "Published v1" });
  await page
    .getByLabel("Workflow input", { exact: true })
    .fill("Assess our launch plan");
  await page.getByRole("button", { name: "Run workflow", exact: true }).click();
  await expect(
    page.locator(".workflow-node.kind-agent.status-running"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "＋ Add nodes", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Return to draft canvas", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".react-flow__node.draggable")).toHaveCount(0);
  await expect(page.locator(".react-flow__handle.connectable")).toHaveCount(0);
  const animation = await page
    .locator(".workflow-node.kind-agent.status-running")
    .evaluate((el) => getComputedStyle(el).animationName);
  expect(animation).toBe("workflow-active");
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
  await page.setViewportSize({ width: 1280, height: 720 });
  await page
    .getByRole("button", { name: "Return to draft canvas", exact: true })
    .click();
  await page.getByRole("button", { name: "Run workflow", exact: true }).click();
  await expect(
    page.locator(".workflow-node.kind-agent.status-running"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel workflow run", exact: true })
    .click();
  await expect(page.getByTestId("workflow-run-status")).toHaveText(
    "cancelled",
    { timeout: 15000 },
  );
  await expect(page.locator(".workflow-node.status-running")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Return to draft canvas", exact: true }),
  ).toBeEnabled();
});

test("guided creation preserves choices, saves a real draft and keeps edits across activities", async ({
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
  await page
    .getByRole("button", { name: "Create workflow", exact: true })
    .click();
  await page
    .getByLabel("Workflow name", { exact: true })
    .fill("Guided customer answer");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeDisabled();
  const select = page.getByLabel("Prepare answer", { exact: true });
  const version = await select.locator("option").nth(1).getAttribute("value");
  await select.selectOption(version);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Review Guided customer answer" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(select).toHaveValue(version);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  await expect(
    page.getByText("Workflow draft saved. Test it before publishing.", {
      exact: true,
    }),
  ).toBeVisible();
  const [stored] =
    await sql`SELECT draft_graph FROM workflows WHERE workspace_id=${workspace} AND name='Guided customer answer'`;
  expect(
    stored.draft_graph.nodes.find((n) => n.type === "agent").data
      .agentVersionId,
  ).toBe(version);
  await expect(page.locator(".workflow-node.kind-input")).toHaveCSS(
    "border-radius",
    "48px",
  );
  await expect(
    page.locator(".workflow-node.kind-agent .workflow-node-icon"),
  ).toBeVisible();
  await page
    .getByLabel("Workflow name", { exact: true })
    .fill("Unsaved renamed workflow");
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Run workflow", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Build", exact: true }).click();
  await expect(page.getByLabel("Workflow name", { exact: true })).toHaveValue(
    "Unsaved renamed workflow",
  );
  await page
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  await expect(
    page.getByText("Workflow draft saved.", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("node types use distinct shapes and Test mode cannot edit the graph", async ({
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
  await page
    .getByRole("button", { name: "Create workflow", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open canvas directly", exact: true })
    .click();
  for (const kind of ["condition", "tool", "merge"]) {
    await page
      .getByRole("button", { name: "＋ Add nodes", exact: true })
      .click();
    await page
      .getByRole("button", { name: `Add ${kind}`, exact: true })
      .click();
    await expect(
      page.locator(`.workflow-node.kind-${kind}`).last(),
    ).toBeVisible();
  }
  await expect(
    page.locator(".workflow-node.kind-condition .react-flow__handle"),
  ).toHaveCount(3);
  await expect(page.locator(".workflow-node.kind-condition")).not.toHaveCSS(
    "transform",
    "rotate(45deg)",
  );
  const diamond = await page
    .locator(".workflow-node.kind-condition")
    .evaluate((el) => getComputedStyle(el, "::before").transform);
  expect(diamond).not.toBe("none");
  await expect(page.locator(".workflow-node.kind-tool")).toHaveCSS(
    "border-top-right-radius",
    "22px",
  );
  await expect(page.locator(".workflow-node.kind-merge").last()).toHaveCSS(
    "border-style",
    "dashed",
  );
  // Duplicate labels cannot safely identify a single node from an analyzer message.
  await expect(
    page
      .locator(".workflow-validation")
      .getByRole("button", { name: /^Merge:/ }),
  ).toHaveCount(0);
  await page
    .locator(".workflow-validation")
    .getByRole("button", {
      name: "Tool: select a registered tool",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "tool configuration", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/workflow-node-types.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(page.locator(".workflow-properties")).toBeHidden();
  await expect(page.locator(".react-flow__node.draggable")).toHaveCount(0);
  const count = await page.locator(".react-flow__node").count();
  await page.keyboard.press("Control+v");
  await expect(page.locator(".react-flow__node")).toHaveCount(count);
});

test("canvas palette drops at transformed coordinates and expanded testing stays inside the canvas", async ({
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
  await page
    .getByRole("button", { name: "Create workflow", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open canvas directly", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Expand canvas", exact: true })
    .click();
  const expanded = page.getByRole("dialog", {
    name: "Expanded workflow canvas",
  });
  await expect(expanded).toBeVisible();
  expect(
    await page
      .getByRole("button", {
        name: "Workflows",
        exact: true,
        includeHidden: true,
      })
      .evaluate((el) => !!el.closest("[inert]")),
  ).toBe(true);
  await expanded
    .getByRole("button", { name: "＋ Add nodes", exact: true })
    .click();
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await expanded
    .getByRole("button", { name: "Add tool", exact: true })
    .dispatchEvent("dragstart", { dataTransfer: transfer });
  const area = await expanded.locator(".workflow-canvas").boundingBox();
  const x = area.x + area.width * 0.6,
    y = area.y + area.height * 0.55;
  const expected = await expanded.locator(".react-flow").evaluate(
    (el, point) => {
      const root = el.getBoundingClientRect();
      const matrix = new DOMMatrix(
        getComputedStyle(el.querySelector(".react-flow__viewport")).transform,
      );
      return {
        x: Math.round((point.x - root.x - matrix.e) / matrix.a / 20) * 20,
        y: Math.round((point.y - root.y - matrix.f) / matrix.d / 20) * 20,
      };
    },
    { x, y },
  );
  const before = await expanded.locator(".react-flow__node").count();
  await expanded
    .locator(".workflow-canvas")
    .dispatchEvent("drop", { dataTransfer: transfer, clientX: x, clientY: y });
  await expect(expanded.locator(".react-flow__node")).toHaveCount(before + 1);
  await expect(expanded.locator(".workflow-node.kind-tool")).toBeVisible();
  await expanded
    .getByRole("button", { name: "＋ Add nodes", exact: true })
    .click();
  await expanded
    .getByRole("button", { name: "Test Workflow", exact: true })
    .click();
  await expect(
    expanded.getByRole("region", { name: "Workflow test panel" }),
  ).toBeVisible();
  await expect(
    expanded.getByLabel("Workflow input", { exact: true }),
  ).toBeVisible();
  await expect(
    expanded.getByRole("button", { name: "Run workflow", exact: true }),
  ).toBeDisabled(); // unsaved draft
  await expanded.getByText("Workflow details", { exact: true }).click();
  await expanded
    .getByLabel("Draft name", { exact: true })
    .fill("Canvas drop draft");
  await expanded
    .getByRole("button", { name: "Save draft", exact: true })
    .click();
  await expect(
    expanded.getByRole("button", { name: "Save draft", exact: true }),
  ).toBeDisabled();
  await expect(
    expanded.getByRole("status", { name: "Draft save status" }),
  ).toHaveText("Saved");
  const [savedDrop] =
    await sql`SELECT draft_graph FROM workflows WHERE workspace_id=${workspace} AND name='Canvas drop draft'`;
  const dropped = savedDrop.draft_graph.nodes.find((n) => n.type === "tool");
  expect(dropped.position.x).toBeCloseTo(expected.x, 0);
  expect(dropped.position.y).toBeCloseTo(expected.y, 0);
  await page.keyboard.press("Escape");
  await expect(expanded).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Expand canvas", exact: true }),
  ).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Expand canvas", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Exit expanded view", exact: true })
    .click();
});
