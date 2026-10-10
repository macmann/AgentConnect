import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest } from "../src/security.js";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  workspace = randomUUID(),
  sibling = randomUUID(),
  users: Record<string, string> = {},
  sessions: Record<string, string> = {};
const remoteAddress = `127.${randomBytes(1)[0]}.${randomBytes(1)[0]}.44`,
  base = `/workspaces/${workspace}/support`;
let lastPrompt: string[] = [],
  agent = "",
  conversation = "",
  caseId = "",
  queue = "",
  deployment = "",
  guestConversation = "",
  guestToken = "";
const app = await buildApp({
  providerFactory: () => ({
    async *stream(req) {
      lastPrompt = req.messages.map((m) => m.content);
      yield { type: "token", text: "Support console fixture" };
    },
  }),
});
async function call(
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: unknown,
  role = "owner",
  bearer?: string,
) {
  return app.inject({
    method,
    url,
    remoteAddress,
    headers: {
      origin: config.WEB_ORIGIN,
      ...(role ? { cookie: `session=${sessions[role]}` } : {}),
      ...(bearer ? { authorization: "Bearer " + bearer } : {}),
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
    },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
}
function meta(body: string) {
  return JSON.parse(
    body
      .split("\n\n")
      .find((s) => s.startsWith("event: meta"))!
      .split("\ndata: ")[1]!,
  );
}
before(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Support console fixtures')`;
    for (const w of [workspace, sibling])
      await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${w},${org},'Support console workspace')`;
    for (const role of ["owner", "operator", "other", "analyst", "outsider"]) {
      users[role] = randomUUID();
      sessions[role] = randomUUID();
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${users[role]},${users[role] + "@example.invalid"},${role},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(sessions[role]!)},${users[role]},now()+interval '1 hour')`;
      if (role !== "outsider")
        await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${role === "owner" ? null : workspace},${users[role]},${role === "other" ? "operator" : role})`;
    }
  });
  const m = await call("POST", `/workspaces/${workspace}/models`, {
    name: "Console fixture",
    provider: "openai-compatible",
    modelId: "fixture",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.equal(m.statusCode, 201, m.body);
  const a = await call("POST", `/workspaces/${workspace}/agents`, {
    name: "Support assistant",
    config: { modelId: m.json().id },
  });
  assert.equal(a.statusCode, 201, a.body);
  agent = a.json().id;
  const chat = await call("POST", `/agents/${agent}/chat`, {
    message: "Need specialist review",
  });
  assert.equal(chat.statusCode, 200, chat.body);
  conversation = meta(chat.body).conversationId;
  const v = await call("POST", `/agents/${agent}/publish`, { revision: 1 });
  assert.equal(v.statusCode, 201, v.body);
  const d = await call("POST", `/agents/${agent}/deployments`, {
    name: "Console guest",
    versionId: v.json().id,
  });
  assert.equal(d.statusCode, 201, d.body);
  deployment = d.json().id;
  const guest = await call(
    "POST",
    `/public/deployments/${deployment}/chat`,
    { message: "Guest help" },
    "",
  );
  assert.equal(guest.statusCode, 200, guest.body);
  const info = meta(guest.body);
  guestConversation = info.conversationId;
  guestToken = info.guestToken;
});
after(async () => {
  await sql.begin(async (tx) => {
    for (const table of [
      "handoff_events",
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
    for (const u of Object.values(users))
      await tx`DELETE FROM users WHERE id=${u}`;
  });
  await app.close();
});
test("Console filters, counts and identity projections use tenant data", async () => {
  queue = (await call("POST", base + "/queues", { name: "Billing" })).json().id;
  const c = await call("POST", base + "/cases", {
    conversationId: conversation,
    reasonText: "Billing review",
    priority: "high",
  });
  assert.equal(c.statusCode, 201, c.body);
  caseId = c.json().id;
  const summary = await call("GET", base + "/summary");
  assert.deepEqual(summary.json(), {
    waiting: 1,
    active: 0,
    unassigned: 1,
    mine: 0,
  });
  const result = await call(
    "GET",
    base +
      "/cases?scope=waiting&priority=high&channel=playground&search=Billing",
  );
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().items[0].customer_name, "owner");
  assert.equal(result.json().items[0].agent_name, "Support assistant");
  assert.equal(
    result.json().items[0].latest_message,
    "Support console fixture",
  );
  assert.equal(
    (
      await call("GET", base + "/cases?scope=mine", undefined, "operator")
    ).json().items.length,
    0,
  );
  assert.equal(
    (await call("GET", base + "/summary", undefined, "outsider")).statusCode,
    403,
  );
});
test("Assignment roster excludes unauthorized users and respects queue boundaries", async () => {
  const ops = await call("GET", base + "/operators");
  assert.equal(ops.statusCode, 200, ops.body);
  assert.deepEqual(
    ops
      .json()
      .items.map((u: { id: string }) => u.id)
      .sort(),
    [users.owner, users.operator, users.other].sort(),
  );
  assert.ok(
    ops.json().items.every((u: { email?: string }) => u.email === undefined),
  );
  assert.equal(
    (await call("GET", base + "/operators", undefined, "analyst")).statusCode,
    200,
  );
  const foreign = randomUUID();
  await sql`INSERT INTO support_queues(id,organization_id,workspace_id,name) VALUES (${foreign},${org},${sibling},'Other queue')`;
  assert.equal(
    (
      await call("POST", base + `/cases/${caseId}/assign`, {
        operatorId: users.operator,
        queueId: foreign,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await call("POST", base + `/cases/${caseId}/assign`, {
        operatorId: users.operator,
        queueId: queue,
      })
    ).statusCode,
    200,
  );
  const assigned = (await call("GET", base + `/cases/${caseId}`)).json();
  assert.equal(assigned.assigned_operator_name, "operator");
  assert.equal(assigned.queue_name, "Billing");
  assert.equal(
    (
      await call(
        "POST",
        base + `/cases/${caseId}/status`,
        { status: "active" },
        "operator",
      )
    ).statusCode,
    200,
  );
  assert.deepEqual(
    (
      await call(
        "GET",
        base + "/summary?queueId=" + queue,
        undefined,
        "operator",
      )
    ).json(),
    { waiting: 0, active: 1, unassigned: 0, mine: 1 },
  );
});
test("Private notes persist, audit without content and never enter public threads or AI prompts", async () => {
  assert.equal(
    (
      await call(
        "POST",
        base + `/cases/${caseId}/notes`,
        { content: "Intrusion" },
        "other",
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "POST",
        base + `/cases/${caseId}/notes`,
        { content: "Intrusion" },
        "analyst",
      )
    ).statusCode,
    403,
  );
  const note = await call(
    "POST",
    base + `/cases/${caseId}/notes`,
    { content: "PRIVATE identity verified" },
    "operator",
  );
  assert.equal(note.statusCode, 201, note.body);
  assert.equal(
    (
      await call(
        "POST",
        base + `/cases/${caseId}/messages`,
        { content: "Public specialist reply" },
        "operator",
      )
    ).statusCode,
    200,
  );
  const timeline = await call(
    "GET",
    base + `/cases/${caseId}/timeline?limit=100`,
    undefined,
    "analyst",
  );
  assert.equal(timeline.statusCode, 200, timeline.body);
  const kinds = timeline.json().items.map((e: { kind: string }) => e.kind);
  for (const kind of ["customer", "ai", "operator", "system", "note"])
    assert.ok(kinds.includes(kind));
  assert.ok(
    timeline
      .json()
      .items.some(
        (e: { kind: string; content: string }) =>
          e.kind === "note" && e.content === "PRIVATE identity verified",
      ),
  );
  const old = await call("GET", `/conversations/${conversation}/handoff`);
  assert.ok(!old.body.includes("PRIVATE"));
  const [audit] =
    await sql`SELECT metadata FROM audit_events WHERE entity_id=${note.json().id}`;
  assert.deepEqual(audit!.metadata, { caseId });
  const [event] =
    await sql`SELECT payload FROM support_events WHERE payload->>'noteId'=${note.json().id}`;
  assert.deepEqual(event!.payload, { noteId: note.json().id });
  assert.equal(
    (
      await call(
        "POST",
        base + `/cases/${caseId}/resolve`,
        {
          summary: "PRIVATE resolution",
          finalResponse: "Public final response",
        },
        "operator",
      )
    ).statusCode,
    200,
  );
  const guestThread = await call(
    "GET",
    `/conversations/${conversation}/handoff`,
  );
  assert.ok(!guestThread.body.includes("PRIVATE"));
  assert.ok(guestThread.body.includes("Public final response"));
  assert.equal(
    (
      await call("POST", `/agents/${agent}/chat`, {
        message: "Continue",
        conversationId: conversation,
      })
    ).statusCode,
    200,
  );
  assert.ok(lastPrompt.every((content) => !content.includes("PRIVATE")));
  const after = await call("GET", base + `/cases/${caseId}/timeline`);
  assert.ok(after.body.includes("PRIVATE identity verified"));
  assert.equal(
    (
      await call(
        "POST",
        base + `/cases/${caseId}/notes`,
        { content: "Closed case" },
        "operator",
      )
    ).statusCode,
    409,
  );
});
test("Guest APIs cannot read internal notes; timeline pagination is bounded and tenant scoped", async () => {
  const path = `/public/deployments/${deployment}/conversations/${guestConversation}/handoff`;
  assert.equal(
    (await call("POST", path, { action: "request" }, "", guestToken))
      .statusCode,
    201,
  );
  const [s] =
    await sql`SELECT id FROM support_cases WHERE conversation_id=${guestConversation}`;
  assert.equal(
    (await call("POST", base + `/cases/${s!.id}/claim`, {}, "operator"))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "POST",
        base + `/cases/${s!.id}/notes`,
        { content: "PRIVATE guest context" },
        "operator",
      )
    ).statusCode,
    201,
  );
  const customer = await call("GET", path, undefined, "", guestToken);
  assert.equal(customer.statusCode, 200, customer.body);
  assert.ok(!customer.body.includes("PRIVATE"));
  assert.equal(
    (
      await call(
        "GET",
        base + `/cases/${s!.id}/timeline`,
        undefined,
        "",
        guestToken,
      )
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await call(
        "GET",
        `/workspaces/${sibling}/support/cases/${s!.id}/timeline`,
      )
    ).statusCode,
    404,
  );
  const first = (
    await call("GET", base + `/cases/${caseId}/timeline?limit=1`)
  ).json();
  assert.ok(first.nextCursor);
  const second = (
    await call(
      "GET",
      base +
        `/cases/${caseId}/timeline?limit=1&before=${encodeURIComponent(first.nextCursor.before)}&beforeId=${first.nextCursor.beforeId}`,
    )
  ).json();
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.equal(
    (await call("GET", base + `/cases/${caseId}/timeline?limit=1000`))
      .statusCode,
    400,
  );
});
test("Final response and resolution roll back together when the case is not accepted", async () => {
  const chat = await call("POST", `/agents/${agent}/chat`, {
    message: "Another problem",
  });
  const c = meta(chat.body).conversationId;
  const s = (await call("POST", base + "/cases", { conversationId: c })).json();
  const failed = await call("POST", base + `/cases/${s.id}/resolve`, {
    summary: "Invalid resolution",
    finalResponse: "Must not be delivered",
  });
  assert.equal(failed.statusCode, 409);
  assert.ok(
    !(await call("GET", `/conversations/${c}/handoff`)).body.includes(
      "Must not be delivered",
    ),
  );
});
