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
      "tools",
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
  await page.getByRole("button", { name: /Manual setup/ }).click();
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
  await expect(page.getByLabel("Current workflow")).toContainText(
    "Launch review",
  );
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
  await page.getByRole("button", { name: /Manual setup/ }).click();
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
  ).toBeEnabled();
  await page.getByRole("button", { name: "Run workflow", exact: true }).click();
  await expect(
    page.getByText("Save your draft changes before testing.", { exact: true }),
  ).toBeVisible();
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
  await page.getByRole("button", { name: /Manual setup/ }).click();
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
  ).toHaveCount(6);
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
  await page.getByRole("button", { name: /Manual setup/ }).click();
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
  const toolbarBounds = await expanded
    .locator(".canvas-controls")
    .boundingBox();
  const testBounds = await expanded.locator(".canvas-test-panel").boundingBox();
  expect(testBounds.y).toBeGreaterThanOrEqual(
    toolbarBounds.y + toolbarBounds.height,
  );

  await expect(
    expanded.getByRole("button", { name: "Run workflow", exact: true }),
  ).toBeEnabled();
  await expanded
    .getByRole("button", { name: "Run workflow", exact: true })
    .click();
  await expect(
    expanded.getByText("Unable to test workflow", { exact: true }),
  ).toBeVisible();
  await expect(
    expanded.getByText("Save your workflow before testing.", { exact: true }),
  ).toBeVisible();
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

test("Reusable components save selected nodes, insert versioned copies, and preserve drafts", async ({
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
  await page.getByRole("button", { name: /Manual setup/ }).click();
  await page
    .getByRole("button", { name: "Open canvas directly", exact: true })
    .click();
  await page
    .getByLabel("Workflow name", { exact: true })
    .fill("Component workflow");
  await page
    .getByRole("button", { name: "Two-agent review template", exact: true })
    .click();
  const research = page.locator('.react-flow__node[data-id="research"]');
  await research.click();
  const library = page.locator(".workflow-component-library");
  await library.locator("summary").click();
  await library
    .getByLabel("Component name", { exact: true })
    .fill("Reusable research");
  await library
    .getByRole("button", { name: "Save selection as component", exact: true })
    .click();
  await expect(library.getByRole("status")).toContainText("Component v1 saved");
  await page.locator('.react-flow__node[data-id="input"]').click();
  await library
    .getByRole("button", { name: "Insert after selected node", exact: true })
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(6);
  await expect(library.getByRole("status")).toContainText("Component inserted");
  const copy = page.locator('.react-flow__node[data-id^="c"]');
  await copy.click();
  await library
    .getByRole("button", { name: "Save selection as new version", exact: true })
    .click();
  await expect(library.getByRole("status")).toContainText("Component v2 saved");
  await library
    .getByRole("combobox", { name: "Component version", exact: true })
    .selectOption("1");
  await page.locator('.react-flow__node[data-id="input"]').click();
  await library
    .getByRole("button", { name: "Insert after selected node", exact: true })
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(7);
  await page
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  await expect(
    page.getByText("Workflow draft saved.", { exact: true }),
  ).toBeVisible();
  const [saved] =
    await sql`SELECT draft_graph FROM workflows WHERE workspace_id=${workspace} AND name='Component workflow'`;
  expect(saved.draft_graph.nodes).toHaveLength(7);
  const [component] =
    await sql`SELECT revision FROM workflow_components WHERE workspace_id=${workspace} AND name='Reusable research'`;
  expect(component.revision).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/workflow-components-mobile.png",
    fullPage: true,
  });
});

