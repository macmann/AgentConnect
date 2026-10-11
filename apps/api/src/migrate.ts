import { sql } from "./db.js";
import { migrationDiagnostic, runMigrations } from "./migration-runner.js";

// Terminating the connection rolls back an in-flight migration and releases
// the session lock; previous migration transactions remain committed.
const shutdown = () => {
  void sql.end({ timeout: 0 }).finally(() => process.exit(1));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
try {
  await runMigrations(sql);
  console.log("Migrations applied; pgvector version verified");
} catch (error) {
  console.error(JSON.stringify(migrationDiagnostic(error)));
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", shutdown);
  process.removeListener("SIGTERM", shutdown);
  await sql.end();
}
