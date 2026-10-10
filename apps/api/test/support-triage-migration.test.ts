import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql, closeDb } from "../src/db.js";
import { config } from "../src/config.js";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
after(closeDb);
test("Fresh triage migration preserves existing cases, enforces scoped targets and cleans conversation-owned offers/decisions", async () => {
  const schema = "support_triage_migration_" + randomUUID().replaceAll("-", "");
  const migration = await readFile(
    new URL(
      "../../../packages/db/migrations/0020_support_triage.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await sql.begin(async (tx) => {
    await tx`CREATE SCHEMA ${tx(schema)}`;
    await tx`SET LOCAL search_path TO ${tx(schema)}`;
    await tx.unsafe(`CREATE TABLE workspaces(id uuid,organization_id uuid,PRIMARY KEY(id,organization_id));
CREATE TABLE agents(id uuid,workspace_id uuid,organization_id uuid);
CREATE TABLE deployments(id uuid,workspace_id uuid,organization_id uuid);
CREATE TABLE conversations(id uuid,workspace_id uuid,organization_id uuid,UNIQUE(id,workspace_id,organization_id));
CREATE TABLE agent_runs(id uuid PRIMARY KEY,workspace_id uuid,organization_id uuid,UNIQUE(id,workspace_id,organization_id));
CREATE TABLE support_cases(id uuid PRIMARY KEY,status text,created_at timestamptz DEFAULT now(),assigned_operator_id uuid);`);
    const org = randomUUID(),
      w = randomUUID(),
      sibling = randomUUID(),
      agent = randomUUID(),
      conversation = randomUUID(),
      caseId = randomUUID(),
      operator = randomUUID(),
      run = randomUUID();
    await tx`INSERT INTO workspaces(id,organization_id) VALUES (${w},${org}),(${sibling},${org})`;
    await tx`INSERT INTO agents(id,workspace_id,organization_id) VALUES (${agent},${sibling},${org})`;
    await tx`INSERT INTO conversations(id,workspace_id,organization_id) VALUES (${conversation},${w},${org})`;
    await tx`INSERT INTO agent_runs(id,workspace_id,organization_id) VALUES (${run},${w},${org})`;
    await tx`INSERT INTO support_cases(id,status,assigned_operator_id) VALUES (${caseId},'active',${operator})`;
    await tx.unsafe(migration);
    const [old] = await tx`SELECT * FROM support_cases WHERE id=${caseId}`;
    assert.equal(old!.status, "active");
    assert.equal(old!.assigned_operator_id, operator);
    assert.equal(old!.triage_status, "none");
    assert.deepEqual(old!.handoff_brief, {});
    await assert.rejects(
      tx.savepoint(async (t) => {
        await t`INSERT INTO support_policies(id,workspace_id,organization_id,scope,target_id,policy) VALUES (${randomUUID()},${w},${org},'agent',${agent},'{}')`;
      }),
      (e: { code: string }) => e.code === "23514",
    );
    await assert.rejects(
      tx.savepoint(async (t) => {
        await t`INSERT INTO support_policies(id,workspace_id,organization_id,scope,target_id,policy) VALUES (${randomUUID()},${w},${org},'workspace',${sibling},'{}')`;
      }),
      (e: { code: string }) => e.code === "23514",
    );
    await tx`INSERT INTO support_policies(id,workspace_id,organization_id,scope,target_id,policy) VALUES (${randomUUID()},${w},${org},'workspace',${w},'{}')`;
    await tx`INSERT INTO support_offers(id,workspace_id,organization_id,conversation_id,reason_code,policy_snapshot) VALUES (${randomUUID()},${w},${org},${conversation},'explicit_request','{}')`;
    await assert.rejects(
      tx.savepoint(async (t) => {
        await t`INSERT INTO support_offers(id,workspace_id,organization_id,conversation_id,reason_code,policy_snapshot) VALUES (${randomUUID()},${w},${org},${conversation},'explicit_request','{}')`;
      }),
      (e: { code: string }) => e.code === "23505",
    );
    await tx`INSERT INTO support_decisions(run_id,workspace_id,organization_id,conversation_id,signals) VALUES (${run},${w},${org},${conversation},'{}')`;
    await tx`DELETE FROM conversations WHERE id=${conversation}`;
    assert.equal((await tx`SELECT * FROM support_offers`).length, 0);
    assert.equal((await tx`SELECT * FROM support_decisions`).length, 0);
    await tx`DROP SCHEMA ${tx(schema)} CASCADE`;
  });
});
