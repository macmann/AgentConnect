import { initializeTelemetry, shutdownTelemetry } from "./telemetry.js";
initializeTelemetry("agentconnex-api");
const { sql, closeDb } = await import("./db.js");
const { config } = await import("./config.js");
const { runMigrations, migrationDiagnostic } =
  await import("./migration-runner.js");
const { initializeStorage } = await import("./app.js");
const { infrastructureReadiness } =
  await import("./readiness-infrastructure.js");
const { deploymentEnvironmentCode, deploymentPolicyCode } =
  await import("./deployment-policy.js");
const { runBootstrap, BootstrapFailure } =
  await import("./bootstrap-runner.js");
const readiness = infrastructureReadiness();
let serving = false;
const interrupted = () => {
  void closeDb().finally(() => process.exit(1));
};
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);
try {
  await runBootstrap({
    migration: async () => {
      await runMigrations(sql);
      console.log(JSON.stringify({ stage: "migration", status: "completed" }));
    },
    storage: async () => {
      await initializeStorage();
      console.log(JSON.stringify({ stage: "storage", status: "completed" }));
    },
    preflight: async () => {
      const environment = deploymentEnvironmentCode(config, false);
      if (environment) throw new Error(environment);
      const result = await readiness.probe();
      if (result.status !== "ready")
        throw new Error(
          "DEPENDENCY_UNAVAILABLE_" + result.service.toUpperCase(),
        );
      const [role] =
        await sql`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
      const policy = deploymentPolicyCode(
        config,
        role as { rolsuper: boolean; rolbypassrls: boolean },
        false,
      );
      if (policy) throw new Error(policy);
      console.log(JSON.stringify({ stage: "preflight", status: "completed" }));
    },
    server: async () => {
      // server.ts owns normal signal handling after bootstrap releases its hook.
      process.removeListener("SIGINT", interrupted);
      process.removeListener("SIGTERM", interrupted);
      await import("./server.js");
      serving = true;
    },
  });
} catch (error) {
  const stage =
    error instanceof BootstrapFailure ? error.step : "initialization";
  const cause = error instanceof BootstrapFailure ? error.cause : error;
  const diagnostic =
    stage === "migration"
      ? migrationDiagnostic(cause)
      : { status: "failed", code: "BOOTSTRAP_FAILED" };
  console.error(JSON.stringify({ ...diagnostic, stage }));
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", interrupted);
  process.removeListener("SIGTERM", interrupted);
  await readiness.close();
  if (!serving) {
    await closeDb();
    await shutdownTelemetry();
  }
}
