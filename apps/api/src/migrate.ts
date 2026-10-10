import { readFile } from "node:fs/promises";
import { sql } from "./db.js";
import {
  requiredMigrations,
  supportedVectorVersion,
} from "./release-requirements.js";
try {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(801100)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    for (const version of requiredMigrations) {
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
                : version === "0004"
                  ? "0004_tools.sql"
                  : version === "0005"
                    ? "0005_workflows.sql"
                    : version === "0006"
                      ? "0006_model_management.sql"
                      : version === "0007"
                        ? "0007_operations.sql"
                        : version === "0008"
                          ? "0008_generative.sql"
                          : version === "0009"
                            ? "0009_channels.sql"
                            : version === "0010"
                              ? "0010_quality.sql"
                              : version === "0011"
                                ? "0011_connectors.sql"
                                : version === "0012"
                                  ? "0012_google_drive_connectors.sql"
                                  : version === "0013"
                                    ? "0013_onedrive_connectors.sql"
                                    : version === "0014"
                                      ? "0014_sharepoint_connectors.sql"
                                      : version === "0015"
                                        ? "0015_messaging_connectors.sql"
                                        : version === "0016"
                                          ? "0016_retention.sql"
                                          : version === "0017"
                                            ? "0017_support.sql"
                                            : "0018_support_console.sql";
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
  if (!supportedVectorVersion(extension?.extversion))
    throw new Error("pgvector >= 0.8.7 is required");
  console.log("Migrations applied; pgvector version verified");
} finally {
  await sql.end();
}
