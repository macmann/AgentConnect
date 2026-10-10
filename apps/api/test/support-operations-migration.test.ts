import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql, closeDb } from "../src/db.js";
import { config } from "../src/config.js";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
after(closeDb);
test("Operations migration preserves history, snapshots clocks, enforces fallback scope and cascades private notifications", async () => {
  const schema = "operations_migration_" + randomUUID().replaceAll("-", ""),
    org = randomUUID(),
    wid = randomUUID(),
    other = randomUUID(),
    user = randomUUID(),
    conv = randomUUID(),
    q = randomUUID(),
    foreign = randomUUID(),
    caseId = randomUUID(),
    event = randomUUID();
  const migration = await readFile(
    new URL(
      "../../../packages/db/migrations/0023_support_operations.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await sql.begin(async (tx) => {
    await tx`CREATE SCHEMA ${tx(schema)}`;
    await tx`SET LOCAL search_path TO ${tx(schema)}`;
    await tx.unsafe(`CREATE TABLE users(id uuid PRIMARY KEY);
CREATE TABLE workspaces(id uuid PRIMARY KEY,organization_id uuid,UNIQUE(id,organization_id));
CREATE TABLE conversations(id uuid PRIMARY KEY,workspace_id uuid,organization_id uuid,UNIQUE(id,workspace_id,organization_id));
CREATE TABLE support_queues(id uuid PRIMARY KEY,workspace_id uuid,organization_id uuid,name text,UNIQUE(id,workspace_id,organization_id));
CREATE TABLE support_cases(id uuid PRIMARY KEY,workspace_id uuid,organization_id uuid,conversation_id uuid,status text,queue_id uuid,assigned_operator_id uuid,requested_at timestamptz DEFAULT now(),assigned_at timestamptz,accepted_at timestamptz,resolved_at timestamptz,closed_at timestamptz,first_response_at timestamptz,resume_context jsonb DEFAULT '{}',UNIQUE(id,workspace_id,organization_id),FOREIGN KEY(conversation_id,workspace_id,organization_id) REFERENCES conversations(id,workspace_id,organization_id) ON DELETE CASCADE);
CREATE TABLE support_events(id uuid PRIMARY KEY,workspace_id uuid,organization_id uuid,conversation_id uuid,support_case_id uuid,type text,actor_type text,payload jsonb,FOREIGN KEY(support_case_id,workspace_id,organization_id) REFERENCES support_cases(id,workspace_id,organization_id) ON DELETE CASCADE);
CREATE TABLE operator_profiles(workspace_id uuid,organization_id uuid,user_id uuid);
CREATE TABLE memberships(workspace_id uuid,organization_id uuid,user_id uuid,role text);
CREATE TABLE support_queue_members(queue_id uuid,user_id uuid,enabled boolean);`);
    await tx`INSERT INTO users VALUES (${user})`;
    await tx`INSERT INTO workspaces VALUES (${wid},${org}),(${other},${org})`;
    await tx`INSERT INTO conversations VALUES (${conv},${wid},${org})`;
    await tx`INSERT INTO support_queues VALUES (${q},${wid},${org},'Queue'),(${foreign},${other},${org},'Other workspace')`;
    await tx`INSERT INTO support_cases(id,workspace_id,organization_id,conversation_id,status,queue_id,resume_context) VALUES (${caseId},${wid},${org},${conv},'resolved',${q},'{"summary":"PRIVATE LEGACY"}')`;
    await tx.unsafe(migration);
    let [s] = await tx`SELECT * FROM support_cases WHERE id=${caseId}`;
    assert.equal(s!.resume_context.summary, "PRIVATE LEGACY");
    assert.equal(s!.sla_state, "on_track");
    assert.equal(s!.acceptance_deadline, null);
    await assert.rejects(
      tx.savepoint(
        (t) =>
          t`UPDATE support_queues SET operations_config=${t.json({ businessHours: { fallbackQueueId: foreign } })} WHERE id=${q}`,
      ),
      (e: { code: string }) => e.code === "23503",
    );
    await tx`INSERT INTO memberships VALUES (NULL,${org},${user},'owner')`;
    await tx`INSERT INTO support_events VALUES (${event},${wid},${org},${conv},${caseId},'case.created','customer','{"content":"PRIVATE CONTENT"}')`;
    const [notification] =
      await tx`SELECT * FROM support_notifications WHERE support_case_id=${caseId}`;
    assert.equal(notification!.user_id, user);
    assert.equal(notification!.kind, "case.created");
    assert.ok(!JSON.stringify(notification).includes("PRIVATE CONTENT"));
    await tx`UPDATE support_queues SET operations_config='{"sla":{"resolutionSeconds":100},"acceptanceTimeoutSeconds":60}' WHERE id=${q}`;
    const fresh = randomUUID();
    await tx`INSERT INTO support_cases(id,workspace_id,organization_id,conversation_id,status,queue_id,assigned_at) VALUES (${fresh},${wid},${org},${conv},'assigned',${q},now())`;
    [s] = await tx`SELECT * FROM support_cases WHERE id=${fresh}`;
    assert.equal(s!.sla_snapshot.sla.resolutionSeconds, 100);
    assert.ok(s!.acceptance_deadline);
    assert.ok(s!.first_assigned_at);
    await tx`UPDATE support_cases SET status='waiting_customer' WHERE id=${fresh}`;
    await tx`UPDATE support_cases SET resolution_paused_at=clock_timestamp()-interval '10 seconds' WHERE id=${fresh}`;
    await tx`UPDATE support_cases SET status='active' WHERE id=${fresh}`;
    [s] = await tx`SELECT * FROM support_cases WHERE id=${fresh}`;
    assert.ok(s!.resolution_paused_seconds >= 9);
    assert.equal(s!.resolution_paused_at, null);
    assert.equal(s!.acceptance_deadline, null);
    await tx`DELETE FROM conversations WHERE id=${conv}`;
    assert.equal((await tx`SELECT * FROM support_notifications`).length, 0);
    await tx`DROP SCHEMA ${tx(schema)} CASCADE`;
  });
});
