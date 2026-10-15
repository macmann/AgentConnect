import { readFile } from "node:fs/promises";
import type postgres from "postgres";
import {
  requiredMigrations,
  supportedVectorVersion,
} from "./release-requirements.js";

export const migrationFiles: Record<string, string> = {
  "0001": "0001_foundation.sql",
  "0002": "0002_single_agent.sql",
  "0003": "0003_knowledge.sql",
  "0004": "0004_tools.sql",
  "0005": "0005_workflows.sql",
  "0006": "0006_model_management.sql",
  "0007": "0007_operations.sql",
  "0008": "0008_generative.sql",
  "0009": "0009_channels.sql",
  "0010": "0010_quality.sql",
  "0011": "0011_connectors.sql",
  "0012": "0012_google_drive_connectors.sql",
  "0013": "0013_onedrive_connectors.sql",
  "0014": "0014_sharepoint_connectors.sql",
  "0015": "0015_messaging_connectors.sql",
  "0016": "0016_retention.sql",
  "0017": "0017_support.sql",
  "0018": "0018_support_console.sql",
  "0019": "0019_support_routing.sql",
  "0020": "0020_support_triage.sql",
  "0021": "0021_support_copilot.sql",
  "0022": "0022_support_continuation.sql",
  "0023": "0023_support_operations.sql",
  "0024": "0024_bank_core_ai.sql",
  "0025": "0025_customer_insights.sql",
  "0026": "0026_presence_reporting.sql",
  "0027": "0027_rag_ocr.sql",
  "0028": "0028_customer_engagement.sql",
  "0029": "0029_workflow_depth.sql",
  "0030": "0030_connector_oauth.sql",
  "0031": "0031_advanced_knowledge.sql",
  "0032": "0032_answer_feedback_loop.sql",
  "0033": "0033_rerankers.sql",
  "0034": "0034_document_review_benchmarks.sql",
  "0035": "0035_extraction_usage_financial_tools.sql",
};

export class MigrationFailure extends Error {
  constructor(
    public readonly version: string | undefined,
    cause: unknown,
  ) {
    super("Migration process failed", { cause });
  }
}

export function migrationDiagnostic(error: unknown) {
  const cause = error instanceof MigrationFailure ? error.cause : error;
  const code = (cause as { code?: unknown } | null)?.code;
  return {
    status: "failed",
    code:
      typeof code === "string" && /^[A-Z0-9_]{2,64}$/.test(code)
        ? code
        : "MIGRATION_FAILED",
    ...(error instanceof MigrationFailure && error.version
      ? { migration: error.version }
      : {}),
  };
}

export async function runMigrations(
  client: postgres.Sql,
  versions: readonly string[] = requiredMigrations,
  load: (version: string) => Promise<string> = async (version) => {
    const file = migrationFiles[version];
    if (!file) throw new Error("Unknown migration version");
    return readFile(
      new URL(`../../../packages/db/migrations/${file}`, import.meta.url),
      "utf8",
    );
  },
) {
  // A reserved physical session owns the lock across transaction boundaries.
  const session = await client.reserve();
  let locked = false;
  let version: string | undefined;
  try {
    await session`SELECT pg_advisory_lock(801100)`;
    locked = true;
    await session`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    for (version of versions) {
      const done =
        await session`SELECT version FROM schema_migrations WHERE version=${version}`;
      if (done.length) continue;
      const source = await load(version);
      await session`BEGIN`;
      try {
        await session.unsafe(source);
        await session`INSERT INTO schema_migrations(version) VALUES (${version})`;
        await session`COMMIT`;
      } catch (error) {
        try {
          await session`ROLLBACK`;
        } catch {
          /* A disconnected session already rolled back. */
        }
        throw error;
      }
    }
    version = undefined;
    const [extension] =
      await session`SELECT extversion FROM pg_extension WHERE extname='vector'`;
    if (!supportedVectorVersion(extension?.extversion))
      throw new Error("pgvector >= 0.8.7 is required");
  } catch (error) {
    throw new MigrationFailure(version, error);
  } finally {
    try {
      if (locked) await session`SELECT pg_advisory_unlock(801100)`;
    } catch {
      // Never return a potentially locked session to the pool. Disconnecting
      // also releases PostgreSQL session locks after network/process failure.
      await client.end({ timeout: 0 });
    } finally {
      session.release();
    }
  }
}
