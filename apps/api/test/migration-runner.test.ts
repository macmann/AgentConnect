import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { config } from "../src/config.js";
import { runMigrations, migrationDiagnostic } from "../src/migration-runner.js";
import { requiredMigrations } from "../src/release-requirements.js";

if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
async function database(
  work: (client: postgres.Sql, url: string) => Promise<void>,
) {
  const admin = postgres(config.DATABASE_URL, { max: 1 });
  const name = "migration_test_" + randomUUID().replaceAll("-", "");
  let client: postgres.Sql | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(config.DATABASE_URL);
    url.pathname = "/" + name;
    client = postgres(url.toString(), { max: 3 });
    await work(client, url.toString());
  } finally {
    await client?.end({ timeout: 0 });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

test("fresh database migrates through latest and rerun preserves migration timestamps", async () => {
  await database(async (client) => {
    await runMigrations(client);
    const before =
      await client`SELECT version,applied_at FROM schema_migrations ORDER BY version`;
    assert.deepEqual(
      before.map((row) => row.version),
      requiredMigrations,
    );
    await runMigrations(client);
    assert.deepEqual(
      await client`SELECT version,applied_at FROM schema_migrations ORDER BY version`,
      before,
    );
  });
});

test("database at 0015 with conversation history upgrades through latest", async () => {
  await database(async (client) => {
    await runMigrations(client, requiredMigrations.slice(0, 15));
    const org = randomUUID(),
      workspace = randomUUID(),
      user = randomUUID(),
      agent = randomUUID(),
      conversation = randomUUID();
    await client`INSERT INTO organizations(id,name) VALUES (${org},'Migration fixture')`;
    await client`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Migration fixture')`;
    await client`INSERT INTO users(id,email,name,password_hash) VALUES (${user},${user + "@example.test"},'Fixture','unused')`;
    await client`INSERT INTO agents(id,organization_id,workspace_id,name,description,public_description,draft_config,created_by) VALUES (${agent},${org},${workspace},'Fixture','','','{}',${user})`;
    await client`INSERT INTO conversations(id,organization_id,workspace_id,agent_id,user_id,config_snapshot,model_snapshot,created_at) VALUES (${conversation},${org},${workspace},${agent},${user},'{}','{}',now()-interval '1 day')`;
    await runMigrations(client);
    assert.deepEqual(
      (
        await client`SELECT version FROM schema_migrations ORDER BY version`
      ).map((row) => row.version),
      requiredMigrations,
    );
    const [row] =
      await client`SELECT conversation_mode,last_activity_at,created_at FROM conversations WHERE id=${conversation}`;
    assert.ok(row);
    assert.equal(row.conversation_mode, "ai");
    assert.equal(row.last_activity_at.getTime(), row.created_at.getTime());
  });
});

test("failed migration rolls back its DDL, data and record; earlier commit survives and lock releases", async () => {
  await database(async (client, url) => {
    await client`CREATE EXTENSION vector`;
    const load = async (version: string) =>
      version === "0001"
        ? "CREATE TABLE migration_probe(value integer); INSERT INTO migration_probe VALUES (1)"
        : version === "0002"
          ? "INSERT INTO migration_probe VALUES (2); CREATE TABLE rolled_back(id integer); SELECT 1/0"
          : "CREATE TABLE must_not_run(id integer)";
    await assert.rejects(
      runMigrations(client, ["0001", "0002", "0003"], load),
      (error: unknown) => {
        assert.deepEqual(migrationDiagnostic(error), {
          status: "failed",
          code: "22012",
          migration: "0002",
        });
        return true;
      },
    );
    assert.deepEqual(
      (await client`SELECT version FROM schema_migrations`).map(
        (row) => row.version,
      ),
      ["0001"],
    );
    assert.deepEqual(
      (await client`SELECT value FROM migration_probe`).map((row) => row.value),
      [1],
    );
    const [tables] =
      await client`SELECT to_regclass('rolled_back') AS failed,to_regclass('must_not_run') AS later`;
    assert.ok(tables);
    assert.equal(tables.failed, null);
    assert.equal(tables.later, null);
    // A different physical session can acquire the lock after the failure.
    const probe = postgres(url, { max: 1 });
    const session = await probe.reserve();
    try {
      const [lock] =
        await session`SELECT pg_try_advisory_lock(801100) AS acquired`;
      assert.ok(lock);
      assert.equal(lock.acquired, true);
      await session`SELECT pg_advisory_unlock(801100)`;
    } finally {
      session.release();
      await probe.end();
    }
    await runMigrations(
      client,
      ["0001", "0002"],
      async () => "INSERT INTO migration_probe VALUES (2)",
    );
    assert.equal((await client`SELECT * FROM schema_migrations`).length, 2);
  });
});

test("second migrator waits for the first session across migration commits and never re-applies SQL", async () => {
  await database(async (client, url) => {
    await client`CREATE EXTENSION vector`;
    const second = postgres(url, {
      max: 1,
      connection: { application_name: "migration_competitor" },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = runMigrations(client, ["0001", "0002"], async (version) => {
      if (version === "0002") {
        entered();
        await gate;
      }
      return version === "0001"
        ? "CREATE TABLE concurrency_probe(value integer); INSERT INTO concurrency_probe VALUES (1)"
        : "INSERT INTO concurrency_probe VALUES (2)";
    });
    let competing: Promise<void> | undefined;
    try {
      await ready;
      assert.equal((await client`SELECT * FROM schema_migrations`).length, 1);
      competing = runMigrations(second, ["0001", "0002"], async () => {
        throw new Error("Competitor must not apply a committed migration");
      });
      // Observe actual PostgreSQL lock waiting, rather than assuming a delay.
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        const rows =
          await client`SELECT 1 FROM pg_stat_activity WHERE application_name='migration_competitor' AND wait_event='advisory'`;
        if (rows.length) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        waiting,
        true,
        "second session must be blocked on the advisory lock",
      );
      release();
      await Promise.all([first, competing]);
      assert.deepEqual(
        (await client`SELECT value FROM concurrency_probe ORDER BY value`).map(
          (row) => row.value,
        ),
        [1, 2],
      );
      assert.equal((await client`SELECT * FROM schema_migrations`).length, 2);
    } finally {
      release();
      await Promise.allSettled([first, ...(competing ? [competing] : [])]);
      await second.end({ timeout: 0 });
    }
  });
});

test("pgvector verification remains required after migration commits and diagnostics omit sensitive errors", async () => {
  await database(async (client) => {
    await assert.rejects(
      runMigrations(
        client,
        ["0001"],
        async () => "CREATE TABLE vector_check_probe(id integer)",
      ),
      (error: unknown) => {
        assert.deepEqual(migrationDiagnostic(error), {
          status: "failed",
          code: "MIGRATION_FAILED",
        });
        return true;
      },
    );
    assert.equal((await client`SELECT * FROM schema_migrations`).length, 1);
  });
  assert.deepEqual(
    migrationDiagnostic({
      code: "postgres://credential@example.test",
      message: "secret",
      detail: "secret",
      query: "secret",
    }),
    { status: "failed", code: "MIGRATION_FAILED" },
  );
});
