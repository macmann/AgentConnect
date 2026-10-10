import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql, closeDb } from "../src/db.js";
import { config } from "../src/config.js";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
after(closeDb);
test("Final routing migration preserves existing cases and enforces defaults, capacity and composite skill references", async () => {
  const schema =
      "support_routing_migration_" + randomUUID().replaceAll("-", ""),
    migration = await readFile(
      new URL(
        "../../../packages/db/migrations/0019_support_routing.sql",
        import.meta.url,
      ),
      "utf8",
    );
  await sql.begin(async (tx) => {
    await tx`CREATE SCHEMA ${tx(schema)}`;
    await tx`SET LOCAL search_path TO ${tx(schema)}`;
    await tx.unsafe(`CREATE TABLE users(id uuid PRIMARY KEY);
  CREATE TABLE workspaces(id uuid,organization_id uuid,PRIMARY KEY(id,organization_id));
  CREATE TABLE support_queues(id uuid PRIMARY KEY,workspace_id uuid NOT NULL,organization_id uuid NOT NULL,name text,routing_strategy text DEFAULT 'manual',UNIQUE(id,workspace_id,organization_id));
  CREATE TABLE support_cases(id uuid PRIMARY KEY,workspace_id uuid,organization_id uuid,status text,queue_id uuid,queued_at timestamptz DEFAULT now(),assigned_operator_id uuid);`);
    const org = randomUUID(),
      w = randomUUID(),
      sibling = randomUUID(),
      user = randomUUID(),
      q = randomUUID(),
      legacy = randomUUID(),
      foreignSkill = randomUUID();
    await tx`INSERT INTO users(id) VALUES (${user})`;
    for (const id of [w, sibling])
      await tx`INSERT INTO workspaces(id,organization_id) VALUES (${id},${org})`;
    await tx`INSERT INTO support_queues(id,workspace_id,organization_id,name) VALUES (${q},${w},${org},'Existing manual queue')`;
    await tx`INSERT INTO support_cases(id,workspace_id,organization_id,status,queue_id,assigned_operator_id) VALUES (${legacy},${w},${org},'active',${q},${user})`;
    await tx.unsafe(migration);
    const [old] = await tx`SELECT * FROM support_cases WHERE id=${legacy}`;
    assert.equal(old!.status, "active");
    assert.equal(old!.assigned_operator_id, user);
    assert.equal(old!.routing_strategy, null);
    assert.ok(old!.routing_next_attempt_at);
    const [queue] = await tx`SELECT * FROM support_queues WHERE id=${q}`;
    assert.equal(queue!.assignment_mode, "manual");
    assert.equal(queue!.is_default, false);
    await tx`INSERT INTO operator_profiles(organization_id,workspace_id,user_id) VALUES (${org},${w},${user})`;
    await assert.rejects(
      tx.savepoint(async (save) => {
        await save`UPDATE operator_profiles SET capacity_limit=0 WHERE workspace_id=${w}`;
      }),
      (e: { code: string }) => e.code === "23514",
    );
    await tx`INSERT INTO support_skills(id,workspace_id,organization_id,name) VALUES (${foreignSkill},${sibling},${org},'Foreign skill')`;
    await assert.rejects(
      tx.savepoint(async (save) => {
        await save`INSERT INTO operator_skills(organization_id,workspace_id,user_id,skill_id,proficiency) VALUES (${org},${w},${user},${foreignSkill},5)`;
      }),
      (e: { code: string }) => e.code === "23503",
    );
    await tx`UPDATE support_queues SET is_default=true WHERE id=${q}`;
    await assert.rejects(
      tx.savepoint(async (save) => {
        await save`INSERT INTO support_queues(id,workspace_id,organization_id,name,is_default) VALUES (${randomUUID()},${w},${org},'Second default',true)`;
      }),
      (e: { code: string }) => e.code === "23505",
    );
    await tx`INSERT INTO support_queue_members(organization_id,workspace_id,queue_id,user_id) VALUES (${org},${w},${q},${user})`;
    await tx`DELETE FROM operator_profiles WHERE workspace_id=${w}`;
    assert.equal((await tx`SELECT * FROM support_queue_members`).length, 0);
    await tx`DROP SCHEMA ${tx(schema)} CASCADE`;
  });
});