test("workflow agents are created in a contained, minimizable canvas drawer", async ({
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
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  await page
    .getByRole("button", { name: "Create workflow", exact: true })
    .click();
  await page.getByRole("button", { name: /Manual setup/ }).click();
  await page
    .getByRole("button", { name: "Open canvas directly", exact: true })
    .click();
  await page
    .getByLabel("Workflow name", { exact: true })
    .fill("Canvas-owned agent");
  await page
    .getByRole("button", { name: "Expand canvas", exact: true })
    .click();
  const canvas = page.getByRole("dialog", { name: "Expanded workflow canvas" });
  await canvas
    .getByRole("button", { name: "＋ Add nodes", exact: true })
    .click();
  await canvas.getByRole("button", { name: "Add agent", exact: true }).click();
  const drawer = canvas.locator(".workflow-properties");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByLabel("Agent source")).toHaveValue("workflow");

  await drawer
    .getByLabel("Runtime model", { exact: true })
    .selectOption({ label: "Research" });
  await drawer
    .getByLabel("Agent task prompt", { exact: true })
    .fill("Summarize the research for the workflow.");
  const bounds = await canvas.boundingBox();
  const panel = await drawer.boundingBox();
  expect(panel.x).toBeGreaterThanOrEqual(bounds.x);
  expect(panel.y + panel.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  const toggle = canvas.getByRole("button", { name: "Minimize canvas panel" });
  const toggleBounds = await toggle.boundingBox();
  expect(toggleBounds.y + toggleBounds.height).toBeLessThanOrEqual(panel.y);
  await toggle.click();
  await expect(drawer).toBeHidden();
  await canvas.getByRole("button", { name: "Restore canvas panel" }).click();
  await expect(
    drawer.getByLabel("Agent task prompt", { exact: true }),
  ).toHaveValue("Summarize the research for the workflow.");
  await expect(drawer.getByRole("button", { name: /AI mode/ })).toHaveCount(0);
  const kbPicker = drawer.getByRole("region", {
    name: "Knowledge bases",
    exact: true,
  });
  await expect(kbPicker).toContainText("No knowledge bases available.");
  await expect(
    kbPicker.getByRole("link", {
      name: "Create knowledge base ↗",
      exact: true,
    }),
  ).toHaveAttribute("target", "_blank");
  const toolPicker = drawer.getByRole("region", { name: "Tools", exact: true });
  await expect(toolPicker).toContainText("No enabled tools available.");
  await drawer.getByLabel("Also make a reusable copy in Agents").check();
  await drawer.getByRole("button", { name: "Save copy to Agents" }).click();
  await expect(drawer.getByRole("status")).toContainText(
    "Saved a reusable draft",
  );
  await canvas.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    canvas.getByRole("status", { name: "Draft save status" }),
  ).toHaveText("Saved");
  const [stored] =
    await sql`SELECT draft_graph FROM workflows WHERE workspace_id=${workspace} AND name='Canvas-owned agent'`;
  const embedded = stored.draft_graph.nodes.find((n) => n.type === "agent");
  expect(embedded.data.inlineAgent.prompt.instructions).toBe(
    "Summarize the research for the workflow.",
  );
  expect(embedded.data.agentVersionId).toBeUndefined();
  const toolbar = await canvas.locator(".canvas-controls").boundingBox();
  expect(toolbar.height).toBeLessThan(80);
  await canvas
    .getByRole("button", { name: "Test Workflow", exact: true })
    .click();
  const testing = canvas.getByRole("region", { name: "Workflow test panel" });
  await expect(testing).toBeVisible();
  await canvas.getByRole("button", { name: "Minimize canvas panel" }).click();
  await expect(testing).toBeHidden();
  await canvas.getByRole("button", { name: "Restore canvas panel" }).click();
  await expect(testing).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await canvas.boundingBox();
  const narrowPanel = await testing.boundingBox();
  expect(narrowPanel.x).toBeGreaterThanOrEqual(narrow.x);
  expect(narrowPanel.x + narrowPanel.width).toBeLessThanOrEqual(
    narrow.x + narrow.width,
  );
  expect(narrowPanel.y + narrowPanel.height).toBeLessThanOrEqual(
    narrow.y + narrow.height,
  );
  await page.screenshot({ path: "/tmp/workflow-canvas-mobile.png" });
  await testing.getByRole("button", { name: "Close test panel" }).click();
  await expect(drawer).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await canvas
    .getByRole("button", { name: "Exit expanded view", exact: true })
    .click();
  const normalCanvas = await page.locator(".workflow-canvas").boundingBox();
  const normalPanel = await page.locator(".workflow-properties").boundingBox();
  expect(normalPanel.y).toBeGreaterThanOrEqual(normalCanvas.y);
  expect(normalPanel.y + normalPanel.height).toBeLessThanOrEqual(
    normalCanvas.y + normalCanvas.height,
  );
});

