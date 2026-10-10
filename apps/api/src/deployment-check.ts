import { config } from "./config.js";
import { sql, closeDb } from "./db.js";
import { infrastructureReadiness } from "./readiness-infrastructure.js";
import {
  deploymentEnvironmentCode,
  deploymentPolicyCode,
} from "./deployment-policy.js";
const development = process.argv.includes("--development");
const readiness = infrastructureReadiness();
try {
  const environmentCode = deploymentEnvironmentCode(config, development);
  if (environmentCode) throw new Error(environmentCode);
  const result = await readiness.probe();
  if (result.status !== "ready")
    throw new Error(`DEPENDENCY_UNAVAILABLE_${result.service.toUpperCase()}`);
  const [role] =
    await sql`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
  const policyCode = deploymentPolicyCode(
    config,
    role as { rolsuper: boolean; rolbypassrls: boolean } | undefined,
    development,
  );
  if (policyCode) throw new Error(policyCode);
  console.log(
    JSON.stringify({
      status: "passed",
      mode: development ? "development" : "production",
      checks: [
        "configuration",
        "schema",
        "pgvector",
        "postgres",
        "redis",
        "storage",
        "temporal",
        ...(development ? [] : ["application-role", "default-credentials"]),
      ],
    }),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  const code = /^[A-Z_]+$/.test(message) ? message : "DEPLOYMENT_CHECK_FAILED";
  console.error(JSON.stringify({ status: "failed", code }));
  process.exitCode = 1;
} finally {
  await readiness.close();
  await closeDb();
}
