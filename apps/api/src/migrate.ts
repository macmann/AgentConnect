import { readFile } from "node:fs/promises";
import { sql } from "./db.js";
try {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(801100)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    for (const version of ["0001", "0002", "0003", "0004"]) {
      const done =
        await tx`SELECT version FROM schema_migrations WHERE version=${version}`;
      if (!done.length) {
        const file =
          version === "0001"
            ? "0001_foundation.sql"
            : version === "0002"
              ? "0002_single_agent.sql"
              : version === "0003"
                ? "0003_knowledge.sql"
                : "0004_tools.sql";
        await tx.unsafe(
          await readFile(
            new URL(`../../../packages/db/migrations/${file}`, import.meta.url),
            "utf8",
          ),
        );
        await tx`INSERT INTO schema_migrations(version) VALUES (${version})`;
      }
    }
  });
  const [extension] =
    await sql`SELECT extversion FROM pg_extension WHERE extname='vector'`;
  const version = String(extension?.extversion ?? "0.0.0")
    .split(".")
    .map(Number);
  if (
    (version[0] ?? 0) === 0 &&
    (version[1] ?? 0) <= 8 &&
    ((version[1] ?? 0) < 8 || (version[2] ?? 0) < 7)
  )
    throw new Error("pgvector >= 0.8.7 is required");
  console.log("Migrations applied; pgvector version verified");
} finally {
  await sql.end();
}