test("canvas attachments support search, multiple additions and tool configuration links", async ({
  page,
  context,
}) => {
  const resourceIds = [randomUUID(), randomUUID()];
  const toolIds = [];
  for (const name of ["Canvas calculator", "Canvas comparison"]) {
    toolIds.push(
      (
        await api(`/workspaces/${workspace}/tools`, {
          name,
          description: "Workflow attachment fixture",
          config: { kind: "financial" },
          readOnlyAcknowledged: true,
        })
      ).id,
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
  await page.route(`**/workspaces/${workspace}/knowledge-bases`, (route) =>
    route.fulfill({
      json: [
        { id: resourceIds[0], name: "Product handbook" },
        { id: resourceIds[1], name: "Support policies" },
      ],
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  await page
    .getByRole("button", { name: "Create workflow", exact: true })
    .click();
  await page.getByRole("button", { name: /Manual setup/ }).click();
  await page
    .getByRole("button", { name: "Open canvas directly", exact: true })
    .click();
  await page
    .getByLabel("Workflow name", { exact: true })
    .fill("Attachment workflow");
  await page
    .getByRole("button", { name: "Expand canvas", exact: true })
    .click();
  const canvas = page.getByRole("dialog", { name: "Expanded workflow canvas" });
  await canvas
    .getByRole("button", { name: "＋ Add nodes", exact: true })
    .click();
  await canvas.getByRole("button", { name: "Add agent", exact: true }).click();
  const drawer = canvas.locator(".workflow-properties");
  await drawer
    .getByLabel("Runtime model", { exact: true })
    .selectOption({ label: "Research" });
  const kb = drawer.locator(".workflow-resource-picker").first();
  await kb
    .getByRole("button", { name: "＋ Add knowledge base", exact: true })
    .click();
  await kb
    .getByLabel("Search knowledge bases", { exact: true })
    .fill("handbook");
  await expect(
    kb.getByLabel("Select knowledge base", { exact: true }).locator("option"),
  ).toHaveCount(2);
  await kb
    .getByLabel("Select knowledge base", { exact: true })
    .selectOption(resourceIds[0]);
  await kb
    .getByRole("button", { name: "Add selected knowledge base", exact: true })
    .click();
  await kb
    .getByLabel("Select knowledge base", { exact: true })
    .selectOption(resourceIds[1]);
  await kb
    .getByRole("button", { name: "Add selected knowledge base", exact: true })
    .click();
  await expect(kb.locator("li")).toHaveCount(2);
  await expect(kb.getByRole("checkbox")).toHaveCount(0);
  await kb
    .getByRole("button", { name: "Remove Product handbook", exact: true })
    .click();
  await expect(kb.locator("li")).toHaveCount(1);
  const tools = drawer.locator(".workflow-resource-picker").nth(1);
  await tools.getByRole("button", { name: "＋ Add tool", exact: true }).click();
  for (const id of toolIds) {
    await tools.getByLabel("Select tool", { exact: true }).selectOption(id);
    await tools
      .getByRole("button", { name: "Add selected tool", exact: true })
      .click();
  }
  await expect(tools.locator("li")).toHaveCount(2);
  const popupEvent = page.waitForEvent("popup");
  await tools
    .getByRole("link", { name: "Configure Canvas calculator", exact: true })
    .click();
  const popup = await popupEvent;
  await expect(
    popup.getByRole("heading", { name: "Edit tool", exact: true }),
  ).toBeVisible();
  await popup.close();
  const order = await drawer.locator("summary").allTextContents();
  expect(order.at(-1)).toBe("Failure recovery");
  await canvas.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    canvas.getByRole("status", { name: "Draft save status" }),
  ).toHaveText("Saved");
  const [stored] =
    await sql`SELECT draft_graph FROM workflows WHERE workspace_id=${workspace} AND name='Attachment workflow'`;
  const agent = stored.draft_graph.nodes.find((n) => n.type === "agent").data
    .inlineAgent;
  expect(agent.rag.knowledgeBaseIds).toEqual([resourceIds[1]]);
  expect(agent.tools.toolIds).toEqual(toolIds);
});

test("canvas deletes nodes and connections and persists connections on multiple sides", async ({
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
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  await page
    .getByRole("button", { name: "Create workflow", exact: true })
    .click();
  await page.getByRole("button", { name: /Manual setup/ }).click();
  await page
    .getByRole("button", { name: "Open canvas directly", exact: true })
    .click();
  await page
    .getByLabel("Workflow name", { exact: true })
    .fill("Connection edits");
  await page
    .getByRole("button", { name: "Expand canvas", exact: true })
    .click();
  const canvas = page.getByRole("dialog", { name: "Expanded workflow canvas" });
  await canvas.getByRole("button", { name: "Minimize canvas panel" }).click();
  async function selectEdge() {
    const point = await canvas
      .locator(".react-flow__edge-path")
      .first()
      .evaluate((path) => {
        const p = path.getPointAtLength(path.getTotalLength() / 2);
        const q = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM());
        return { x: q.x, y: q.y };
      });
    await page.mouse.click(point.x, point.y);
  }
  await selectEdge();
  await canvas
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  await expect(canvas.locator(".react-flow__edge")).toHaveCount(0);
  await expect(canvas.locator(".react-flow__node")).toHaveCount(2);
  await canvas.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(canvas.locator(".react-flow__edge")).toHaveCount(1);
  await selectEdge();
  await page.keyboard.press("Delete");
  await expect(canvas.locator(".react-flow__edge")).toHaveCount(0);
  await canvas.locator('.react-flow__node[data-id="output"]').click();
  await canvas
    .getByRole("button", { name: "Delete selected", exact: true })
    .click();
  await expect(canvas.locator(".react-flow__node")).toHaveCount(1);
  await canvas.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(canvas.locator(".react-flow__node")).toHaveCount(2);
  await canvas
    .getByRole("button", { name: "＋ Add nodes", exact: true })
    .click();
  await canvas.getByRole("button", { name: "Add tool", exact: true }).click();
  await canvas.getByRole("button", { name: "Minimize canvas panel" }).click();
  const tool = canvas
    .locator(".react-flow__node")
    .filter({ has: page.locator(".kind-tool") });
  const input = canvas.locator('.react-flow__node[data-id="input"]');
  const output = canvas.locator('.react-flow__node[data-id="output"]');
  async function connect(from, to) {
    const a = await from.boundingBox(),
      b = await to.boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
    await page.mouse.up();
  }
  await connect(
    input.locator('[data-handleid="out-bottom"]'),
    tool.locator('[data-handleid="in-top"]'),
  );
  await expect(canvas.locator(".react-flow__edge")).toHaveCount(1);
  await connect(
    tool.locator('[data-handleid="out-top"]'),
    output.locator('[data-handleid="in-bottom"]'),
  );
  await expect(canvas.locator(".react-flow__edge")).toHaveCount(2);
  await canvas.locator(".react-flow__edge").first().focus();
  await page.keyboard.press("Enter");
  await connect(
    canvas.locator(
      ".react-flow__edge.selected .react-flow__edgeupdater-target",
    ),
    tool.locator('[data-handleid="in-right"]'),
  );
  await expect(canvas.locator(".react-flow__edge")).toHaveCount(2);
  await canvas.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    canvas.getByRole("status", { name: "Draft save status" }),
  ).toHaveText("Saved");
  const [stored] =
    await sql`SELECT draft_graph FROM workflows WHERE workspace_id=${workspace} AND name='Connection edits'`;
  expect(
    stored.draft_graph.edges.map((e) => [e.sourcePort, e.targetPort]),
  ).toEqual(
    expect.arrayContaining([
      ["out-bottom", "in-right"],
      ["out-top", "in-bottom"],
    ]),
  );
});

test("V2 canvas edits canonical definitions and keeps its property panel inside the canvas", async ({
  page,
  context,
}) => {
  const definition = {
    schemaVersion: 2,
    execution: {
      nodes: [
        { id: "start", kind: "input", label: "V2 input", config: {} },
        {
          id: "end",
          kind: "output",
          label: "V2 result",
          config: { input: { type: "reference", path: "input" } },
        },
      ],
      edges: [{ id: "next", source: "start", target: "end" }],
    },
    editor: { nodes: { start: { x: 40, y: 100 }, end: { x: 300, y: 100 } } },
  };
  const created = await api(`/workspaces/${workspace}/workflows`, {
    name: "V2 preview",
    graph: definition,
  });
  await api(`/workflows/${created.id}/publish`, { revision: 1 });
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
    .getByLabel("Current workflow", { exact: true })
    .selectOption(created.id);
  await expect(
    page.getByRole("heading", { name: "V2 preview · Workflow V2" }),
  ).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "+ Add node", exact: true }),
  ).toBeEnabled();
  await page.locator('.react-flow__node[data-id="end"]').click();
  await page
    .getByLabel("Result title", { exact: true })
    .fill("Reviewed result");
  const canvas = await page.locator(".workflow-canvas").boundingBox();
  const panel = await page
    .getByLabel("Node properties", { exact: true })
    .boundingBox();
  expect(panel.x).toBeGreaterThanOrEqual(canvas.x);
  expect(panel.y + panel.height).toBeLessThanOrEqual(canvas.y + canvas.height);
  await page
    .getByRole("button", { name: "› Minimize panel", exact: true })
    .click();
  await expect(page.getByLabel("Node properties", { exact: true })).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "‹ Restore panel", exact: true })
    .click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Draft saved");
  await page.getByRole("button", { name: "Test / runs", exact: true }).click();
  await expect(
    page.getByLabel("Workflow testing", { exact: true }),
  ).toBeVisible();
  const [stored] =
    await sql`SELECT draft_graph FROM workflows WHERE id=${created.id}`;
  expect(stored.draft_graph.schemaVersion).toBe(2);
  expect(stored.draft_graph.execution.nodes[1].config.input.path).toBe("input");
  expect(stored.draft_graph.nodes).toBeUndefined();
  expect(stored.draft_graph.execution.nodes[1].config.title).toBe(
    "Reviewed result",
  );
});

