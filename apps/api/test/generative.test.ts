import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest } from "../src/security.js";
import { deleteKnowledge } from "../src/knowledge-storage.js";
import { responseEnvelope } from "@agentconnect/schemas/generative";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  workspace = randomUUID(),
  owner = randomUUID(),
  operator = randomUUID(),
  outsider = randomUUID(),
  viewer = randomUUID();
const sessions: Record<string, string> = {};
let model = "",
  agent = "",
  message = "",
  artifact = "",
  conversation = "",
  deployment = "",
  guestToken = "",
  publicMessage = "";
const envelope = {
  version: 1,
  message: "Structured fixture answer",
  blocks: [
    {
      type: "chart",
      title: "Monthly revenue",
      chartType: "bar",
      data: [
        { label: "Jan", value: 10 },
        { label: "Feb", value: 20 },
      ],
    },
    {
      type: "table",
      title: "Revenue table",
      columns: [{ key: "month", label: "Month" }],
      rows: [{ month: "Jan" }],
    },
    {
      type: "form",
      id: "contact",
      title: "Contact details",
      fields: [
        { name: "email", label: "Email", type: "email", required: true },
        {
          name: "amount",
          label: "Amount",
          type: "number",
          required: true,
          min: 1,
          max: 10,
        },
        {
          name: "choice",
          label: "Choice",
          type: "select",
          required: true,
          options: ["A", "B"],
        },
      ],
      action: "data.collect",
      submitLabel: "Save contact",
      confirmation: "confirm",
    },
    {
      type: "action",
      id: "accept",
      title: "Record selection",
      label: "Record choice",
      action: "data.collect",
      confirmation: "confirm",
      values: { choice: "A" },
    },
    {
      type: "file",
      title: "Revenue report",
      format: "csv",
      columns: [{ key: "value", label: "Value" }],
      rows: [{ value: "=1+1" }, { value: "safe" }],
    },
  ],
};
let response = JSON.stringify(envelope),
  lastPrompt = "";
