import { test, expect } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import postgres from "postgres";
if (process.env.NODE_ENV === "production")
  throw new Error("No production fixtures");
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const org = randomUUID(),
  workspace = randomUUID(),
  model = randomUUID();
const users = { owner: randomUUID(), builder: randomUUID() },
  sessions = { owner: randomUUID(), builder: randomUUID() };
let agent, tool;
async function api(method, path, data, role = "owner") {
  const response = await fetch("http://localhost:4000" + path, {
    method,
    headers: {
      origin: "http://localhost:3000",
      cookie: "session=" + sessions[role],
      ...(data ? { "content-type": "application/json" } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const body = await response.json();
  expect(response.ok, JSON.stringify(body)).toBeTruthy();
  return body;
}
test.beforeAll(async () => {
  await expect
    .poll(
      async () => {
        try {
          return (await fetch("http://localhost:4000/health/ready")).status;
        } catch {
          return 0;
        }
      },
      { timeout: 20000 },
    )
    .toBe(200);
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES(${org},'Disabled tools browser fixture')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES(${workspace},${org},'Tools UI fixture')`;
    for (const role of ["owner", "builder"]) {
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES(${users[role]},${users[role] + "@example.invalid"},${role},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(${createHash("sha256").update(sessions[role]).digest("hex")},${users[role]},now()+interval '1 hour')`;
      await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES(${randomUUID()},${org},${role === "owner" ? null : workspace},${users[role]},${role})`;
    }
    await tx`INSERT INTO model_configurations(id,organization_id,workspace_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES(${model},${org},${workspace},'UI fixture','openai-compatible','fixture','https://api.openai.com/v1',4096,1024,'{"streaming":true,"temperature":true,"topP":true}')`;
  });
  tool = (
    await api("POST", `/workspaces/${workspace}/tools`, {
      name: "Disabled search lookup",
      description: "Fixture lookup",
      config: { kind: "http", url: "http://127.0.0.1:4552/facts" },
      enabled: false,
      readOnlyAcknowledged: true,
      publicAccess: false,
    })
  ).id;
  agent = (
    await api("POST", `/workspaces/${workspace}/agents`, {
      name: "Knowledge assistant",
      config: {
        modelId: model,
        prompt: { instructions: "Use approved knowledge." },
        tools: { toolIds: [], usageMode: "automatic" },
      },
    })
  ).id;
});
test.afterAll(async () => {
  await sql.begin(async (tx) => {
    for (const table of [
      "agents",
      "tools",
      "model_configurations",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    for (const id of Object.values(users))
      await tx`DELETE FROM users WHERE id=${id}`;
  });
  await sql.end();
});
async function open(page, context, role = "owner") {
  await context.addCookies([
    {
      name: "session",
      value: sessions[role],
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto(
    `/#view=Agents&organization=${org}&workspace=${workspace}&agent=${agent}&stage=configure&section=tools`,
  );
  await expect(
    page.getByRole("region", { name: "Attached tools" }),
  ).toBeVisible();
}
test("Disabled tools explain workspace state to builders and cannot be enabled without administrator permission", async ({
  page,
  context,
}) => {
  await open(page, context, "builder");
  await expect(
    page.getByRole("checkbox", { name: /Disabled search lookup/ }),
  ).toBeDisabled();
  await expect(
    page.getByText(/Ask a workspace administrator to enable this tool/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Enable Disabled search lookup" }),
  ).toHaveCount(0);
  const row = await api("GET", `/tools/${tool}`);
  const response = await page.request.put(
    `http://localhost:4000/tools/${tool}`,
    {
      data: {
        name: row.name,
        description: row.description,
        config: row.config,
        publicAccess: row.public_access,
        timeoutMs: row.timeout_ms,
        revision: row.revision,
        readOnlyAcknowledged: true,
        enabled: true,
      },
    },
  );
  expect(response.status()).toBe(403);
});
test("Administrator can retry a revision conflict, enable inline and attach without losing the agent draft", async ({
  page,
  context,
}) => {
  await open(page, context);
  const checkbox = page.getByRole("checkbox", {
    name: /Disabled search lookup/,
  });
  await expect(checkbox).toBeDisabled();
  await expect(checkbox).not.toBeChecked();
  await expect(
    page.getByText(
      /Disabled in this workspace. Enable the tool before attaching it/,
    ),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Configure sections" })
    .getByRole("button", { name: "Prompt", exact: true })
    .click();
  await page
    .getByLabel("Instructions", { exact: true })
    .fill("Preserve this unsaved instruction.");
  await page
    .getByRole("navigation", { name: "Configure sections" })
    .getByRole("button", { name: "Tools", exact: true })
    .click();
  let raced = false;
  await page.route(`**/tools/${tool}`, async (route) => {
    if (route.request().method() === "PUT" && !raced) {
      raced = true;
      await sql`UPDATE tools SET revision=revision+1 WHERE id=${tool}`;
    }
    await route.continue();
  });
  const enable = page.getByRole("button", {
    name: "Enable Disabled search lookup",
  });
  await enable.click();
  await expect(
    page.getByText("Tool changed; reload before saving"),
  ).toBeVisible();
  await expect(checkbox).toBeDisabled();
  await enable.click();
  await expect(checkbox).toBeEnabled();
  await expect(checkbox).not.toBeChecked();
  await expect(page.getByText(/Tool enabled for this workspace/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await checkbox.check();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByText("Draft saved. Start a new chat to use these changes.", {
      exact: true,
    }),
  ).toBeVisible();
  const [saved] = await sql`SELECT draft_config FROM agents WHERE id=${agent}`;
  expect(saved.draft_config.tools.toolIds).toEqual([tool]);
  expect(saved.draft_config.prompt.instructions).toBe(
    "Preserve this unsaved instruction.",
  );
  const [enabled] =
    await sql`SELECT enabled,description,public_access FROM tools WHERE id=${tool}`;
  expect(enabled.enabled).toBeTruthy();
  expect(enabled.description).toBe("Fixture lookup");
  expect(enabled.public_access).toBeFalsy();
});