test("V2 no-code panels reuse Agents and schemas and select mapped fields", async ({
  page,
  context,
}) => {
  const agents =
    await sql`SELECT id,agent_id FROM agent_versions WHERE organization_id=${org} ORDER BY version DESC`;
  const model =
    await sql`SELECT id FROM model_configurations WHERE organization_id=${org} LIMIT 1`;
  const created = await api(`/workspaces/${workspace}/workflows`, {
    name: "V2 configure",
    graph: {
      schemaVersion: 2,
      execution: {
        resources: {
          model: { kind: "model", id: model[0].id },
          agent: {
            kind: "agent",
            agentId: agents[0].agent_id,
            versionId: agents[0].id,
          },
        },
        nodes: [
          { id: "start", kind: "input", label: "Input", config: {} },
          {
            id: "extract",
            kind: "structured-ai",
            label: "Structured Extraction",
            config: {
              resource: "model",
              instruction: "Extract invoice fields",
              outputSchema: {
                type: "object",
                properties: {
                  invoiceNumber: { type: "string" },
                  total: { type: "number" },
                },
                required: ["invoiceNumber", "total"],
                additionalProperties: false,
              },
            },
          },
          {
            id: "review",
            kind: "human-task",
            label: "Review",
            config: {
              mode: "review-edit",
              prompt: "Check invoice",
              outputSchema: { type: "object", properties: {} },
            },
          },
          {
            id: "agent",
            kind: "agent",
            label: "Existing Agent",
            config: { resource: "agent" },
          },
          { id: "end", kind: "output", label: "Output", config: {} },
        ],
        edges: [
          ["start", "extract"],
          ["extract", "review"],
          ["review", "agent"],
          ["agent", "end"],
        ].map(([source, target], i) => ({ id: "edge_" + i, source, target })),
      },
      editor: {
        nodes: {
          start: { x: 20, y: 100 },
          extract: { x: 260, y: 100 },
          review: { x: 500, y: 100 },
          agent: { x: 740, y: 100 },
          end: { x: 980, y: 100 },
        },
      },
    },
  });
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
    .getByLabel("Current workflow", { exact: true })
    .selectOption(created.id);
  await expect(page.locator(".react-flow__node")).toHaveCount(5);
  await page.locator('.react-flow__node[data-id="review"]').click();
  await page
    .getByRole("button", {
      name: "Use previous step’s output schema",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Node properties")).toContainText(
    "invoiceNumber",
  );
  await page
    .getByRole("button", { name: "Choose mapped value", exact: true })
    .click();
  await page
    .getByLabel("Value source", { exact: true })
    .selectOption("steps.extract.output");
  await page
    .getByLabel("Known field", { exact: true })
    .selectOption("invoiceNumber");
  await page.getByLabel("Approve button", { exact: true }).fill("Process");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Draft saved");
  const [stored] =
    await sql`SELECT draft_graph FROM workflows WHERE id=${created.id}`;
  const review = stored.draft_graph.execution.nodes.find(
    (n) => n.id === "review",
  );
  expect(review.config.input.path).toBe("steps.extract.output.invoiceNumber");
  expect(review.config.approveLabel).toBe("Process");
  expect(review.config.outputSchema.properties.total.type).toBe("number");
  await page
    .getByRole("button", { name: "› Minimize panel", exact: true })
    .click();
  await page.locator('.react-flow__node[data-id="agent"]').click();
  await expect(page.getByLabel("Agent", { exact: true })).toBeVisible();
  await expect(
    page.getByLabel("Published version", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Uses the selected published Agent/),
  ).toBeVisible();
  await expect(
    page.getByLabel("Node properties").getByText("Tools", { exact: true }),
  ).toHaveCount(0);
});

test("V2 creates structured schemas and deterministic Actions from canvas property panels", async ({
  page,
  context,
}) => {
  const tool = await api(`/workspaces/${workspace}/tools`, {
    name: "V2 calculator",
    description: "Deterministic calculation",
    config: { kind: "financial" },
    readOnlyAcknowledged: true,
  });
  const [model] =
    await sql`SELECT id FROM model_configurations WHERE organization_id=${org} ORDER BY name LIMIT 1`;
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
    .getByRole("button", { name: "Create V2 workflow", exact: true })
    .click();
  await page
    .getByLabel("Node type", { exact: true })
    .selectOption("structured-ai");
  await page.getByRole("button", { name: "+ Add node", exact: true }).click();
  await page
    .getByRole("combobox", { name: /Model \/ provider/ })
    .selectOption(model.id);
  await page.getByLabel("New schema field", { exact: true }).fill("total");
  await page.getByRole("button", { name: "+ Field", exact: true }).click();
  await page
    .locator(".v2-schema-editor details")
    .first()
    .getByLabel("Schema type", { exact: true })
    .selectOption("number");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Draft saved");
  await page.getByLabel("Node type", { exact: true }).selectOption("action");
  await page.getByRole("button", { name: "+ Add node", exact: true }).click();
  await page
    .getByLabel("Action connector", { exact: true })
    .selectOption("agentconnect.tool");
  await page
    .getByRole("combobox", { name: /Integration \/ operation/ })
    .selectOption(tool.id);
  await expect(
    page.getByText("Connector: agentconnect.tool", { exact: false }),
  ).toBeVisible();
  await page
    .getByLabel("Input field to map", { exact: true })
    .selectOption("operation");
  await page.getByRole("button", { name: "+ Mapping", exact: true }).click();
  await page.getByLabel("Value", { exact: true }).fill("sum");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Draft saved");
  const [stored] =
    await sql`SELECT draft_graph FROM workflows WHERE organization_id=${org} AND name='New workflow' ORDER BY updated_at DESC LIMIT 1`;
  expect(
    stored.draft_graph.execution.nodes.find((n) => n.kind === "structured-ai")
      .config.outputSchema.properties.total.type,
  ).toBe("number");
  const actionNode = stored.draft_graph.execution.nodes.find(
    (n) => n.kind === "action",
  );
  expect(actionNode.config.inputs.operation).toEqual({
    type: "literal",
    value: "sum",
  });
  expect(stored.draft_graph.execution.actions[0].toolId).toBe(tool.id);
  await page.screenshot({
    path: "test-results/workflow-v2-canvas.png",
    fullPage: true,
  });
});

test("V2 controlled primitives configure published bodies, durable waits, event schemas and error routes", async ({
  page,
  context,
}) => {
  const body = await api(`/workspaces/${workspace}/workflows`, {
    name: "Published iteration body",
    graph: {
      schemaVersion: 2,
      execution: {
        nodes: [
          { id: "start", kind: "input", label: "Input", config: {} },
          { id: "end", kind: "output", label: "Output", config: {} },
        ],
        edges: [{ id: "a", source: "start", target: "end" }],
      },
    },
  });
  const version = await api(`/workflows/${body.id}/publish`, { revision: 1 });
  const steps = [
    { id: "start", kind: "input", label: "Input", config: {} },
    {
      id: "timer",
      kind: "wait",
      label: "Durable wait",
      config: { mode: "duration", seconds: 5 },
    },
    {
      id: "child",
      kind: "subworkflow",
      label: "Child flow",
      config: { resource: "body" },
    },
    {
      id: "loop",
      kind: "for-each",
      label: "Documents",
      config: {
        resource: "body",
        collection: { type: "reference", path: "input.files" },
      },
    },
    {
      id: "event",
      kind: "wait-for-event",
      label: "Callback",
      config: { eventName: "complete" },
    },
    {
      id: "error_review",
      kind: "human-task",
      label: "Error review",
      config: {
        mode: "approve-reject",
        prompt: "Review failure",
        outputSchema: { type: "object" },
      },
    },
    { id: "join", kind: "merge", label: "Join", config: {} },
    { id: "end", kind: "output", label: "Output", config: {} },
  ];
  const root = await api(`/workspaces/${workspace}/workflows`, {
    name: "Controlled canvas",
    graph: {
      schemaVersion: 2,
      execution: {
        resources: {
          body: {
            kind: "workflow",
            workflowId: body.id,
            versionId: version.id,
          },
        },
        nodes: steps,
        edges: [
          ["start", "timer"],
          ["timer", "child"],
          ["child", "loop"],
          ["loop", "event"],
          ["event", "join"],
          ["error_review", "join"],
          ["join", "end"],
        ].map(([source, target], i) => ({ id: "e_" + i, source, target })),
      },
      editor: {
        nodes: Object.fromEntries(
          steps.map((s, i) => [s.id, { x: i * 220, y: 100 }]),
        ),
      },
    },
  });
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
    .getByLabel("Current workflow", { exact: true })
    .selectOption(root.id);
  await expect(page.locator(".react-flow__node")).toHaveCount(8);
  await page
    .getByRole("button", { name: "› Minimize panel", exact: true })
    .click();
  await page.locator('.react-flow__node[data-id="timer"]').click();
  await page.getByRole("combobox", { name: /Time unit/ }).selectOption("60");
  await page
    .getByText("Failure recovery / error route", { exact: true })
    .click();
  await page
    .getByRole("combobox", { name: /On error/ })
    .selectOption("error_review");
  await page
    .getByRole("button", { name: "› Minimize panel", exact: true })
    .click();
  await page.locator('.react-flow__node[data-id="child"]').click();
  await page
    .getByRole("combobox", { name: /Version behavior/ })
    .selectOption("latest-published");
  await page
    .getByRole("button", { name: "› Minimize panel", exact: true })
    .click();
  await page.locator('.react-flow__node[data-id="loop"]').click();
  await expect(
    page.getByLabel("Child workflow version", { exact: true }),
  ).toHaveValue(version.id);
  await page.getByLabel("Maximum items", { exact: true }).fill("4");
  await page
    .getByRole("combobox", { name: /Item failure/ })
    .selectOption("continue");
  await page.getByLabel("Output field name", { exact: true }).fill("document");
  await page.getByRole("button", { name: "+ Mapping", exact: true }).click();
  await page
    .getByLabel("Value source", { exact: true })
    .nth(1)
    .selectOption("item");
  await page
    .getByRole("button", { name: "› Minimize panel", exact: true })
    .click();
  await page.locator('.react-flow__node[data-id="event"]').click();
  await page
    .getByLabel("Event name", { exact: true })
    .fill("documents.finished");
  await page.getByLabel("Timeout (seconds)", { exact: true }).fill("3600");
  await page.getByLabel("New schema field", { exact: true }).fill("status");
  await page.getByRole("button", { name: "+ Field", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Draft saved");
  const [stored] =
    await sql`SELECT draft_graph FROM workflows WHERE id=${root.id}`;
  const nodes = stored.draft_graph.execution.nodes;
  expect(nodes.find((n) => n.id === "timer").onError).toBe("error_review");
  expect(nodes.find((n) => n.id === "timer").config.seconds).toBe(300);
  expect(stored.draft_graph.execution.resources.body.versionBehavior).toBe(
    "latest-published",
  );
  expect(
    nodes.find((n) => n.id === "loop").config.itemInputs.document.path,
  ).toBe("item");
  expect(
    nodes.find((n) => n.id === "event").config.outputSchema.properties.status
      .type,
  ).toBe("string");
  await expect(
    page.locator('.react-flow__edge[data-id="error_timer"]'),
  ).toHaveCount(1);
});