const app = await buildApp({
  providerFactory: () => ({
    async *stream(input) {
      lastPrompt = input.system;
      yield { type: "token", text: response };
      yield { type: "usage", inputTokens: 100, outputTokens: 200 };
    },
  }),
});
async function call(
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  role = "owner",
  bearer?: string,
) {
  return app.inject({
    method,
    url,
    headers: {
      origin: config.WEB_ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(role ? { cookie: sessions[role] } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
}
function events(body: string) {
  return body
    .split("\n\n")
    .filter((s) => s.startsWith("event:"))
    .map((s) => ({
      event: s.split("\n")[0]!.slice(7),
      data: JSON.parse(s.split("\n")[1]!.slice(6)),
    }));
}
before(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Generative fixture')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Generative workspace')`;
    for (const [role, user] of [
      ["owner", owner],
      ["operator", operator],
      ["outsider", outsider],
      ["viewer", viewer],
    ]) {
      const raw = randomUUID();
      sessions[role!] = `session=${raw}`;
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${user!},${user + "@example.com"},${role!},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(raw)},${user!},now()+interval '1 hour')`;
      if (role !== "outsider")
        await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${role === "owner" ? null : workspace},${user!},${role!})`;
    }
  });
  const m = await call("POST", `/workspaces/${workspace}/models`, {
    name: "Generative model",
    provider: "openai-compatible",
    modelId: "fixture",
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 131072,
    maxOutputTokens: 4096,
  });
  assert.equal(m.statusCode, 201);
  model = m.json().id;
  const a = await call("POST", `/workspaces/${workspace}/agents`, {
    name: "Generative agent",
    config: {
      modelId: model,
      generative: { enabled: true, allowPublicForms: true },
    },
  });
  assert.equal(a.statusCode, 201);
  agent = a.json().id;
});
after(async () => {
  const objects =
    await sql`SELECT storage_key FROM generated_artifacts WHERE workspace_id=${workspace}`;
  await Promise.all(objects.map((a) => deleteKnowledge(a.storage_key)));
  await sql.begin(async (tx) => {
    for (const table of [
      "collected_submissions",
      "generated_artifacts",
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
    await tx`DELETE FROM sessions WHERE user_id=ANY(${[owner, operator, outsider, viewer]})`;
    await tx`DELETE FROM users WHERE id=ANY(${[owner, operator, outsider, viewer]})`;
  });
  await app.close();
});
test("Versioned schema rejects executable markup components, unregistered actions and duplicate fields", () => {
  assert.equal(responseEnvelope.safeParse(envelope).success, true);
  assert.equal(
    responseEnvelope.safeParse({ version: 1, message: "", blocks: [] }).success,
    false,
  );
  assert.equal(
    responseEnvelope.safeParse({
      ...envelope,
      blocks: [
        {
          type: "table",
          title: "Duplicate",
          columns: [
            { key: "a", label: "A" },
            { key: "a", label: "B" },
          ],
          rows: [],
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    responseEnvelope.safeParse({
      ...envelope,
      blocks: [{ type: "html", content: "<script>alert(1)</script>" }],
    }).success,
    false,
  );
  assert.equal(
    responseEnvelope.safeParse({
      ...envelope,
      blocks: [{ ...envelope.blocks[3], action: "customer.delete" }],
    }).success,
    false,
  );
  assert.equal(
    responseEnvelope.safeParse({
      ...envelope,
      blocks: [
        {
          ...envelope.blocks[2],
          fields: [
            { name: "email", label: "Email", type: "email" },
            { name: "email", label: "Email", type: "email" },
          ],
        },
      ],
    }).success,
    false,
  );
});
test("Chat validates structured output before SSE, persists trusted blocks and stores generated CSV privately", async () => {
  const chat = await call("POST", `/agents/${agent}/chat`, {
      message: "Show a chart, form and report",
    }),
    stream = events(chat.body);
  assert.equal(chat.statusCode, 200);
  assert.equal(stream.at(-1)!.event, "done");
  assert.equal(stream.filter((e) => e.event === "token").length, 0);
  const ui = stream.find((e) => e.event === "ui");
  assert.ok(ui);
  message = ui.data.messageId;
  conversation = stream[0]!.data.conversationId;
  artifact = ui.data.blocks.find(
    (b: { type: string }) => b.type === "file",
  ).artifactId;
  assert.match(lastPrompt, /data.collect/);
  assert.match(lastPrompt, /Response schema/);
  const list = await call("GET", `/conversations/${conversation}/messages`);
  assert.equal(list.json().at(-1).ui_blocks.length, 5);
  assert.equal(list.json().at(-1).content, "Structured fixture answer");
  assert.ok(!JSON.stringify(ui.data.blocks).includes("=1+1"));
});
test("Form collection validates confirmation, fields, ownership and replay", async () => {
  const path = `/messages/${message}/actions/contact`,
    values = { email: "person@example.com", amount: 5, choice: "A" };
  assert.equal(
    (await call("POST", path, { confirmed: false, values })).statusCode,
    400,
  );
  assert.equal(
    (
      await call("POST", path, {
        confirmed: true,
        values: { ...values, email: "invalid" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call("POST", path, {
        confirmed: true,
        values: { ...values, amount: 11 },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call("POST", path, {
        confirmed: true,
        values: { ...values, extra: "unknown" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await call("POST", path, { confirmed: true, values }, "operator"))
      .statusCode,
    403,
  );
  assert.equal(
    (await call("POST", path, { confirmed: true, values }, "outsider"))
      .statusCode,
    403,
  );
  assert.equal(
    (await call("POST", path, { confirmed: true, values })).statusCode,
    201,
  );
  assert.equal(
    (await call("POST", path, { confirmed: true, values })).statusCode,
    409,
  );
  const stored = await call(
    "GET",
    `/workspaces/${workspace}/collected-data?search=person@example.com`,
  );
  assert.equal(stored.statusCode, 200);
  assert.equal(stored.json()[0].values.email, values.email);
  assert.equal(
    (
      await call(
        "GET",
        `/workspaces/${workspace}/collected-data`,
        undefined,
        "viewer",
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "GET",
        `/workspaces/${workspace}/collected-data`,
        undefined,
        "outsider",
      )
    ).statusCode,
    403,
  );
});
test("Registered button actions use stored values rather than caller-supplied replacement values", async () => {
  const path = `/messages/${message}/actions/accept`;
  assert.equal(
    (await call("POST", path, { confirmed: true, values: { choice: "B" } }))
      .statusCode,
    400,
  );
  assert.equal(
    (await call("POST", path, { confirmed: true, values: {} })).statusCode,
    201,
  );
  const [row] =
    await sql`SELECT values FROM collected_submissions WHERE message_id=${message} AND block_id='accept'`;
  assert.equal(row!.values.choice, "A");
});
test("Artifact grants enforce tenant access, signed expiration and neutralize CSV formulas", async () => {
  assert.equal(
    (await call("GET", `/artifacts/${artifact}/grant`, undefined, "outsider"))
      .statusCode,
    403,
  );
  const grant = await call("GET", `/artifacts/${artifact}/grant`);
  assert.equal(grant.statusCode, 200);
  const downloaded = await call("GET", grant.json().path, undefined, "");
  assert.equal(downloaded.statusCode, 200);
  assert.match(downloaded.body, /'=1\+1/);
  assert.match(String(downloaded.headers["content-disposition"]), /attachment/);
  const url = new URL(grant.json().path, "http://localhost");
  url.searchParams.set("expires", "1");
  assert.equal(
    (await call("GET", url.pathname + url.search, undefined, "")).statusCode,
    403,
  );
  url.searchParams.set("expires", String(Math.floor(Date.now() / 1000) + 300));
  url.searchParams.set("signature", "0".repeat(64));
  assert.equal(
    (await call("GET", url.pathname + url.search, undefined, "")).statusCode,
    403,
  );
});
test("Malformed or disallowed UI produces a failed run without persisting/rendering raw output", async () => {
  const original = response;
  response =
    '{"version":1,"message":"unsafe","blocks":[{"type":"html","content":"bad"}]}';
  try {
    const chat = await call("POST", `/agents/${agent}/chat`, {
        message: "Invalid fixture",
      }),
      stream = events(chat.body);
    assert.equal(stream.at(-1)!.data.code, "INVALID_UI_RESPONSE");
    assert.equal(
      stream.filter((e) => e.event === "ui" || e.event === "token").length,
      0,
    );
    const count = await call(
      "GET",
      `/conversations/${stream[0]!.data.conversationId}/messages`,
    );
    assert.equal(
      count.json().filter((m: { role: string }) => m.role === "assistant")
        .length,
      0,
    );
  } finally {
    response = original;
  }
});
test("Hosted forms require the matching guest token and active deployment", async () => {
  const published = await call("POST", `/agents/${agent}/publish`, {
    revision: 1,
  });
  assert.equal(published.statusCode, 201);
  const made = await call("POST", `/agents/${agent}/deployments`, {
    name: "Generative hosted",
    versionId: published.json().id,
  });
  assert.equal(made.statusCode, 201);
  deployment = made.json().id;
  const chat = await call(
      "POST",
      `/public/deployments/${deployment}/chat`,
      { message: "Hosted form" },
      "",
    ),
    stream = events(chat.body);
  guestToken = stream[0]!.data.guestToken;
  publicMessage = stream.find((e) => e.event === "ui")!.data.messageId;
  const path = `/messages/${publicMessage}/actions/contact`,
    body = {
      confirmed: true,
      values: { email: "guest@example.com", amount: 2, choice: "B" },
    };
  assert.equal(
    (await call("POST", path, body, "", "wrong-token")).statusCode,
    403,
  );
  assert.equal(
    (await call("POST", path, body, "", guestToken)).statusCode,
    201,
  );
  await sql`UPDATE deployments SET enabled=false WHERE id=${deployment}`;
  assert.equal(
    (
      await call(
        "POST",
        `/messages/${publicMessage}/actions/accept`,
        { confirmed: true, values: {} },
        "",
        guestToken,
      )
    ).statusCode,
    403,
  );
});
