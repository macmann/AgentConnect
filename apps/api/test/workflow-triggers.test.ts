import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  workflowGraph,
  normalizeWorkflowInput,
  analyzeWorkflow,
} from "@agentconnect/schemas/workflows";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest } from "../src/security.js";
import {
  nextWorkflowOccurrence,
  processWorkflowSchedules,
} from "../src/workflow-triggers.js";
import {
  processWorkflowRun,
  workflowSaver,
  closeWorkflowSaver,
} from "../src/workflow-runtime.js";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  workspace = randomUUID(),
  owner = randomUUID(),
  viewer = randomUUID(),
  outsider = randomUUID(),
  workflow = randomUUID(),
  version = randomUUID(),
  legacy = randomUUID(),
  legacyVersion = randomUUID();
const ownerSession = randomUUID(),
  viewerSession = randomUUID(),
  outsiderSession = randomUUID();
const graph = workflowGraph.parse({
  inputFields: [
    { name: "question", label: "Question", type: "text", required: true },
    { name: "count", label: "Count", type: "number", defaultValue: 3 },
    { name: "enabled", label: "Enabled", type: "boolean" },
    { name: "data", label: "Data", type: "json" },
  ],
  nodes: [
    {
      id: "start",
      type: "input",
      position: { x: 0, y: 0 },
      data: { label: "Start" },
    },
    {
      id: "end",
      type: "output",
      position: { x: 200, y: 0 },
      data: { label: "End" },
    },
  ],
  edges: [{ id: "edge", source: "start", target: "end" }],
});
const oldGraph = workflowGraph.parse({ ...graph, inputFields: [] });
const app = await buildApp();
let address = 0;
async function session(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
  cookie = ownerSession,
) {
  return app.inject({
    method,
    url,
    remoteAddress: `198.18.1.${++address}`,
    headers: {
      origin: config.WEB_ORIGIN,
      cookie: `session=${cookie}`,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
}
async function api(
  method: "GET" | "POST",
  url: string,
  key: string,
  payload?: unknown,
  idempotency = randomUUID(),
) {
  return app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${key}`,
      "idempotency-key": idempotency,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
}
async function makeKey(details = false) {
  const r = await session(
    "POST",
    `/workspaces/${workspace}/operations/api-keys`,
    {
      workflowId: workflow,
      label: "Workflow key",
      scope: "workflow:execute",
      detailsEnabled: details,
    },
  );
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
async function schedule(patch: Record<string, unknown> = {}) {
  const r = await session("POST", `/workflows/${workflow}/schedules`, {
    name: "Daily",
    versionId: version,
    cron: "0 8 * * *",
    timezone: "Asia/Yangon",
    input: { question: "Scheduled" },
    ...patch,
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().id as string;
}
async function due(id: string, date = new Date()) {
  await sql`UPDATE workflow_schedules SET next_run_at=${date} WHERE id=${id}`;
  return date;
}
async function cancelAll() {
  await sql`UPDATE workflow_runs SET status='cancelled',finished_at=now() WHERE workspace_id=${workspace} AND status IN ('queued','running','waiting')`;
  await sql`UPDATE workflow_schedules SET enabled=false WHERE workspace_id=${workspace}`;
}
before(async () => {
  await sql.begin(async (tx) => {
    for (const [user, token] of [
      [owner, ownerSession],
      [viewer, viewerSession],
      [outsider, outsiderSession],
    ]) {
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${user!},${user + "@example.com"},'Trigger fixture','not-used',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(token!)},${user!},now()+interval '1 hour')`;
    }
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Trigger fixture')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Triggers')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${owner},'owner')`;
    await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${workspace},${viewer},'viewer')`;
    for (const [w, v, g] of [
      [workflow, version, graph],
      [legacy, legacyVersion, oldGraph],
    ] as const) {
      await tx`INSERT INTO workflows(id,workspace_id,organization_id,name,description,draft_graph,created_by) VALUES (${w},${workspace},${org},'Trigger workflow','',${tx.json(g)},${owner})`;
      await tx`INSERT INTO workflow_versions(id,workflow_id,workspace_id,organization_id,version,name,graph,published_by) VALUES (${v},${w},${workspace},${org},1,'Trigger workflow',${tx.json(g)},${owner})`;
    }
  });
});
after(async () => {
  const saver = await workflowSaver();
  const runs =
    await sql`SELECT id FROM workflow_runs WHERE workspace_id=${workspace}`;
  for (const r of runs) await saver.deleteThread(r.id);
  await closeWorkflowSaver();
  await sql.begin(async (tx) => {
    for (const table of [
      "tool_executions",
      "workflow_approvals",
      "workflow_node_runs",
      "workflow_runs",
      "workflow_schedules",
      "workspace_api_keys",
      "workflow_versions",
      "workflows",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    await tx`DELETE FROM users WHERE id=ANY(${[owner, viewer, outsider]})`;
  });
  await app.close();
});
test("typed workflow inputs preserve defaults, reject unknown/wrong values and retain legacy text", () => {
  assert.deepEqual(
    JSON.parse(
      normalizeWorkflowInput(graph, {
        question: "Hello",
        enabled: false,
        data: { items: [1, 2] },
      }),
    ),
    { question: "Hello", count: 3, enabled: false, data: { items: [1, 2] } },
  );
  for (const value of [
    {},
    { question: 3 },
    { question: "x", count: "3" },
    { question: "x", unknown: 1 },
    { question: "x", enabled: "false" },
    [],
  ])
    assert.throws(() => normalizeWorkflowInput(graph, value));
  assert.equal(normalizeWorkflowInput(oldGraph, " hello "), "hello");
  assert.throws(() => normalizeWorkflowInput(oldGraph, {}));
  assert(
    analyzeWorkflow({
      ...graph,
      inputFields: [...graph.inputFields, graph.inputFields[0]!],
    }).errors.length,
  );
  assert(
    analyzeWorkflow({
      ...graph,
      inputFields: [
        {
          name: "x",
          label: "X",
          type: "number",
          required: false,
          defaultValue: "bad",
        },
      ],
    }).errors.length,
  );
});
test("cron uses IANA timezones, supports weekly/custom schedules and rejects invalid values", () => {
  const after = new Date("2026-10-23T00:00:00Z");
  assert.equal(
    nextWorkflowOccurrence("0 8 * * *", "Asia/Yangon", after).toISOString(),
    "2026-10-23T01:30:00.000Z",
  );
  assert.equal(
    nextWorkflowOccurrence("0 8 * * 1", "UTC", after).toISOString(),
    "2026-10-26T08:00:00.000Z",
  );
  assert.equal(
    nextWorkflowOccurrence("*/15 * * * *", "UTC", after).toISOString(),
    "2026-10-23T00:15:00.000Z",
  );
  assert.throws(() => nextWorkflowOccurrence("0 0 0 * * *", "UTC"));
  assert.throws(() => nextWorkflowOccurrence("0 25 * * *", "UTC"));
  assert.throws(() => nextWorkflowOccurrence("0 8 * * *", "Mars/Olympus"));
  const dst = nextWorkflowOccurrence(
    "0 9 * * *",
    "America/New_York",
    new Date("2026-11-01T00:00:00Z"),
  );
  assert.equal(dst.toISOString(), "2026-11-01T14:00:00.000Z");
});
test("session manual execution accepts typed objects and keeps text workflows compatible", async () => {
  const r = await session("POST", `/workflows/${workflow}/runs`, {
    revision: 1,
    input: { question: "Manual" },
  });
  assert.equal(r.statusCode, 202, r.body);
  assert.equal(
    (
      await session("POST", `/workflows/${workflow}/runs`, {
        revision: 1,
        input: { question: 5 },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await session("POST", `/workflows/${legacy}/runs`, {
        revision: 1,
        input: "Legacy",
      })
    ).statusCode,
    202,
  );
  await cancelAll();
});
test("workflow API keys queue published runs idempotently and expose key-bound results with explicit details", async () => {
  const issued = await makeKey(true),
    key = issued.key ?? issued.token;
  assert(key, JSON.stringify(issued));
  const endpoint = `/api/v1/workflows/${workflow}/runs`,
    requestId = randomUUID(),
    payload = { versionId: version, input: { question: "API", count: 5 } };
  const [a, b] = await Promise.all([
    api("POST", endpoint, key, payload, requestId),
    api(
      "POST",
      endpoint,
      key,
      { input: { count: 5, question: "API" }, versionId: version },
      requestId,
    ),
  ]);
  assert.equal(a.statusCode, 202, a.body);
  assert.equal(b.statusCode, 202, b.body);
  assert.equal(a.json().id, b.json().id);
  assert.equal(
    (
      await api(
        "POST",
        endpoint,
        key,
        { ...payload, input: { question: "Other" } },
        requestId,
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (await api("POST", endpoint, key, { input: { question: 1 } })).statusCode,
    400,
  );
  assert.equal(
    (
      await api("POST", endpoint, key, {
        input: { question: "x" },
        versionId: legacyVersion,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await api("GET", "/api/v1/resources", key)).json().type,
    "workflow",
  );
  assert.equal(
    (await api("POST", `/api/v1/workflows/${legacy}/runs`, key, { input: "x" }))
      .statusCode,
    403,
  );
  assert.equal((await session("POST", endpoint, payload)).statusCode, 401);
  await processWorkflowRun();
  const read = await api("GET", endpoint + "/" + a.json().id, key);
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().status, "completed");
  assert.deepEqual(read.json().output, { question: "API", count: 5 });
  assert.equal(read.json().nodes, undefined);
  const details = await api(
    "GET",
    endpoint + "/" + a.json().id + "?includeDetails=true",
    key,
  );
  assert.equal(details.json().nodes.length, 2);
  const other = await makeKey(),
    otherKey = other.key ?? other.token;
  assert.equal(
    (await api("GET", endpoint + "/" + a.json().id, otherKey)).statusCode,
    404,
  );
  assert.equal(
    (
      await api(
        "GET",
        endpoint + "/" + a.json().id + "?includeDetails=true",
        otherKey,
      )
    ).statusCode,
    403,
  );
  assert.equal((await api("POST", "/mcp", key, {})).statusCode, 400);
  await cancelAll();
});
test("revoked API keys cannot start or execute queued runs", async () => {
  const issued = await makeKey(),
    key = issued.key ?? issued.token;
  const r = await api("POST", `/api/v1/workflows/${workflow}/runs`, key, {
    input: { question: "Revoke" },
  });
  assert.equal(r.statusCode, 202, r.body);
  await sql`UPDATE workspace_api_keys SET revoked_at=now() WHERE token_hash=${digest(key)}`;
  assert.equal((await api("GET", "/api/v1/resources", key)).statusCode, 401);
  await processWorkflowRun();
  const [run] =
    await sql`SELECT status,error_code FROM workflow_runs WHERE id=${r.json().id}`;
  assert.equal(run!.status, "failed");
  assert.equal(run!.error_code, "WORKFLOW_KEY_REVOKED");
  await cancelAll();
});
test("schedule setup previews occurrences, requires permissions, validates version/input and prevents stale updates", async () => {
  const endpoint = `/workflows/${workflow}/schedules`;
  const preview = await session("POST", endpoint + "/preview", {
    cron: "0 8 * * *",
    timezone: "Asia/Yangon",
  });
  assert.equal(preview.json().times.length, 5);
  assert.equal(
    (await session("GET", endpoint, undefined, outsiderSession)).statusCode,
    403,
  );
  assert.equal(
    (await session("POST", endpoint, {}, viewerSession)).statusCode,
    403,
  );
  const bad = await session("POST", endpoint, {
    name: "Bad",
    versionId: legacyVersion,
    cron: "0 8 * * *",
    timezone: "UTC",
    input: { question: "x" },
  });
  assert.equal(bad.statusCode, 400);
  const id = await schedule(),
    [saved] = await sql`SELECT * FROM workflow_schedules WHERE id=${id}`;
  const update = {
    name: "Edited",
    versionId: version,
    cron: "0 9 * * 1",
    timezone: "UTC",
    input: { question: "Edited" },
    revision: saved!.revision,
  };
  assert.equal(
    (await session("PUT", endpoint + "/" + id, update)).statusCode,
    200,
  );
  assert.equal(
    (await session("PUT", endpoint + "/" + id, update)).statusCode,
    409,
  );
  assert.equal(
    (await session("DELETE", endpoint + "/" + id, { revision: 2 })).statusCode,
    200,
  );
  await cancelAll();
});
test("concurrent schedulers enqueue one immutable occurrence and reruns do not duplicate it", async () => {
  const id = await schedule(),
    now = await due(id);
  await Promise.all([
    processWorkflowSchedules(now),
    processWorkflowSchedules(now),
  ]);
  await processWorkflowSchedules(now);
  const runs = await sql`SELECT * FROM workflow_runs WHERE schedule_id=${id}`;
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.version_id, version);
  assert.deepEqual(JSON.parse(runs[0]!.input), {
    question: "Scheduled",
    count: 3,
  });
  const [s] =
    await sql`SELECT next_run_at,last_error FROM workflow_schedules WHERE id=${id}`;
  assert(new Date(s!.next_run_at) > now);
  assert.equal(s!.last_error, null);
  await processWorkflowRun();
  const [completed] =
    await sql`SELECT output,status FROM workflow_runs WHERE id=${runs[0]!.id}`;
  assert.equal(completed!.status, "completed");
  assert.deepEqual(completed!.output, { question: "Scheduled", count: 3 });
  await cancelAll();
});
test("overlap, missed occurrences and paused schedules obey configured policies", async () => {
  const id = await schedule(),
    now = await due(id);
  await processWorkflowSchedules(now);
  await due(id, new Date(now.getTime() + 1));
  await processWorkflowSchedules(new Date(now.getTime() + 2));
  let [s] = await sql`SELECT last_error FROM workflow_schedules WHERE id=${id}`;
  assert.equal(s!.last_error, "OVERLAP_SKIPPED");
  await sql`UPDATE workflow_schedules SET overlap_policy='allow' WHERE id=${id}`;
  await due(id, new Date(now.getTime() + 3));
  await processWorkflowSchedules(new Date(now.getTime() + 4));
  assert.equal(
    (await sql`SELECT id FROM workflow_runs WHERE schedule_id=${id}`).length,
    2,
  );
  await cancelAll();
  const skip = await schedule(),
    late = new Date(Date.now() - 3600000);
  await due(skip, late);
  await processWorkflowSchedules();
  [s] = await sql`SELECT last_error FROM workflow_schedules WHERE id=${skip}`;
  assert.equal(s!.last_error, "MISSED_OCCURRENCE_SKIPPED");
  assert.equal(
    (await sql`SELECT id FROM workflow_runs WHERE schedule_id=${skip}`).length,
    0,
  );
  await cancelAll();
  const catchup = await schedule({ missedPolicy: "run_once" });
  await due(catchup, late);
  await processWorkflowSchedules();
  await processWorkflowSchedules();
  assert.equal(
    (await sql`SELECT id FROM workflow_runs WHERE schedule_id=${catchup}`)
      .length,
    1,
  );
  await cancelAll();
});
test("revoked schedule creator permissions disable the schedule without a run", async () => {
  const id = await schedule();
  await due(id);
  await sql`DELETE FROM memberships WHERE user_id=${owner} AND organization_id=${org}`;
  try {
    await processWorkflowSchedules();
    const [s] =
      await sql`SELECT enabled,last_error FROM workflow_schedules WHERE id=${id}`;
    assert.equal(s!.enabled, false);
    assert.equal(s!.last_error, "SCHEDULE_ACCESS_REVOKED");
    assert.equal(
      (await sql`SELECT id FROM workflow_runs WHERE schedule_id=${id}`).length,
      0,
    );
  } finally {
    await sql`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${owner},'owner')`;
    await cancelAll();
  }
});
test("API expiry, issuer permission loss and archived workflows revoke integration access", async () => {
  const issued = await makeKey(),
    key = issued.key ?? issued.token;
  await sql`UPDATE workspace_api_keys SET expires_at=now()-interval '1 second' WHERE token_hash=${digest(key)}`;
  assert.equal((await api("GET", "/api/v1/resources", key)).statusCode, 401);
  await sql`UPDATE workspace_api_keys SET expires_at=now()+interval '1 hour' WHERE token_hash=${digest(key)}`;
  await sql`DELETE FROM memberships WHERE user_id=${owner} AND organization_id=${org}`;
  try {
    assert.equal((await api("GET", "/api/v1/resources", key)).statusCode, 403);
  } finally {
    await sql`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${owner},'owner')`;
  }
  await sql`UPDATE workflows SET archived_at=now() WHERE id=${workflow}`;
  try {
    assert.equal(
      (
        await api("POST", `/api/v1/workflows/${workflow}/runs`, key, {
          input: { question: "Archived" },
        })
      ).statusCode,
      404,
    );
  } finally {
    await sql`UPDATE workflows SET archived_at=NULL WHERE id=${workflow}`;
  }
});
test("workspace quotas reject extra API runs and record skipped scheduled occurrences", async () => {
  const issued = await makeKey(),
    key = issued.key ?? issued.token;
  const scheduleId = await schedule({ overlapPolicy: "allow" });
  for (let i = 0; i < 20; i++)
    await sql`INSERT INTO workflow_runs(id,workflow_id,version_id,workspace_id,organization_id,user_id,graph_snapshot,input,status) VALUES (${randomUUID()},${workflow},${version},${workspace},${org},${owner},${sql.json(graph)},'{}','queued')`;
  assert.equal(
    (
      await api("POST", `/api/v1/workflows/${workflow}/runs`, key, {
        input: { question: "Quota" },
      })
    ).statusCode,
    429,
  );
  const now = await due(scheduleId);
  await processWorkflowSchedules(now);
  const [s] =
    await sql`SELECT last_error FROM workflow_schedules WHERE id=${scheduleId}`;
  assert.equal(s!.last_error, "WORKSPACE_QUOTA_SKIPPED");
  assert.equal(
    (await sql`SELECT id FROM workflow_runs WHERE schedule_id=${scheduleId}`)
      .length,
    0,
  );
  await cancelAll();
});
test("paused schedules stay idle and can resume through a revision-protected edit", async () => {
  const id = await schedule({ enabled: false });
  await due(id);
  assert.equal(await processWorkflowSchedules(), false);
  const update = await session(
    "PUT",
    `/workflows/${workflow}/schedules/${id}`,
    {
      revision: 1,
      name: "Resumed",
      versionId: version,
      cron: "*/5 * * * *",
      timezone: "UTC",
      input: { question: "Resume" },
      enabled: true,
    },
  );
  assert.equal(update.statusCode, 200, update.body);
  const now = await due(id);
  await processWorkflowSchedules(now);
  assert.equal(
    (await sql`SELECT id FROM workflow_runs WHERE schedule_id=${id}`).length,
    1,
  );
  await cancelAll();
});
test("scheduled execution rechecks the creator after a run was queued", async () => {
  const id = await schedule();
  const now = await due(id);
  await processWorkflowSchedules(now);
  await sql`DELETE FROM memberships WHERE user_id=${owner} AND organization_id=${org}`;
  try {
    await processWorkflowRun();
    const [run] =
      await sql`SELECT status,error_code FROM workflow_runs WHERE schedule_id=${id}`;
    assert.equal(run!.status, "failed");
    assert.equal(run!.error_code, "WORKFLOW_ACCESS_REVOKED");
  } finally {
    await sql`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${owner},'owner')`;
    await cancelAll();
  }
});
