import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest } from "../src/security.js";
import {
  canTransition,
  controlForCase,
  supportCaseQuery,
} from "@agentconnect/schemas/support";
import { retentionCandidates } from "../src/retention.js";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  workspace = randomUUID(),
  sibling = randomUUID();
const users: Record<string, string> = {},
  sessions: Record<string, string> = {};
const remoteAddress = `127.${randomBytes(1)[0]}.${randomBytes(1)[0]}.43`;
const app = await buildApp({
  providerFactory: () => ({
    async *stream() {
      yield { type: "token", text: "Support fixture" };
    },
  }),
});
const base = `/workspaces/${workspace}/support`;
let agent = "",
  conversation = "",
  queue = "",
  caseId = "";
async function call(
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: unknown,
  role = "owner",
) {
  return app.inject({
    method,
    url,
    remoteAddress,
    headers: {
      origin: config.WEB_ORIGIN,
      cookie: `session=${sessions[role]}`,
      "content-type": "application/json",
    },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
}
before(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Support fixtures')`;
    for (const w of [workspace, sibling])
      await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${w},${org},'Support workspace')`;
    for (const role of [
      "owner",
      "operator",
      "operator2",
      "analyst",
      "outsider",
    ]) {
      users[role] = randomUUID();
      sessions[role] = randomUUID();
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${users[role]},${users[role] + "@example.com"},${role},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(sessions[role]!)},${users[role]},now()+interval '1 hour')`;
      if (role !== "outsider")
        await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${role === "owner" ? null : workspace},${users[role]},${role === "operator2" ? "operator" : role})`;
    }
  });
  const m = await call("POST", `/workspaces/${workspace}/models`, {
    name: "Fixture",
    provider: "openai-compatible",
    modelId: "fixture",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.equal(m.statusCode, 201, m.body);
  const a = await call("POST", `/workspaces/${workspace}/agents`, {
    name: "Support agent",
    config: { modelId: m.json().id },
  });
  assert.equal(a.statusCode, 201, a.body);
  agent = a.json().id;
  const c = await call("POST", `/agents/${agent}/chat`, { message: "Help" });
  assert.equal(c.statusCode, 200, c.body);
  conversation = JSON.parse(
    c.body
      .split("\n\n")
      .find((s) => s.startsWith("event: meta"))!
      .split("\ndata: ")[1]!,
  ).conversationId;
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
test("Domain state transitions and cursors are validated", () => {
  assert.equal(canTransition("closed", "active"), false);
  assert.equal(canTransition("active", "resolved"), true);
  assert.deepEqual(controlForCase("waiting_external"), {
    mode: "human",
    legacy: "active",
  });
  assert.equal(
    supportCaseQuery.safeParse({ beforeId: randomUUID() }).success,
    false,
  );
});
test("Queue configuration is admin scoped and automated routing is explicitly deferred", async () => {
  assert.equal(
    (await call("POST", base + "/queues", { name: "General" }, "operator"))
      .statusCode,
    403,
  );
  const q = await call("POST", base + "/queues", { name: "General" });
  assert.equal(q.statusCode, 201, q.body);
  queue = q.json().id;
  assert.equal(
    (await call("POST", base + "/queues", { name: "general" })).statusCode,
    409,
  );
  assert.equal(
    (
      await call("POST", base + "/queues", {
        name: "Hybrid",
        routingStrategy: "hybrid",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await call("GET", base + "/queues", undefined, "analyst")).json().items
      .length,
    1,
  );
});
test("Concurrent duplicate escalation creates one case; tenant boundaries and AI exclusion hold", async () => {
  const input = {
    conversationId: conversation,
    queueId: queue,
    idempotencyKey: randomUUID(),
  };
  const results = await Promise.all([
    call("POST", base + "/cases", input),
    call("POST", base + "/cases", input),
  ]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 201]);
  caseId = results[0]!.json().id;
  assert.equal(results[1]!.json().id, caseId);
  assert.equal(
    (await call("GET", base + `/cases/${caseId}/events`)).json().items.length,
    1,
  );
  assert.equal(
    (await call("GET", base + "/cases", undefined, "outsider")).statusCode,
    403,
  );
  assert.equal(
    (await call("GET", `/workspaces/${sibling}/support/cases/${caseId}`))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await call("POST", `/agents/${agent}/chat`, {
        message: "Competing AI",
        conversationId: conversation,
      })
    ).statusCode,
    409,
  );
});
test("Claim race selects one exclusive operator and retries do not duplicate events", async () => {
  const url = base + `/cases/${caseId}/claim`;
  const responses = await Promise.all([
    call("POST", url, {}, "operator"),
    call("POST", url, {}, "operator2"),
  ]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
  const s = (await call("GET", base + `/cases/${caseId}`)).json();
  const winner =
      s.assigned_operator_id === users.operator ? "operator" : "operator2",
    loser = winner === "operator" ? "operator2" : "operator";
  assert.equal((await call("POST", url, {}, winner)).statusCode, 200);
  assert.equal(
    (
      await call(
        "POST",
        base + `/cases/${caseId}/messages`,
        { content: "Intrusion" },
        loser,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "POST",
        base + `/cases/${caseId}/messages`,
        { content: "Specialist response" },
        winner,
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "POST",
        base + `/cases/${caseId}/status`,
        { status: "waiting_external" },
        winner,
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "POST",
        base + `/cases/${caseId}/resolve`,
        { summary: "Done" },
        "analyst",
      )
    ).statusCode,
    403,
  );
  const events = (await call("GET", base + `/cases/${caseId}/events`)).json()
    .items;
  assert.equal(
    events.filter((e: { type: string }) => e.type === "case.claimed").length,
    1,
  );
});
test("Open support is protected from retention with a stale legacy projection", async () => {
  await sql`UPDATE conversations SET handoff_status='resolved',last_activity_at=now()-interval '90 days' WHERE id=${conversation}`;
  const p = {
    workspace_id: workspace,
    organization_id: org,
    revision: 1,
    enabled: true,
    conversation_days: 1,
    run_days: null,
    artifact_days: null,
    connector_days: null,
    updated_by: users.owner!,
    next_run_at: null,
  };
  assert.equal(
    (await retentionCandidates(sql, p, new Date())).conversations.includes(
      conversation,
    ),
    false,
  );
  assert.equal(
    (
      await call("POST", `/agents/${agent}/chat`, {
        message: "Blocked despite stale projection",
        conversationId: conversation,
      })
    ).statusCode,
    409,
  );
  await sql`UPDATE conversations SET handoff_status='active' WHERE id=${conversation}`;
});
test("Resolution restores AI on the same conversation; later escalation does not overwrite history", async () => {
  const result = await call("POST", base + `/cases/${caseId}/resolve`, {
    summary: "Dispute DSP-29219 created",
    code: "dispute_created",
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(
    result.json().resume_context.summary,
    "Dispute DSP-29219 created",
  );
  const [c] =
    await sql`SELECT conversation_mode,active_support_case_id FROM conversations WHERE id=${conversation}`;
  assert.equal(c!.conversation_mode, "ai");
  assert.equal(c!.active_support_case_id, null);
  assert.equal(
    (
      await call("POST", `/agents/${agent}/chat`, {
        message: "Continue",
        conversationId: conversation,
      })
    ).statusCode,
    200,
  );
  const next = await call("POST", base + "/cases", {
    conversationId: conversation,
  });
  assert.equal(next.statusCode, 201, next.body);
  assert.notEqual(next.json().id, caseId);
  assert.equal(
    (await call("POST", base + `/cases/${caseId}/status`, { status: "closed" }))
      .statusCode,
    200,
  );
  const [current] =
    await sql`SELECT conversation_mode,active_support_case_id FROM conversations WHERE id=${conversation}`;
  assert.equal(current!.active_support_case_id, next.json().id);
  assert.equal(current!.conversation_mode, "waiting_human");
  const assign = await call("POST", base + `/cases/${next.json().id}/assign`, {
    operatorId: users.operator,
  });
  assert.equal(assign.statusCode, 200, assign.body);
  assert.equal(
    (
      await call(
        "POST",
        base + `/cases/${next.json().id}/status`,
        { status: "active" },
        "operator",
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "POST",
        base + `/cases/${next.json().id}/status`,
        { status: "queued" },
        "operator",
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call("POST", base + `/cases/${next.json().id}/assign`, {
        operatorId: users.outsider,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await call("PATCH", base + `/queues/${queue}`, { enabled: false }))
      .statusCode,
    200,
  );
});
test("Events are immutable; database constraints enforce case, conversation and queue tenancy", async () => {
  const [e] =
    await sql`SELECT id FROM support_events WHERE support_case_id=${caseId} LIMIT 1`;
  await assert.rejects(
    sql`UPDATE support_events SET payload='{}' WHERE id=${e!.id}`,
    /immutable/,
  );
  await assert.rejects(
    sql`INSERT INTO support_cases(id,organization_id,workspace_id,conversation_id,status) VALUES (${randomUUID()},${org},${sibling},${conversation},'closed')`,
    (e: unknown) => (e as { code: string }).code === "23503",
  );
  await assert.rejects(
    sql`UPDATE support_cases SET assigned_operator_id=${users.outsider!} WHERE id=${caseId}`,
    (e: unknown) => (e as { code: string }).code === "23514",
  );
  const foreign = randomUUID();
  await sql`INSERT INTO support_queues(id,organization_id,workspace_id,name) VALUES (${foreign},${org},${sibling},'Other')`;
  await assert.rejects(
    sql`UPDATE support_cases SET queue_id=${foreign} WHERE id=${caseId}`,
    (e: unknown) => (e as { code: string }).code === "23503",
  );
});

test("Resolution and reply serialize without a message appearing after case resolution", async () => {
  const [s] =
    await sql`SELECT id FROM support_cases WHERE conversation_id=${conversation} AND status='queued'`;
  assert.equal(
    (await call("POST", base + `/cases/${s!.id}/claim`, {})).statusCode,
    200,
  );
  const results = await Promise.all([
    call("POST", base + `/cases/${s!.id}/resolve`, {
      summary: "Resolved race fixture",
    }),
    call("POST", base + `/cases/${s!.id}/messages`, {
      content: "Concurrent operator reply",
    }),
  ]);
  assert.equal(results[0]!.statusCode, 200, results[0]!.body);
  assert.ok([200, 409].includes(results[1]!.statusCode), results[1]!.body);
  const timeline = (await call("GET", base + `/cases/${s!.id}/events`))
    .json()
    .items.reverse();
  assert.equal(timeline.at(-1).type, "case.resolved");
});

test("Queue PATCH preserves omitted configuration and cursors avoid duplicate events", async () => {
  const patch = await call("PATCH", base + `/queues/${queue}`, {
    description: "Billing follow-up",
    priority: "high",
  });
  assert.equal(patch.statusCode, 200, patch.body);
  assert.equal(patch.json().enabled, false);
  const renamed = await call("PATCH", base + `/queues/${queue}`, {
    name: "Renamed support",
  });
  assert.equal(renamed.json().description, "Billing follow-up");
  assert.equal(renamed.json().priority, "high");
  assert.equal(renamed.json().enabled, false);
  const first = (
    await call("GET", base + `/cases/${caseId}/events?limit=1`)
  ).json();
  assert.ok(first.nextCursor);
  const second = (
    await call(
      "GET",
      base +
        `/cases/${caseId}/events?limit=1&before=${encodeURIComponent(first.nextCursor.before)}&beforeId=${first.nextCursor.beforeId}`,
    )
  ).json();
  assert.notEqual(first.items[0].id, second.items[0].id);
});
