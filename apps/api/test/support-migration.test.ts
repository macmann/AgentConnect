import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql, closeDb } from "../src/db.js";
import { config } from "../src/config.js";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
after(closeDb);
test("Support migration preserves legacy history, backfills control and permits retention cascade", async () => {
  const schema = "support_migration_" + randomUUID().replaceAll("-", "");
  const migration = await readFile(
    new URL(
      "../../../packages/db/migrations/0017_support.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await sql.begin(async (tx) => {
    await tx`CREATE SCHEMA ${tx(schema)}`;
    await tx`SET LOCAL search_path TO ${tx(schema)}`;
    // Minimal pre-0017 contract isolates the migration from the developer's data.
    await tx.unsafe(`CREATE TABLE users(id uuid PRIMARY KEY);
   CREATE TABLE workspaces(id uuid,organization_id uuid,PRIMARY KEY(id,organization_id));
   CREATE TABLE memberships(user_id uuid,organization_id uuid,workspace_id uuid,role text);
   CREATE TABLE conversations(id uuid PRIMARY KEY,workspace_id uuid,organization_id uuid,handoff_status text,created_at timestamptz DEFAULT now(),last_activity_at timestamptz DEFAULT now(),UNIQUE(id,workspace_id,organization_id));
   CREATE TABLE messages(conversation_id uuid,role text,created_at timestamptz DEFAULT now());
   CREATE TABLE handoff_events(id uuid PRIMARY KEY,conversation_id uuid,workspace_id uuid,organization_id uuid,kind text,actor_id uuid,content text,created_at timestamptz DEFAULT now());
   CREATE FUNCTION touch_conversation_activity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE conversations SET last_activity_at=now() WHERE id=NEW.conversation_id; RETURN NEW; END $$;`);
    const org = randomUUID(),
      workspace = randomUUID(),
      operator = randomUUID(),
      events: string[] = [],
      conversations: string[] = [];
    await tx`INSERT INTO workspaces VALUES (${workspace},${org})`;
    await tx`INSERT INTO users VALUES (${operator})`;
    await tx`INSERT INTO memberships VALUES (${operator},${org},${workspace},'operator')`;
    for (const status of ["pending", "active", "resolved"]) {
      const c = randomUUID(),
        event = randomUUID();
      conversations.push(c);
      events.push(event);
      await tx`INSERT INTO conversations(id,workspace_id,organization_id,handoff_status) VALUES (${c},${workspace},${org},${status})`;
      await tx`INSERT INTO handoff_events VALUES (${event},${c},${workspace},${org},${status === "active" ? "claimed" : status === "pending" ? "requested" : "resolved"},${operator},'Preserved fixture',now()-interval '1 day')`;
    }
    await tx.unsafe(migration);
    const cases = await tx`SELECT status FROM support_cases ORDER BY status`;
    assert.deepEqual(
      cases.map((c) => c.status),
      ["active", "queued", "resolved"],
    );
    const preserved =
      await tx`SELECT id,payload FROM support_events ORDER BY id`;
    assert.deepEqual(preserved.map((e) => e.id).sort(), events.sort());
    assert.ok(
      preserved.every((e) => e.payload.content === "Preserved fixture"),
    );
    const modes =
      await tx`SELECT conversation_mode,active_support_case_id,handoff_status FROM conversations`;
    assert.ok(
      modes.every((c) =>
        c.handoff_status === "resolved"
          ? c.conversation_mode === "ai" && c.active_support_case_id === null
          : c.active_support_case_id !== null,
      ),
    );
    await tx`DELETE FROM conversations WHERE id=ANY(${conversations}::uuid[])`;
    assert.equal((await tx`SELECT * FROM support_cases`).length, 0);
    assert.equal((await tx`SELECT * FROM support_events`).length, 0);
    await tx`SET CONSTRAINTS ALL IMMEDIATE`;
    await tx`DROP SCHEMA ${tx(schema)} CASCADE`;
  });
});
