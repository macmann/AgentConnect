import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const org = randomUUID(),
  workspace = randomUUID(),
  user = randomUUID(),
  session = randomUUID(),
  workflow = randomUUID(),
  run = randomUUID();
const input = { customer: { name: "Alice", city: "Yangon" }, score: 3 };
const graph = {
  schemaVersion: 1,
  inputFields: [
    { name: "customer", label: "Customer", type: "json", required: true },
    { name: "score", label: "Score", type: "number", required: true },
  ],
  nodes: [
    {
      id: "start",
      type: "input",
      position: { x: 0, y: 0 },
      data: { label: "Customer input" },
    },
    {
      id: "mapped",
      type: "merge",
      position: { x: 250, y: 0 },
      data: {
        label: "Selected customer",
        inputFrom: "start",
        inputPath: "/customer/name",
      },
    },
    {
      id: "end",
      type: "output",
      position: { x: 500, y: 0 },
      data: { label: "Result" },
    },
  ],
  edges: [
    { id: "a", source: "start", target: "mapped" },
    { id: "b", source: "mapped", target: "end" },
  ],
};
test.beforeAll(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${user},${user + "@example.com"},'Mapping browser','not-used',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${createHash("sha256").update(session).digest("hex")},${user},now()+interval '1 hour')`;
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Mapping browser')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Mapping')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${user},'owner')`;
    await tx`INSERT INTO workflows(id,workspace_id,organization_id,name,description,draft_graph,created_by) VALUES (${workflow},${workspace},${org},'Field mapping example','',${tx.json(graph)},${user})`;
    await tx`INSERT INTO workflow_runs(id,workflow_id,workspace_id,organization_id,user_id,graph_snapshot,input,status,output,finished_at) VALUES (${run},${workflow},${workspace},${org},${user},${tx.json(graph)},${JSON.stringify(input)},'completed',${tx.json("Alice")},now())`;
    for (const n of graph.nodes) {
      const value = n.id === "start" ? input : "Alice";
      await tx`INSERT INTO workflow_node_runs(run_id,node_id,workspace_id,organization_id,label,kind,status,input,output,duration_ms,attempts) VALUES (${run},${n.id},${workspace},${org},${n.data.label},${n.type},'completed',${tx.json(value)},${tx.json(value)},12,1)`;
    }
  });
});
test.afterAll(async () => {
  await sql.begin(async (tx) => {
    for (const table of [
      "workflow_node_runs",
      "workflow_runs",
      "workflow_versions",
      "workflows",
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
test("field picker previews recorded values, assembles named fields and canvas inspection uses the run snapshot", async ({
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
  await page.goto(
    `/#view=Workflows&organization=${org}&workspace=${workspace}`,
  );
  await page
    .getByRole("button", { name: "Field mapping example", exact: true })
    .click();
  await page.locator('.react-flow__node[data-id="mapped"]').click();
  const editor = page.locator(".workflow-mapping-editor");
  await expect(
    editor.getByRole("heading", { name: "Input mapping" }),
  ).toBeVisible();
  await editor.getByText("Preview mapped input", { exact: true }).click();
  await editor
    .getByRole("combobox", { name: /Recorded run/ })
    .selectOption(run);
  await expect(
    editor.locator(".workflow-mapping-preview pre").first(),
  ).toHaveText('"Alice"');
  await editor
    .getByRole("combobox", { name: /Select input field/ })
    .selectOption("/score");
  await expect(
    editor.locator(".workflow-mapping-preview pre").first(),
  ).toHaveText("3");
  await editor
    .getByRole("combobox", { name: /Mapping mode/ })
    .selectOption("fields");
  await editor
    .getByLabel("Target field name", { exact: true })
    .fill("customer_name");
  await editor
    .getByRole("combobox", { name: /Select source field/ })
    .selectOption("/customer/name");
  await editor.getByRole("button", { name: "Add mapped field" }).click();
  const rows = editor.locator("fieldset");
  await rows
    .nth(1)
    .getByLabel("Target field name", { exact: true })
    .fill("score");
  await rows
    .nth(1)
    .getByRole("combobox", { name: /Select source field/ })
    .selectOption("/score");
  await expect(
    editor.locator(".workflow-mapping-preview pre").first(),
  ).toContainText('"customer_name": "Alice"');
  await expect(
    editor.locator(".workflow-mapping-preview pre").first(),
  ).toContainText('"score": 3');
  await rows
    .nth(1)
    .locator("summary")
    .filter({ hasText: "Custom field path" })
    .click();
  await rows
    .nth(1)
    .getByLabel("JSON Pointer", { exact: true })
    .fill("/missing");
  await expect(editor.locator(".workflow-mapping-preview")).toContainText(
    "WORKFLOW_MAPPING_FIELD_MISSING",
  );
  await rows.nth(1).getByLabel("JSON Pointer", { exact: true }).fill("/score");
  const save = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/workflows/${workflow}`) &&
      r.request().method() === "PUT",
  );
  await page
    .getByRole("button", { name: "Save workflow", exact: true })
    .click();
  expect((await save).ok()).toBe(true);
  const [saved] =
    await sql`SELECT draft_graph FROM workflows WHERE id=${workflow}`;
  expect(
    saved.draft_graph.nodes.find((n) => n.id === "mapped").data.inputBindings,
  ).toEqual([
    { target: "customer_name", source: "start", path: "/customer/name" },
    { target: "score", source: "start", path: "/score" },
  ]);
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await page
    .getByRole("button", {
      name: new RegExp(`Run ${run.slice(0, 8)} · completed`),
    })
    .click();
  await expect(page.getByTestId("workflow-run-status")).toHaveText("completed");
  await page.locator('.react-flow__node[data-id="mapped"]').click();
  const inspector = page.getByRole("region", { name: "Selected step details" });
  await expect(
    inspector.getByRole("heading", { name: "Step details: Selected customer" }),
  ).toBeVisible();
  await expect(inspector.locator("pre").first()).toHaveText('"Alice"');
  await inspector
    .getByText("Published/run input mapping", { exact: true })
    .click();
  await expect(inspector).toContainText("/customer/name");
  await expect(inspector).not.toContainText("customer_name");
  await page
    .getByRole("combobox", { name: /Inspect step/ })
    .selectOption("end");
  await expect(
    inspector.getByRole("heading", { name: "Step details: Result" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
});
