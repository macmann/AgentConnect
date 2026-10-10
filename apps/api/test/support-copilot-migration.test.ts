import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql, closeDb } from "../src/db.js";
import { config } from "../src/config.js";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
after(closeDb);
test("Fresh copilot migration enforces tenant references, one active generation, and case-owned retention", async () => {
  const schema = "copilot_migration_" + randomUUID().replaceAll("-", ""),
    org = randomUUID(),
    wid = randomUUID(),
    conv = randomUUID(),
    caseId = randomUUID(),
    user = randomUUID();
  const migration = await readFile(
    new URL(
      "../../../packages/db/migrations/0021_support_copilot.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await sql.begin(async (tx) => {
    await tx`CREATE SCHEMA ${tx(schema)}`;
    await tx`SET LOCAL search_path TO ${tx(schema)}`;
    await tx.unsafe(
      "CREATE TABLE users(id uuid PRIMARY KEY);CREATE TABLE support_cases(id uuid PRIMARY KEY,conversation_id uuid,workspace_id uuid,organization_id uuid,UNIQUE(id,conversation_id,workspace_id,organization_id));",
    );
    await tx`INSERT INTO users VALUES (${user})`;
    await tx`INSERT INTO support_cases VALUES (${caseId},${conv},${wid},${org})`;
    await tx.unsafe(migration);
    const insert = (t: typeof tx, w: string, status: string) =>
      t`INSERT INTO support_copilot(id,organization_id,workspace_id,conversation_id,support_case_id,requested_by,kind,status,context_hash,lease_until) VALUES (${randomUUID()},${org},${w},${conv},${caseId},${user},'reply',${status},'fixture',now()+interval '1 minute')`;
    await insert(tx, wid, "running");
    await assert.rejects(
      tx.savepoint((t) => insert(t as typeof tx, randomUUID(), "completed")),
      (e: { code: string }) => e.code === "23503",
    );
    await assert.rejects(
      tx.savepoint((t) => insert(t as typeof tx, wid, "running")),
      (e: { code: string }) => e.code === "23505",
    );
    await insert(tx, wid, "completed");
    await tx`DELETE FROM support_cases WHERE id=${caseId}`;
    const rows = await tx`SELECT * FROM support_copilot`;
    assert.equal(rows.length, 0);
    await tx`DROP SCHEMA ${tx(schema)} CASCADE`;
  });
});
