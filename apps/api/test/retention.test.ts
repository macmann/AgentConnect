import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest } from "../src/security.js";
import {
  processRetentionCleanup,
  processRetentionObjectDeletion,
} from "../src/retention-worker.js";
import {
  storeKnowledge,
  readKnowledge,
  deleteKnowledge,
} from "../src/knowledge-storage.js";
import { workflowSaver, closeWorkflowSaver } from "../src/workflow-runtime.js";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  foreignOrg = randomUUID(),
  workspace = randomUUID(),
  sibling = randomUUID(),
  foreign = randomUUID();
const user = randomUUID(),
  builder = randomUUID(),
  session = randomUUID(),
  builderSession = randomUUID();
const adminMembership = randomUUID();
const fixtureSubnet = randomBytes(2);
const fixtureAddress = `127.${fixtureSubnet[0]}.${fixtureSubnet[1]}.42`;
const app = await buildApp();
const base = `/workspaces/${workspace}/retention`;
const keys: string[] = [];
const conversations: Record<string, string> = {},
  runs: Record<string, string> = {},
  artifacts: Record<string, string> = {};
let agent = "",
  workflow = "",
  terminalWorkflow = "",
  waitingWorkflow = "",
  connector = "",
  oldSync = "",
  currentSync = "",
  baseline = "",
  evaluation = "";
