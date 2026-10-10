import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql, closeDb } from "../src/db.js";
import { config } from "../src/config.js";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
after(closeDb);
test("Continuation migration preserves private legacy history and enforces scoped pointers with retention cascade", async () => {
  const schema = "resume_migration_" + randomUUID().replaceAll("-", ""),
    org = randomUUID(),
    wid = randomUUID(),
    conv = randomUUID(),
    other = randomUUID(),
    caseId = randomUUID(),
    foreign = randomUUID();
  const migration = await readFile(
    new URL(
      "../../../packages/db/migrations/0022_support_continuation.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await sql.begin(async (tx) => {
    await tx`CREATE SCHEMA ${tx(schema)}`;
    await tx`SET LOCAL search_path TO ${tx(schema)}`;
    await tx.unsafe(`CREATE TABLE conversations(id uuid PRIMARY KEY,workspace_id uuid,organization_id uuid,UNIQUE(id,workspace_id,organization_id));
CREATE TABLE support_cases(id uuid PRIMARY KEY,conversation_id uuid,workspace_id uuid,organization_id uuid,status text,resolved_at timestamptz,resume_context jsonb,UNIQUE(id,conversation_id,workspace_id,organization_id),FOREIGN KEY(conversation_id,workspace_id,organization_id) REFERENCES conversations(id,workspace_id,organization_id) ON DELETE CASCADE);
CREATE TABLE support_copilot(kind text CONSTRAINT support_copilot_kind_check CHECK(kind IN ('reply','summary','next_action','knowledge')));`);
    await tx`INSERT INTO conversations VALUES (${conv},${wid},${org}),(${other},${wid},${org})`;
    await tx`INSERT INTO support_cases VALUES (${caseId},${conv},${wid},${org},'resolved',now(),' {"summary":"PRIVATE LEGACY"}'),(${foreign},${other},${wid},${org},'resolved',now(),'{}')`;
    await tx.unsafe(migration);
    const [initial] = await tx`SELECT * FROM conversations WHERE id=${conv}`;
    assert.equal(initial!.ai_resume_case_id, null);
    const [historical] =
      await tx`SELECT resume_context FROM support_cases WHERE id=${caseId}`;
    assert.equal(historical!.resume_context.summary, "PRIVATE LEGACY");
    await assert.rejects(
      tx.savepoint(
        (t) =>
          t`UPDATE conversations SET ai_resume_case_id=${foreign} WHERE id=${conv}`,
      ),
      (e: { code: string }) => e.code === "23503",
    );
    await tx`UPDATE conversations SET ai_resume_case_id=${caseId} WHERE id=${conv}`;
    await tx`INSERT INTO support_copilot VALUES ('resolution')`;
    await tx`DELETE FROM conversations WHERE id=${conv}`;
    const rows = await tx`SELECT id FROM support_cases WHERE id=${caseId}`;
    assert.equal(rows.length, 0);
    await tx`DROP SCHEMA ${tx(schema)} CASCADE`;
  });
});
