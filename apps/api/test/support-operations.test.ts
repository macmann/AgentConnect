import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql, closeDb } from "../src/db.js";
import { config } from "../src/config.js";
import { digest } from "../src/security.js";
import { agentConfig } from "@agentconnect/schemas/agents";
import { queueOperations } from "@agentconnect/schemas/support";
import {
  queueIsOpen,
  caseSLA,
  processSupportOperations,
} from "../src/support/operations.js";
import { processSupportRouting } from "../src/support/routing.js";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  workspace = randomUUID(),
  sibling = randomUUID(),
  agent = randomUUID(),
  users: Record<string, string> = {},
  sessions: Record<string, string> = {},
  base = `/workspaces/${workspace}/support`;
const controllers: AbortController[] = [];
let remoteAddress = "127.0.0.51",
  server = "";
const app = await buildApp({
  providerFactory: () => ({
    async *stream() {
      yield { type: "token", text: "Fixture reply" };
    },
  }),
});
async function call(
  method: "GET" | "POST" | "PATCH" | "PUT",
  url: string,
  body?: unknown,
  role = "owner",
) {
  return app.inject({
    method,
    url,
    remoteAddress,
    headers: {
      origin: config.WEB_ORIGIN,
      cookie: `session=${sessions[role]}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function queue(
  operations: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  const r = await call("POST", base + "/queues", {
    name: "Queue " + randomUUID().slice(0, 8),
    operations,
    ...extra,
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
async function conversation() {
  const c = randomUUID();
  await sql`INSERT INTO conversations(id,organization_id,workspace_id,agent_id,user_id,config_snapshot,model_snapshot) VALUES (${c},${org},${workspace},${agent},${users.owner!},${sql.json(agentConfig.parse({ modelId: randomUUID() }))},'{}')`;
  return c;
}
async function supportCase(q: string | null = null) {
  const c = await conversation();
  const r = await call("POST", base + "/cases", {
    conversationId: c,
    queueId: q,
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
async function claim(id: string, role = "operator") {
  const r = await call("POST", base + "/cases/" + id + "/claim", {}, role);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function enableRouting(q: string) {
  for (const role of ["operator", "second"]) {
    let r = await call(
      "PUT",
      base + "/operators/" + users[role]! + "/profile",
      { capacityLimit: 1 },
    );
    assert.equal(r.statusCode, 200, r.body);
    r = await call(
      "POST",
      base + "/operators/" + users[role]! + "/presence",
      { status: "available" },
      role,
    );
    assert.equal(r.statusCode, 200, r.body);
  }
  const r = await call("PUT", base + "/queues/" + q + "/members", {
    members: [{ userId: users.operator }, { userId: users.second }],
  });
  assert.equal(r.statusCode, 200, r.body);
}
before(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Operations fixtures')`;
    for (const id of [workspace, sibling])
      await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${id},${org},'Operations workspace')`;
    for (const role of ["owner", "operator", "second", "analyst", "outsider"]) {
      users[role] = randomUUID();
      sessions[role] = randomUUID();
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${users[role]!},${users[role] + "@example.invalid"},${role},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(sessions[role]!)},${users[role]!},now()+interval '1 hour')`;
      if (role !== "outsider")
        await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${role === "owner" ? null : workspace},${users[role]!},${role === "second" ? "operator" : role})`;
    }
    await tx`INSERT INTO agents(id,organization_id,workspace_id,name,description,public_description,draft_config,created_by) VALUES (${agent},${org},${workspace},'Operations fixture','','','{}',${users.owner!})`;
  });
  server = await app.listen({ port: 0, host: "127.0.0.1" });
});
beforeEach(async () => {
  remoteAddress = `127.${randomBytes(1)[0]}.${randomBytes(1)[0]}.51`;
  await sql`DELETE FROM handoff_events WHERE workspace_id=${workspace}`;
  await sql`DELETE FROM conversations WHERE workspace_id=${workspace}`;
  await sql`DELETE FROM support_policies WHERE workspace_id=${workspace}`;
  await sql`UPDATE support_queues SET operations_config='{}' WHERE workspace_id IN (${workspace},${sibling})`;
  await sql`DELETE FROM support_queues WHERE workspace_id IN (${workspace},${sibling})`;
  await sql`DELETE FROM operator_profiles WHERE workspace_id=${workspace}`;
});
after(async () => {
  for (const c of controllers) c.abort();
  app.server.closeAllConnections();
  await sql.begin(async (tx) => {
    await tx`DELETE FROM handoff_events WHERE organization_id=${org}`;
    await tx`DELETE FROM conversations WHERE organization_id=${org}`;
    await tx`UPDATE support_queues SET operations_config='{}' WHERE organization_id=${org}`;
    await tx`DELETE FROM agents WHERE organization_id=${org}`;
    await tx`DELETE FROM audit_events WHERE organization_id=${org}`;
    await tx`DELETE FROM memberships WHERE organization_id=${org}`;
    await tx`DELETE FROM workspaces WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    for (const u of Object.values(users))
      await tx`DELETE FROM users WHERE id=${u}`;
  });
  await app.close();
  await closeDb();
});
test("Business hours handle timezone boundaries, DST, closed days and strict schedule validation", () => {
  const cfg = queueOperations.parse({
    businessHours: {
      enabled: true,
      timezone: "America/New_York",
      weekly: [{ weekday: 1, startMinute: 540, endMinute: 1020 }],
    },
  });
  assert.equal(queueIsOpen(cfg, new Date("2026-03-09T13:00:00Z")), true);
  assert.equal(queueIsOpen(cfg, new Date("2026-03-09T21:00:00Z")), false);
  assert.equal(queueIsOpen(cfg, new Date("2026-03-08T14:00:00Z")), false);
  assert.equal(queueIsOpen(cfg, new Date("2026-01-05T13:59:00Z")), false);
  assert.equal(queueIsOpen(cfg, new Date("2026-01-05T14:00:00Z")), true);
  assert.equal(
    queueOperations.safeParse({ businessHours: { timezone: "Made/up" } })
      .success,
    false,
  );
  assert.equal(
    queueOperations.safeParse({
      businessHours: {
        weekly: [
          { weekday: 1, startMinute: 100, endMinute: 300 },
          { weekday: 1, startMinute: 250, endMinute: 500 },
        ],
      },
    }).success,
    false,
  );
});
test("SLA targets distinguish completed timely actions, warning, breach and paused resolution", () => {
  const sla = queueOperations.parse({
      sla: {
        assignmentSeconds: 100,
        firstResponseSeconds: 100,
        resolutionSeconds: 100,
      },
    }),
    now = new Date("2026-01-01T00:01:30Z");
  const s = {
    status: "waiting_customer",
    requested_at: "2026-01-01T00:00:00Z",
    first_assigned_at: "2026-01-01T00:00:20Z",
    resolution_paused_at: "2026-01-01T00:00:30Z",
    resolution_paused_seconds: 0,
    sla_snapshot: sla,
  };
  let result = caseSLA(s, now);
  assert.equal(result.sla_state, "warning");
  assert.equal(result.sla_details.assignment!.state, "on_track");
  assert.equal(result.sla_details.resolution!.elapsedSeconds, 30);
  result = caseSLA(
    { ...s, first_response_at: "2026-01-01T00:00:50Z" },
    new Date("2026-01-01T01:00:00Z"),
  );
  assert.equal(result.sla_state, "on_track");
  result = caseSLA(
    {
      ...s,
      status: "resolved",
      resolved_at: "2026-01-01T00:02:00Z",
      resolution_paused_at: null,
      resolution_paused_seconds: 0,
    },
    now,
  );
  assert.equal(result.sla_state, "breached");
});
test("Closed queue saves offline cases without automatic assignment; fallback and continue-with-AI respect policy", async () => {
  const q = await queue(
    {
      businessHours: {
        enabled: true,
        weekly: [],
        afterHours: "create_offline_case",
      },
    },
    {
      routingStrategy: "least_loaded",
      assignmentMode: "automatic",
      isDefault: true,
    },
  );
  await enableRouting(q.id);
  const s = await supportCase(q.id);
  await processSupportRouting();
  let [live] = await sql`SELECT * FROM support_cases WHERE id=${s.id}`;
  assert.equal(live!.status, "queued");
  const fallback = await queue();
  let r = await call("PATCH", base + "/queues/" + q.id, {
    operations: {
      businessHours: {
        enabled: true,
        weekly: [],
        afterHours: "route_to_fallback_queue",
        fallbackQueueId: fallback.id,
      },
    },
  });
  assert.equal(r.statusCode, 200, r.body);
  const transferred = await supportCase(q.id);
  assert.equal(transferred.queue_id, fallback.id);
  r = await call("PATCH", base + "/queues/" + q.id, {
    operations: {
      businessHours: {
        enabled: true,
        weekly: [],
        afterHours: "continue_with_ai",
      },
    },
  });
  assert.equal(r.statusCode, 200);
  r = await call("PUT", base + "/policy", {
    humanEntryMode: "always_available",
    defaultQueueId: q.id,
    aiTriageEnabled: false,
    generateHandoffSummary: false,
  });
  assert.equal(r.statusCode, 200, r.body);
  const c = await conversation();
  r = await call("POST", "/conversations/" + c + "/handoff", {
    action: "request",
  });
  assert.equal(r.statusCode, 409, r.body);
  [live] = await sql`SELECT conversation_mode FROM conversations WHERE id=${c}`;
  assert.equal(live!.conversation_mode, "ai");
  r = await call("GET", "/conversations/" + c + "/handoff");
  assert.equal(r.json().access.canRequest, false);
  assert.equal(r.json().access.businessHours.open, false);
});
test("Queue operations reject invalid targets, cross-tenant fallback IDs and cyclic fallback graphs", async () => {
  const q = await queue(),
    b = await queue();
  const foreign = randomUUID();
  await sql`INSERT INTO support_queues(id,organization_id,workspace_id,name) VALUES (${foreign},${org},${sibling},'Foreign')`;
  let r = await call("PATCH", base + "/queues/" + q.id, {
    operations: { sla: { resolutionSeconds: 0 } },
  });
  assert.equal(r.statusCode, 400);
  r = await call("PATCH", base + "/queues/" + q.id, {
    operations: {
      businessHours: {
        afterHours: "route_to_fallback_queue",
        fallbackQueueId: foreign,
      },
    },
  });
  assert.equal(r.statusCode, 400);
  await assert.rejects(
    sql`UPDATE support_queues SET operations_config=${sql.json({ businessHours: { fallbackQueueId: foreign } })} WHERE id=${q.id}`,
    (e: { code: string }) => e.code === "23503",
  );
  r = await call("PATCH", base + "/queues/" + q.id, {
    operations: {
      businessHours: {
        afterHours: "route_to_fallback_queue",
        fallbackQueueId: b.id,
      },
    },
  });
  assert.equal(r.statusCode, 200);
  r = await call("PATCH", base + "/queues/" + b.id, {
    operations: {
      businessHours: {
        afterHours: "route_to_fallback_queue",
        fallbackQueueId: q.id,
      },
    },
  });
  assert.equal(r.statusCode, 400);
  r = await call(
    "PATCH",
    base + "/queues/" + q.id,
    { operations: {} },
    "analyst",
  );
  assert.equal(r.statusCode, 403);
});
test("SLA worker persists deduplicated warning/breach notifications and waiting transitions pause the clock", async () => {
  const q = await queue({
      sla: { firstResponseSeconds: 100, resolutionSeconds: 100 },
    }),
    s = await supportCase(q.id);
  await claim(s.id);
  await sql`UPDATE support_cases SET requested_at=clock_timestamp()-interval '85 seconds' WHERE id=${s.id}`;
  await processSupportOperations();
  let [live] = await sql`SELECT * FROM support_cases WHERE id=${s.id}`;
  assert.equal(live!.sla_state, "warning");
  let r = await call(
    "POST",
    base + "/cases/" + s.id + "/status",
    { status: "waiting_customer" },
    "operator",
  );
  assert.equal(r.statusCode, 200, r.body);
  await sql`UPDATE support_cases SET resolution_paused_at=clock_timestamp()-interval '20 seconds',operations_next_attempt_at=clock_timestamp() WHERE id=${s.id}`;
  r = await call(
    "POST",
    base + "/cases/" + s.id + "/status",
    { status: "active" },
    "operator",
  );
  assert.equal(r.statusCode, 200);
  [live] = await sql`SELECT * FROM support_cases WHERE id=${s.id}`;
  assert.ok(live!.resolution_paused_seconds >= 19);
  await sql`UPDATE support_cases SET requested_at=clock_timestamp()-interval '150 seconds',operations_next_attempt_at=clock_timestamp() WHERE id=${s.id}`;
  await Promise.all([processSupportOperations(), processSupportOperations()]);
  await sql`UPDATE support_cases SET operations_next_attempt_at=clock_timestamp() WHERE id=${s.id}`;
  await processSupportOperations();
  const events =
    await sql`SELECT type,payload->>'metric' AS metric FROM support_events WHERE support_case_id=${s.id} AND type='sla.breached'`;
  assert.equal(events.length, 2);
  r = await call("GET", base + "/notifications", undefined, "operator");
  assert.equal(r.statusCode, 200);
  assert.ok(
    r.json().items.some((n: { kind: string }) => n.kind === "sla.breached"),
  );
});
test("Expired assignment releases capacity, excludes previous operators and bounds automatic retries", async () => {
  const q = await queue(
    { acceptanceTimeoutSeconds: 15, maxAssignmentAttempts: 1 },
    { routingStrategy: "least_loaded", assignmentMode: "automatic" },
  );
  await enableRouting(q.id);
  const s = await supportCase(q.id);
  await processSupportRouting();
  let [live] = await sql`SELECT * FROM support_cases WHERE id=${s.id}`;
  assert.equal(live!.status, "assigned");
  const assigned = live!.assigned_operator_id;
  await sql`UPDATE support_cases SET acceptance_deadline=clock_timestamp()-interval '1 second' WHERE id=${s.id}`;
  const lateAcceptance = await call(
    "POST",
    base + "/cases/" + s.id + "/status",
    { status: "active" },
    assigned === users.operator ? "operator" : "second",
  );
  assert.equal(lateAcceptance.statusCode, 409, lateAcceptance.body);
  await Promise.all([processSupportOperations(), processSupportOperations()]);
  [live] = await sql`SELECT * FROM support_cases WHERE id=${s.id}`;
  assert.equal(live!.status, "queued");
  assert.equal(live!.assigned_operator_id, null);
  assert.equal(live!.assignment_timeout_count, 1);
  assert.deepEqual(live!.timed_out_operator_ids, [assigned]);
  await processSupportRouting();
  [live] = await sql`SELECT * FROM support_cases WHERE id=${s.id}`;
  assert.equal(live!.status, "queued");
  const [count] =
    await sql`SELECT count(*)::int AS n FROM support_events WHERE support_case_id=${s.id} AND type='assignment.expired'`;
  assert.equal(count!.n, 1);
  const r = await call("POST", base + "/cases/" + s.id + "/assign", {
    operatorId: users.second,
  });
  assert.equal(r.statusCode, 200, r.body);
  await claimAccepted(s.id, "second");
});
async function claimAccepted(id: string, role: string) {
  const r = await call(
    "POST",
    base + "/cases/" + id + "/status",
    { status: "active" },
    role,
  );
  assert.equal(r.statusCode, 200, r.body);
  const [live] =
    await sql`SELECT acceptance_deadline FROM support_cases WHERE id=${id}`;
  assert.equal(live!.acceptance_deadline, null);
}
test("Transfers retain human control, original SLA snapshot, tenant safety and audit; priority requires supervision", async () => {
  const q = await queue({ sla: { resolutionSeconds: 500 } }),
    b = await queue(),
    s = await supportCase(q.id);
  await claim(s.id);
  let r = await call(
    "POST",
    base + "/cases/" + s.id + "/transfer",
    { queueId: b.id, reason: "Billing team needed" },
    "second",
  );
  assert.equal(r.statusCode, 403);
  r = await call(
    "POST",
    base + "/cases/" + s.id + "/transfer",
    { queueId: b.id, reason: "Billing team needed" },
    "operator",
  );
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, "queued");
  assert.equal(r.json().conversation_mode, "waiting_human");
  assert.equal(r.json().transfer_count, 1);
  assert.equal(r.json().sla_snapshot.sla.resolutionSeconds, 500);
  r = await call(
    "POST",
    base + "/cases/" + s.id + "/priority",
    { priority: "urgent", reason: "Time sensitive" },
    "operator",
  );
  assert.equal(r.statusCode, 403);
  r = await call("POST", base + "/cases/" + s.id + "/priority", {
    priority: "urgent",
    reason: "Time sensitive",
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().priority, "urgent");
  r = await call("POST", base + "/cases/" + s.id + "/transfer", {
    queueId: randomUUID(),
    reason: "Invalid",
  });
  assert.equal(r.statusCode, 404);
  const [audit] =
    await sql`SELECT count(*)::int AS n FROM audit_events WHERE workspace_id=${workspace} AND action='support.case.transfer'`;
  assert.equal(audit!.n, 1);
});
test("Notifications are recipient-scoped, omit private contents, paginate, acknowledge idempotently and cascade", async () => {
  const s = await supportCase();
  await claim(s.id);
  await call(
    "POST",
    base + "/cases/" + s.id + "/notes",
    { content: "PRIVATE NOTE" },
    "operator",
  );
  await call("POST", "/conversations/" + s.conversation_id + "/handoff", {
    action: "message",
    content: "CUSTOMER SECRET",
  });
  let r = await call(
    "GET",
    base + "/notifications?limit=1",
    undefined,
    "owner",
  );
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().items.length, 1);
  assert.ok(r.json().nextCursor);
  assert.ok(!r.body.includes("PRIVATE NOTE"));
  assert.ok(!r.body.includes("CUSTOMER SECRET"));
  const n = r.json().items[0];
  r = await call(
    "POST",
    base + "/notifications/" + n.id + "/read",
    {},
    "operator",
  );
  assert.equal(r.statusCode, 404);
  for (let i = 0; i < 2; i++) {
    r = await call("POST", base + "/notifications/" + n.id + "/read", {});
    assert.equal(r.statusCode, 200);
  }
  r = await call("GET", base + "/notifications", undefined, "outsider");
  assert.equal(r.statusCode, 403);
  await sql`DELETE FROM handoff_events WHERE conversation_id=${s.conversation_id}`;
  await sql`DELETE FROM conversations WHERE id=${s.conversation_id}`;
  const [count] =
    await sql`SELECT count(*)::int AS n FROM support_notifications WHERE support_case_id=${s.id}`;
  assert.equal(count!.n, 0);
});
test("Inbox filters combine SLA, language and inclusive UTC dates without leaking sibling cases", async () => {
  const first = await supportCase(),
    second = await supportCase();
  await sql`UPDATE support_cases SET created_at='2026-01-15T23:59:59Z',sla_state='warning',triage_result='{"language":"en"}' WHERE id=${first.id}`;
  await sql`UPDATE support_cases SET created_at='2026-01-16T00:00:00Z',sla_state='breached',triage_result='{"language":"fr"}' WHERE id=${second.id}`;
  const response = await call(
    "GET",
    base +
      "/cases?scope=all&slaState=warning&language=en&fromDate=2026-01-15&toDate=2026-01-15",
  );
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(response.body.includes(first.id));
  assert.ok(!response.body.includes(second.id));
  const empty = await call(
    "GET",
    base + "/cases?scope=all&fromDate=2026-01-17",
  );
  assert.equal(empty.statusCode, 200, empty.body);
  assert.ok(!empty.body.includes(first.id));
  assert.ok(!empty.body.includes(second.id));
  assert.equal((await call("GET", base + "/cases?language=e")).statusCode, 400);
});
test("Analytics and supervision reflect retained case journeys and enforce read-only roles", async () => {
  const q = await queue({ sla: { resolutionSeconds: 1 } }),
    s = await supportCase(q.id);
  await claim(s.id);
  await sql`UPDATE support_cases SET requested_at=now()-interval '10 seconds' WHERE id=${s.id}`;
  const r = await call(
    "POST",
    base + "/cases/" + s.id + "/resolve",
    { summary: "Private summary" },
    "operator",
  );
  assert.equal(r.statusCode, 200, r.body);
  let a = await call("GET", base + "/analytics?days=7", undefined, "analyst");
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(a.json().totals.cases_created, 1);
  assert.equal(a.json().totals.cases_resolved, 1);
  assert.equal(a.json().totals.breached_cases, 1);
  assert.equal(a.json().journeys.returned_to_ai_conversations, 1);
  assert.equal(a.json().deflection, null);
  assert.ok(!a.body.includes("Private summary"));
  a = await call("GET", base + "/supervision", undefined, "analyst");
  assert.equal(a.statusCode, 403);
  a = await call("GET", base + "/supervision");
  assert.equal(a.statusCode, 200);
  assert.equal(a.json().counts.backlog, 0);
  a = await call("GET", base + "/analytics?days=91");
  assert.equal(a.statusCode, 400);
  a = await call(
    "GET",
    `/workspaces/${sibling}/support/analytics`,
    undefined,
    "operator",
  );
  assert.equal(a.statusCode, 403);
});
test("Support SSE sends authorized invalidations promptly, preserves CORS and aborts on revocation", async () => {
  const abort = new AbortController();
  controllers.push(abort);
  const r = await fetch(server + base + "/stream", {
    headers: {
      cookie: `session=${sessions.operator}`,
      origin: config.WEB_ORIGIN,
    },
    signal: abort.signal,
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), config.WEB_ORIGIN);
  const reader = r.body!.getReader();
  let text = new TextDecoder().decode((await reader.read()).value);
  assert.ok(text.includes("event: refresh"));
  assert.ok(!text.includes("payload"));
  await supportCase();
  let refreshed = false;
  for (let i = 0; i < 4; i++) {
    text = new TextDecoder().decode((await reader.read()).value);
    if (text.includes("event: refresh")) {
      refreshed = true;
      break;
    }
  }
  assert.equal(refreshed, true);
  await sql`DELETE FROM memberships WHERE user_id=${users.operator!} AND workspace_id=${workspace}`;
  let unavailable = false;
  for (let i = 0; i < 4; i++) {
    const part = await reader.read();
    if (part.done) break;
    text = new TextDecoder().decode(part.value);
    if (text.includes("event: unavailable")) {
      unavailable = true;
      break;
    }
  }
  assert.equal(unavailable, true);
  abort.abort();
  await reader.cancel().catch(() => {});
  await sql`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${workspace},${users.operator!},'operator')`;
});