const settings: {
  enabled: boolean;
  revision: number;
  conversationDays: number | null;
  runDays: number | null;
  artifactDays: number | null;
  connectorDays: number | null;
} = {
  enabled: false,
  revision: 0,
  conversationDays: 30,
  runDays: 30,
  artifactDays: 30,
  connectorDays: 30,
};
async function call(
  method: "GET" | "POST" | "PUT",
  url: string,
  body?: unknown,
  rawSession = session,
) {
  return app.inject({
    method,
    url,
    remoteAddress: fixtureAddress,
    headers: {
      origin: config.WEB_ORIGIN,
      cookie: `session=${rawSession}`,
      "content-type": "application/json",
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function save(overrides: Partial<typeof settings> = {}) {
  const get = await call("GET", base);
  const response = await call("PUT", base, {
    ...settings,
    revision: get.json().policy.revision,
    ...overrides,
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().revision as number;
}
async function queue(revision: number) {
  const response = await call("POST", base + "/run", { revision });
  assert.equal(response.statusCode, 202, response.body);
  return response.json().id as string;
}
async function chatFixture(
  name: string,
  w = workspace,
  o = org,
  status = "completed",
  handoff = "none",
  recent = false,
) {
  const a = w === workspace ? agent : randomUUID(),
    c = randomUUID(),
    r = randomUUID(),
    m = randomUUID(),
    artifact = randomUUID();
  if (w !== workspace)
    await sql`INSERT INTO agents(id,organization_id,workspace_id,name,description,public_description,draft_config,created_by) VALUES (${a},${o},${w},'Other agent','','','{}',${user})`;
  await sql`INSERT INTO conversations(id,organization_id,workspace_id,agent_id,user_id,config_snapshot,model_snapshot,handoff_status,created_at) VALUES (${c},${o},${w},${a},${user},'{}','{}',${handoff},now()-interval '60 days')`;
  await sql`INSERT INTO agent_runs(id,conversation_id,organization_id,workspace_id,status,trace_id,started_at,finished_at) VALUES (${r},${c},${o},${w},${status},'retention-fixture',now()-interval '60 days',${status === "running" ? null : new Date(Date.now() - 60 * 86400000)})`;
  await sql`INSERT INTO messages(id,conversation_id,organization_id,workspace_id,run_id,role,content,created_at) VALUES (${m},${c},${o},${w},${r},'assistant','Retention fixture',now()-interval '60 days')`;
  const key = `generated/${o}/${w}/${artifact}`;
  keys.push(key);
  await storeKnowledge(key, Buffer.from("retained fixture object"));
  await sql`INSERT INTO generated_artifacts(id,organization_id,workspace_id,message_id,name,content_type,storage_key,byte_size,created_at) VALUES (${artifact},${o},${w},${m},'fixture.txt','text/plain',${key},23,now()-interval '60 days')`;
  await sql`UPDATE conversations SET last_activity_at=${new Date(Date.now() - (recent ? 0 : 60 * 86400000))} WHERE id=${c}`;
  conversations[name] = c;
  runs[name] = r;
  artifacts[name] = artifact;
  return { c, r, m, artifact, key };
}
before(async () => {
  await sql`INSERT INTO organizations(id,name) VALUES (${org},'Retention fixture'),(${foreignOrg},'Foreign retention fixture')`;
  await sql`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Retention workspace'),(${sibling},${org},'Sibling workspace'),(${foreign},${foreignOrg},'Foreign workspace')`;
  for (const [id, raw, name] of [
    [user, session, "Admin"],
    [builder, builderSession, "Builder"],
  ]) {
    await sql`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${id!},${id + "@example.invalid"},${name!},'unused',now())`;
    await sql`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(raw!)},${id!},now()+interval '1 hour')`;
  }
  await sql`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${adminMembership},${org},${workspace},${user},'workspace_admin'),(${randomUUID()},${org},${workspace},${builder},'builder')`;
  agent = randomUUID();
  workflow = randomUUID();
  await sql`INSERT INTO agents(id,organization_id,workspace_id,name,description,public_description,draft_config,created_by) VALUES (${agent},${org},${workspace},'Retention agent','','','{}',${user})`;
  await sql`INSERT INTO workflows(id,organization_id,workspace_id,name,description,draft_graph,created_by) VALUES (${workflow},${org},${workspace},'Retention workflow','','{}',${user})`;
  const expired = await chatFixture("expired");
  await sql`INSERT INTO conversation_reviews(id,workspace_id,organization_id,message_id,reviewer_id,rating) VALUES (${randomUUID()},${workspace},${org},${expired.m},${user},'like')`;
  await sql`INSERT INTO collected_submissions(id,workspace_id,organization_id,message_id,conversation_id,block_id,values,submitted_by) VALUES (${randomUUID()},${workspace},${org},${expired.m},${expired.c},'form','{}',${user})`;
  await sql`INSERT INTO handoff_events(id,workspace_id,organization_id,conversation_id,kind,actor_id) VALUES (${randomUUID()},${workspace},${org},${expired.c},'resolved',${user})`;
  await sql`UPDATE conversations SET last_activity_at=now()-interval '60 days' WHERE id=${expired.c}`;
  await chatFixture("recent", workspace, org, "completed", "none", true);
  await chatFixture("running", workspace, org, "running");
  await chatFixture("pending", workspace, org, "completed", "pending");
  await chatFixture("active", workspace, org, "completed", "active");
  await chatFixture("sibling", sibling);
  await chatFixture("foreign", foreign, foreignOrg);
  terminalWorkflow = randomUUID();
  waitingWorkflow = randomUUID();
  for (const [id, status] of [
    [terminalWorkflow, "completed"],
    [waitingWorkflow, "waiting"],
  ]) {
    await sql`INSERT INTO workflow_runs(id,workflow_id,workspace_id,organization_id,user_id,graph_snapshot,input,status,finished_at) VALUES (${id!},${workflow},${workspace},${org},${user},'{}','fixture',${status!},${new Date(Date.now() - 60 * 86400000)})`;
    await sql`INSERT INTO workflow_node_runs(run_id,node_id,workspace_id,organization_id,label,kind,status) VALUES (${id!},'node',${workspace},${org},'Fixture','Agent',${status!})`;
    await sql`INSERT INTO workflow_approvals(id,run_id,node_id,workspace_id,organization_id,prompt,input,decision) VALUES (${randomUUID()},${id!},'node',${workspace},${org},'Fixture','{}','pending')`;
  }
  await workflowSaver();
  for (const thread of [terminalWorkflow, waitingWorkflow]) {
    await sql`INSERT INTO workflow_checkpoints.checkpoints(thread_id,checkpoint_ns,checkpoint_id,checkpoint,metadata) VALUES (${thread},'','fixture','{}','{}')`;
    await sql`INSERT INTO workflow_checkpoints.checkpoint_blobs(thread_id,checkpoint_ns,channel,version,type,blob) VALUES (${thread},'','output','1','json',${Buffer.from("fixture")})`;
    await sql`INSERT INTO workflow_checkpoints.checkpoint_writes(thread_id,checkpoint_ns,checkpoint_id,task_id,idx,channel,type,blob) VALUES (${thread},'','fixture','task',0,'output','json',${Buffer.from("fixture")})`;
  }
  const embedding = randomUUID(),
    kb = randomUUID();
  connector = randomUUID();
  oldSync = randomUUID();
  currentSync = randomUUID();
  await sql`INSERT INTO embedding_models(id,organization_id,workspace_id,name,provider,model_id,base_url,dimensions) VALUES (${embedding},${org},${workspace},'Fixture','openai','fixture','https://api.openai.com/v1',3)`;
  await sql`INSERT INTO knowledge_bases(id,organization_id,workspace_id,name,description,embedding_model_id,dimensions,chunk_size,chunk_overlap,chunk_strategy) VALUES (${kb},${org},${workspace},'Fixture','',${embedding},3,200,0,'recursive')`;
  await sql`INSERT INTO enterprise_connectors(id,organization_id,workspace_id,name,kind,knowledge_base_id,selection,created_by,updated_by) VALUES (${connector},${org},${workspace},'Fixture','s3',${kb},'{}',${user},${user})`;
  for (const [id, status] of [
    [oldSync, "completed"],
    [currentSync, "running"],
  ])
    await sql`INSERT INTO connector_syncs(id,connector_id,organization_id,workspace_id,requested_by,connector_revision,status,finished_at) VALUES (${id!},${connector},${org},${workspace},${user},1,${status!},${new Date(Date.now() - 60 * 86400000)})`;
  const dataset = randomUUID();
  baseline = randomUUID();
  evaluation = randomUUID();
  await sql`INSERT INTO evaluation_datasets(id,organization_id,workspace_id,name,description) VALUES (${dataset},${org},${workspace},'Fixture','')`;
  for (const [id, reference] of [
    [baseline, null],
    [evaluation, baseline],
  ])
    await sql`INSERT INTO evaluation_runs(id,organization_id,workspace_id,agent_id,dataset_id,requested_by,agent_revision,dataset_revision,config_snapshot,model_snapshot,examples_snapshot,evaluator,fingerprint,status,finished_at,baseline_run_id) VALUES (${id!},${org},${workspace},${agent},${dataset},${user},1,1,'{}','{}','[]','{}','fixture','completed',now()-interval '60 days',${reference ?? null})`;
});
after(async () => {
  await closeWorkflowSaver();
  for (const key of keys) await deleteKnowledge(key);
  for (const table of ["checkpoint_writes", "checkpoint_blobs", "checkpoints"])
    await sql.unsafe(
      `DELETE FROM workflow_checkpoints.${table} WHERE thread_id=ANY($1::text[])`,
      [[terminalWorkflow, waitingWorkflow]],
    );
  const scopes = [workspace, sibling, foreign];
  for (const table of [
    "retention_object_deletions",
    "retention_runs",
    "workspace_retention",
    "evaluation_results",
  ])
    await sql.unsafe(
      `DELETE FROM ${table} WHERE workspace_id=ANY($1::uuid[])`,
      [scopes],
    );
  await sql`UPDATE evaluation_runs SET baseline_run_id=NULL WHERE workspace_id=${workspace}`;
  for (const table of [
    "evaluation_runs",
    "agent_quality_gates",
    "evaluation_datasets",
    "connector_items",
    "connector_syncs",
    "enterprise_connectors",
    "knowledge_jobs",
    "knowledge_sources",
    "knowledge_bases",
    "embedding_models",
    "tool_executions",
    "collected_submissions",
    "generated_artifacts",
    "conversation_reviews",
    "handoff_events",
    "messages",
    "agent_runs",
    "conversations",
    "workflow_approvals",
    "workflow_node_runs",
    "workflow_runs",
    "workflow_versions",
    "workflows",
    "agents",
    "audit_events",
    "memberships",
  ])
    await sql.unsafe(
      `DELETE FROM ${table} WHERE workspace_id=ANY($1::uuid[])`,
      [scopes],
    );
  await sql`DELETE FROM workspaces WHERE id=ANY(${scopes}::uuid[])`;
  await sql`DELETE FROM organizations WHERE id=ANY(${[org, foreignOrg]}::uuid[])`;
  await sql`DELETE FROM sessions WHERE user_id=ANY(${[user, builder]}::uuid[])`;
  await sql`DELETE FROM users WHERE id=ANY(${[user, builder]}::uuid[])`;
  await app.close();
});

test("retention defaults to indefinite and enforces workspace administration, revision and valid periods", async () => {
  const response = await call("GET", base);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().policy.enabled, false);
  assert.equal(response.json().policy.revision, 0);
  assert.equal(
    (await call("GET", base, undefined, builderSession)).statusCode,
    200,
  );
  assert.equal(
    (await call("PUT", base, settings, builderSession)).statusCode,
    403,
  );
  for (const w of [sibling, foreign])
    for (const [method, path, body] of [
      ["GET", "", undefined],
      ["PUT", "", settings],
      ["POST", "/preview", { revision: 1 }],
      ["POST", "/run", { revision: 1 }],
    ] as const)
      assert.equal(
        (await call(method, `/workspaces/${w}/retention${path}`, body))
          .statusCode,
        403,
      );
  assert.equal(
    (await call("PUT", base, { ...settings, conversationDays: 0 })).statusCode,
    400,
  );
  assert.equal(
    (await call("PUT", base, { ...settings, conversationDays: 36501 }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await call("PUT", base, {
        ...settings,
        enabled: true,
        conversationDays: null,
        runDays: null,
        artifactDays: null,
        connectorDays: null,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await call("POST", base + "/preview", { revision: 1 })).statusCode,
    409,
  );
  await save();
  assert.equal((await call("PUT", base, settings)).statusCode, 409);
});
test("dry run counts eligible descendants without deleting anything or scheduling work", async () => {
  const revision = await save();
  const response = await call("POST", base + "/preview", { revision });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().counts, {
    conversations: 1,
    agentRuns: 2,
    workflowRuns: 1,
    evaluationRuns: 1,
    artifacts: 2,
    connectorSyncs: 1,
  });
  assert.equal(
    (await sql`SELECT id FROM conversations WHERE id=${conversations.expired!}`)
      .length,
    1,
  );
  assert.equal(
    (await sql`SELECT id FROM retention_runs WHERE workspace_id=${workspace}`)
      .length,
    0,
  );
  assert.equal(
    (await call("POST", base + "/run", { revision })).statusCode,
    409,
  );
  assert.equal(
    (await readKnowledge(keys[0]!, AbortSignal.timeout(5000))).toString(),
    "retained fixture object",
  );
});
test("policy changes cancel queued jobs; revoked administrators cannot run scheduled cleanup", async () => {
  let revision = await save({ enabled: true });
  const job = await queue(revision);
  assert.equal(
    (await call("POST", base + "/run", { revision })).statusCode,
    409,
  );
  revision = await save({ enabled: false });
  assert.equal(
    (await sql`SELECT status FROM retention_runs WHERE id=${job}`)[0]!.status,
    "cancelled",
  );
  await processRetentionCleanup();
  assert.equal(
    (await sql`SELECT id FROM conversations WHERE id=${conversations.expired!}`)
      .length,
    1,
  );
  revision = await save({ enabled: true });
  const revoked = await queue(revision);
  await sql`UPDATE memberships SET role='viewer' WHERE id=${adminMembership}`;
  await processRetentionCleanup();
  assert.equal(
    (await sql`SELECT error_code FROM retention_runs WHERE id=${revoked}`)[0]!
      .error_code,
    "ACCESS_REVOKED",
  );
  await sql`UPDATE memberships SET role='workspace_admin' WHERE id=${adminMembership}`;
});
test("cleanup removes expired tenant data and checkpoints while preserving active work, knowledge, baselines and foreign tenants", async () => {
  const revision = await save({ enabled: true });
  const job = await queue(revision);
  assert.equal(await processRetentionCleanup(), true);
  const [result] =
    await sql`SELECT status,counts FROM retention_runs WHERE id=${job}`;
  assert.equal(result!.status, "completed");
  assert.equal(result!.counts.conversations, 1);
  assert.equal(result!.counts.artifacts, 2);
  for (const name of ["expired"])
    assert.equal(
      (await sql`SELECT id FROM conversations WHERE id=${conversations[name]!}`)
        .length,
      0,
    );
  for (const name of [
    "recent",
    "running",
    "pending",
    "active",
    "sibling",
    "foreign",
  ])
    assert.equal(
      (await sql`SELECT id FROM conversations WHERE id=${conversations[name]!}`)
        .length,
      1,
      name,
    );
  assert.equal(
    (await sql`SELECT id FROM agent_runs WHERE id=${runs.recent!}`).length,
    0,
  );
  assert.equal(
    (await sql`SELECT id FROM workflow_runs WHERE id=${terminalWorkflow}`)
      .length,
    0,
  );
  assert.equal(
    (await sql`SELECT id FROM workflow_runs WHERE id=${waitingWorkflow}`)
      .length,
    1,
  );
  for (const table of [
    "checkpoint_writes",
    "checkpoint_blobs",
    "checkpoints",
  ]) {
    assert.equal(
      (
        await sql.unsafe(
          `SELECT thread_id FROM workflow_checkpoints.${table} WHERE thread_id=$1`,
          [terminalWorkflow],
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await sql.unsafe(
          `SELECT thread_id FROM workflow_checkpoints.${table} WHERE thread_id=$1`,
          [waitingWorkflow],
        )
      ).length,
      1,
    );
  }
  assert.equal(
    (await sql`SELECT id FROM connector_syncs WHERE id=${oldSync}`).length,
    0,
  );
  assert.equal(
    (await sql`SELECT id FROM connector_syncs WHERE id=${currentSync}`).length,
    1,
  );
  assert.equal(
    (await sql`SELECT id FROM enterprise_connectors WHERE id=${connector}`)
      .length,
    1,
  );
  assert.equal(
    (await sql`SELECT id FROM knowledge_bases WHERE workspace_id=${workspace}`)
      .length,
    1,
  );
  assert.equal(
    (await sql`SELECT id FROM evaluation_runs WHERE id=${evaluation}`).length,
    0,
  );
  assert.equal(
    (await sql`SELECT id FROM evaluation_runs WHERE id=${baseline}`).length,
    1,
  );
  assert.equal(
    (
      await sql`SELECT id FROM audit_events WHERE workspace_id=${workspace} AND action='retention.cleanup_completed'`
    ).length,
    1,
  );
  assert.equal(
    (
      await sql`SELECT id FROM retention_object_deletions WHERE workspace_id=${workspace}`
    ).length,
    2,
  );
  assert.equal(
    (await call("GET", `/artifacts/${artifacts.expired!}/grant`)).statusCode,
    404,
  );
});
test("storage deletion retries safely, respects deadlines and never accepts another tenant storage key", async () => {
  let observedSignal: AbortSignal | undefined;
  await processRetentionObjectDeletion(async (_key, signal) => {
    observedSignal = signal;
    throw new Error("credential/body must never be persisted");
  });
  assert.ok(observedSignal);
  const [failed] =
    await sql`SELECT * FROM retention_object_deletions WHERE workspace_id=${workspace} AND attempts=1`;
  assert.equal(failed!.error_code, "OBJECT_DELETE_FAILED");
  assert.ok(failed!.next_attempt_at > new Date());
  await sql`UPDATE retention_object_deletions SET next_attempt_at=now() WHERE workspace_id=${workspace}`;
  await Promise.all([
    processRetentionObjectDeletion(),
    processRetentionObjectDeletion(),
  ]);
  assert.equal(
    (
      await sql`SELECT id FROM retention_object_deletions WHERE workspace_id=${workspace}`
    ).length,
    0,
  );
  await assert.rejects(readKnowledge(keys[0]!, AbortSignal.timeout(5000)));
  for (const name of ["running", "pending", "active", "sibling", "foreign"]) {
    const key = keys.find((v) => v.endsWith(artifacts[name]!))!;
    assert.ok(await readKnowledge(key, AbortSignal.timeout(5000)));
  }
  const bad = randomUUID();
  await sql`INSERT INTO retention_object_deletions(id,workspace_id,organization_id,storage_key) VALUES (${bad},${workspace},${org},${`generated/${foreignOrg}/${foreign}/${artifacts.foreign}`})`;
  let called = false;
  await processRetentionObjectDeletion(async () => {
    called = true;
  });
  assert.equal(called, false);
  assert.equal(
    (
      await sql`SELECT status FROM retention_object_deletions WHERE id=${bad}`
    )[0]!.status,
    "blocked",
  );
});
test("daily schedule creates audited batches and repeated workers are idempotent", async () => {
  await save({ enabled: true });
  await sql`UPDATE workspace_retention SET next_run_at=now()-interval '1 minute' WHERE workspace_id=${workspace}`;
  await Promise.all([processRetentionCleanup(), processRetentionCleanup()]);
  const scheduled =
    await sql`SELECT id,status FROM retention_runs WHERE workspace_id=${workspace} AND trigger_kind='scheduled'`;
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]!.status, "completed");
  assert.equal(
    (await sql`SELECT id FROM evaluation_runs WHERE id=${baseline}`).length,
    0,
  );
  assert.equal(await processRetentionCleanup(), false);
  assert.equal(
    (await sql`SELECT id FROM conversations WHERE id=${conversations.running!}`)
      .length,
    1,
  );
});

test("cleanup rechecks activity after waiting for the conversation writer lock", async () => {
  const fixture = await chatFixture("raced");
  const revision = await save({
    enabled: true,
    runDays: null,
    artifactDays: null,
    connectorDays: null,
  });
  const job = await queue(revision);
  let cleanup: Promise<boolean> | undefined;
  await sql.begin(async (tx) => {
    await tx`SELECT id FROM conversations WHERE id=${fixture.c} FOR UPDATE`;
    cleanup = processRetentionCleanup();
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      const [row] =
        await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT id FROM conversations WHERE id=ANY%') AS waiting`;
      if (row!.waiting) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, "cleanup should wait behind the writer");
    await tx`UPDATE conversations SET last_activity_at=now() WHERE id=${fixture.c}`;
  });
  await cleanup;
  assert.equal(
    (await sql`SELECT status FROM retention_runs WHERE id=${job}`)[0]!.status,
    "completed",
  );
  assert.equal(
    (await sql`SELECT id FROM conversations WHERE id=${fixture.c}`).length,
    1,
  );
  assert.equal(
    (await sql`SELECT id FROM generated_artifacts WHERE id=${fixture.artifact}`)
      .length,
    1,
  );
});

test("an invalid storage reference rolls back the entire database batch and deletion outbox", async () => {
  const valid = await chatFixture("rollback-valid");
  const invalid = await chatFixture("rollback-invalid");
  await sql`UPDATE generated_artifacts SET storage_key=${`generated/${foreignOrg}/${foreign}/${invalid.artifact}`} WHERE id=${invalid.artifact}`;
  const revision = await save({
    enabled: true,
    runDays: null,
    artifactDays: null,
    connectorDays: null,
  });
  const job = await queue(revision);
  assert.equal(await processRetentionCleanup(), false);
  assert.equal(
    (await sql`SELECT status FROM retention_runs WHERE id=${job}`)[0]!.status,
    "failed",
  );
  for (const fixture of [valid, invalid]) {
    assert.equal(
      (await sql`SELECT id FROM conversations WHERE id=${fixture.c}`).length,
      1,
    );
    assert.equal(
      (
        await sql`SELECT id FROM generated_artifacts WHERE id=${fixture.artifact}`
      ).length,
      1,
    );
    assert.equal(
      (
        await sql`SELECT id FROM retention_object_deletions WHERE id=${fixture.artifact}`
      ).length,
      0,
    );
  }
});

test("bounded roots and complete descendants schedule another batch without stranding files", async () => {
  const invalidKey = keys.find((key) =>
    key.endsWith(artifacts["rollback-invalid"]!),
  )!;
  await sql`UPDATE generated_artifacts SET storage_key=${invalidKey} WHERE id=${artifacts["rollback-invalid"]!}`;
  const fixture = await chatFixture("many-files");
  for (let i = 0; i < 101; i++) {
    const artifact = randomUUID(),
      key = `generated/${org}/${workspace}/${artifact}`;
    // The outbox uses idempotent S3 DELETE even for an already missing object.
    await sql`INSERT INTO generated_artifacts(id,organization_id,workspace_id,message_id,name,content_type,storage_key,byte_size) VALUES (${artifact},${org},${workspace},${fixture.m},'fixture.txt','text/plain',${key},1)`;
  }
  const ids = Array.from({ length: 101 }, () => randomUUID());
  for (const id of ids)
    await sql`INSERT INTO conversations(id,organization_id,workspace_id,agent_id,user_id,config_snapshot,model_snapshot,last_activity_at) VALUES (${id},${org},${workspace},${agent},${user},'{}','{}',now()-interval '60 days')`;
  const revision = await save({
    enabled: true,
    runDays: null,
    artifactDays: null,
    connectorDays: null,
  });
  const preview = await call("POST", base + "/preview", { revision });
  assert.equal(preview.json().counts.conversations, 100);
  const job = await queue(revision);
  await processRetentionCleanup();
  const [first] =
    await sql`SELECT status,counts FROM retention_runs WHERE id=${job}`;
  assert.equal(first!.status, "completed");
  assert.equal(first!.counts.conversations, 100);
  const [policy] =
    await sql`SELECT next_run_at FROM workspace_retention WHERE workspace_id=${workspace}`;
  assert.ok(policy!.next_run_at < new Date(Date.now() + 10 * 60000));
  await queue(revision);
  await processRetentionCleanup();
  assert.equal(
    (await sql`SELECT id FROM conversations WHERE id=ANY(${ids}::uuid[])`)
      .length,
    0,
  );
  assert.equal(
    (
      await sql`SELECT id FROM generated_artifacts WHERE message_id=${fixture.m}`
    ).length,
    0,
  );
  assert.ok(
    (
      await sql`SELECT id FROM retention_object_deletions WHERE workspace_id=${workspace} AND status='pending'`
    ).length >= 102,
  );
});

test("file-only retention preserves messages and marks expired downloads", async () => {
  const fixture = await chatFixture(
    "file-only",
    workspace,
    org,
    "completed",
    "none",
    true,
  );
  await sql`UPDATE messages SET ui_blocks=${sql.json([
    {
      type: "file",
      title: "Fixture",
      format: "txt",
      artifactId: fixture.artifact,
    },
    { type: "text", content: "Retained content" },
  ])} WHERE id=${fixture.m}`;
  const revision = await save({
    enabled: true,
    conversationDays: null,
    runDays: null,
    artifactDays: 30,
    connectorDays: null,
  });
  await queue(revision);
  await processRetentionCleanup();
  const [message] =
    await sql`SELECT ui_blocks FROM messages WHERE id=${fixture.m}`;
  assert.equal(message!.ui_blocks[0].artifactId, undefined);
  assert.equal(message!.ui_blocks[0].title, "Fixture");
  assert.equal(message!.ui_blocks[1].content, "Retained content");
  assert.equal(
    (await sql`SELECT id FROM conversations WHERE id=${fixture.c}`).length,
    1,
  );
  assert.equal(
    (await sql`SELECT id FROM generated_artifacts WHERE id=${fixture.artifact}`)
      .length,
    0,
  );
});
