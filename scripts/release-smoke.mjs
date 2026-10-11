import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import postgres from "postgres";

// Explicit local fixture only. No production database, job, bucket or volume is deleted.
if (process.env.NODE_ENV === "production" || !process.env.DATABASE_URL)
  throw new Error("LOCAL_ENVIRONMENT_REQUIRED");
const original = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(original.hostname))
  throw new Error("LOCAL_DATABASE_REQUIRED");
const identity = "release_smoke_" + randomBytes(8).toString("hex"),
  password = randomBytes(24).toString("hex");
const admin = postgres(process.env.DATABASE_URL, { max: 1 });
let directory,
  createdRole = false,
  createdDatabase = false,
  compose,
  runtime;
let step = "fixture";
async function docker(args) {
  step = args.includes("apps/api/dist/migrate.js")
    ? "migrate"
    : args.includes("apps/api/dist/deployment-check.js")
      ? "preflight"
      : args.includes("up")
        ? "startup"
        : args.includes("exec")
          ? "runtime-probe"
          : args.includes("down")
            ? "cleanup"
            : "compose";
  const operationStep = step;
  const child = spawn("docker", args, {
    env: runtime ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (v) => (output += v));
  // Docker/preflight details remain private; emit only fixed outcome codes.
  let stderr = "";
  child.stderr.on("data", (v) => {
    if (stderr.length < 64000) stderr += v;
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) {
    const combined = output + stderr;
    const candidate = /(?:code: ['"]|"code":")([A-Z0-9_]+)['"]/.exec(
      combined,
    )?.[1];
    const error = new Error("CONTAINER_SMOKE_COMMAND_FAILED");
    const codes = new Set([
      "ERR_MODULE_NOT_FOUND",
      "ERR_PACKAGE_PATH_NOT_EXPORTED",
      "ERR_REQUIRE_ESM",
      "ERR_INVALID_PACKAGE_CONFIG",
      "ECONNREFUSED",
      "ENOTFOUND",
      "42501",
      "42P01",
      "42703",
      "MIGRATION_FAILED",
      "APPLICATION_ROLE_TOO_PRIVILEGED",
      "DEPENDENCY_UNAVAILABLE_POSTGRES",
      "DEPENDENCY_UNAVAILABLE_REDIS",
      "DEPENDENCY_UNAVAILABLE_STORAGE",
      "DEPENDENCY_UNAVAILABLE_TEMPORAL",
    ]);
    if (codes.has(candidate)) error.diagnostic = candidate;
    if (args.includes("up") && compose) {
      const states = await docker([
        ...compose,
        "ps",
        "--all",
        "--format",
        "json",
      ]);
      error.services = states
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .map((row) => ({
          service: ["api", "worker", "web"].includes(row.Service)
            ? row.Service
            : "unknown",
          state: ["running", "exited", "created", "restarting"].includes(
            row.State,
          )
            ? row.State
            : "unknown",
          health: ["healthy", "unhealthy", "starting"].includes(row.Health)
            ? row.Health
            : "none",
        }));
      for (const service of ["api", "worker", "web"]) {
        const logs = await docker([
          ...compose,
          "logs",
          "--no-log-prefix",
          "--tail",
          "30",
          service,
        ]);
        if (logs.includes("Dynamic require of"))
          error.diagnostic = "BUNDLED_COMMONJS_REQUIRE";
      }
    }
    step = operationStep;
    throw error;
  }
  return output;
}
try {
  directory = await mkdtemp(path.join(tmpdir(), "agentconnect-release-smoke-"));
  await admin.unsafe(
    `CREATE ROLE "${identity}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`,
  );
  createdRole = true;
  await admin.unsafe(`CREATE DATABASE "${identity}" OWNER "${identity}"`);
  createdDatabase = true;
  const hostDatabase = new URL(original);
  hostDatabase.pathname = "/" + identity;
  const bootstrap = postgres(hostDatabase.href, { max: 1 });
  try {
    await bootstrap`CREATE EXTENSION vector`;
  } finally {
    await bootstrap.end();
  }
  const database = new URL(original);
  database.username = identity;
  database.password = password;
  database.hostname = "postgres";
  database.port = "5432";
  database.pathname = "/" + identity;
  const names = [
    "MASTER_KEY",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "S3_BUCKET",
    "MAIL_FROM",
    "MODEL_ALLOWED_HOSTS",
    "WEBHOOK_ALLOWED_HOSTS",
    "CONNECTOR_ALLOWED_HOSTS",
    "TOOL_ALLOWED_HOSTS",
    "KNOWLEDGE_ALLOWED_HOSTS",
  ];
  const variables = Object.fromEntries(
    names
      .filter((n) => process.env[n] !== undefined)
      .map((n) => [n, process.env[n]]),
  );
  Object.assign(variables, {
    NODE_ENV: "production",
    REQUIRE_EMAIL_VERIFICATION: "true",
    DATABASE_URL: database.href,
    REDIS_URL: "redis://redis:6379",
    S3_ENDPOINT: "http://storage:9000",
    TEMPORAL_ADDRESS: "temporal:7233",
    SMTP_URL: "smtp://mail:1025",
    WEB_ORIGIN: "https://web.agentconnect.example",
    MONITORING_TOKEN: randomBytes(32).toString("hex"),
    NO_PROXY: "postgres,redis,storage,temporal,mail,localhost,127.0.0.1",
    no_proxy: "postgres,redis,storage,temporal,mail,localhost,127.0.0.1",
  });
  for (const value of Object.values(variables))
    if (/[\r\n]/.test(value))
      throw new Error("MULTILINE_RUNTIME_VALUE_UNSUPPORTED");
  const envFile = path.join(directory, "runtime.env"),
    override = path.join(directory, "compose.yaml");
  await writeFile(
    envFile,
    Object.entries(variables)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  // Join only the existing local Compose infrastructure network; no host networking.
  await writeFile(
    override,
    JSON.stringify({
      networks: {
        default: {
          external: true,
          name: process.env.RELEASE_SMOKE_NETWORK ?? "agentconnect_default",
        },
      },
    }),
  );
  runtime = {
    ...process.env,
    RUNTIME_ENV_FILE: envFile,
    API_IMAGE: "agentconnect-release-api:test",
    WORKER_IMAGE: "agentconnect-release-worker:test",
    WEB_IMAGE: "agentconnect-release-web:test",
    API_PORT: "14000",
    WEB_PORT: "13000",
    WORKER_HEALTH_PORT: "14100",
  };
  compose = [
    "compose",
    "--project-name",
    identity,
    "-f",
    "deploy/compose.yaml",
    "-f",
    override,
  ];
  await docker([...compose, "config", "--quiet"]);
  for (let i = 0; i < 2; i++)
    await docker([
      ...compose,
      "run",
      "--rm",
      "--no-deps",
      "api",
      "node",
      "apps/api/dist/migrate.js",
    ]);
  const preflight = await docker([
    ...compose,
    "run",
    "--rm",
    "--no-deps",
    "api",
    "node",
    "apps/api/dist/deployment-check.js",
  ]);
  if (!preflight.includes('"status":"passed"'))
    throw new Error("PREFLIGHT_NOT_PASSED");
  await docker([...compose, "up", "-d", "--wait", "--wait-timeout", "180"]);
  for (const [service, port] of [
    ["api", 4000],
    ["worker", 4100],
  ]) {
    const probe = `const base='http://127.0.0.1:${port}';const denied=await fetch(base+'/internal/metrics');if(denied.status!==401)process.exit(1);const r=await fetch(base+'/internal/metrics',{headers:{authorization:'Bearer '+process.env.MONITORING_TOKEN}});const text=await r.text();if(!r.ok||!text.includes('agentconnect_${service}_ready 1'))process.exit(1);console.log('protected-metrics-passed')`;
    await docker([
      ...compose,
      "exec",
      "-T",
      service,
      "node",
      "--input-type=module",
      "-e",
      probe,
    ]);
    const id = (await docker([...compose, "ps", "--quiet", service])).trim();
    const protection = (
      await docker([
        "inspect",
        "--format",
        "{{.Config.User}} {{.HostConfig.ReadonlyRootfs}}",
        id,
      ])
    ).trim();
    if (protection !== "node true")
      throw new Error("CONTAINER_PROTECTION_FAILED");
  }
  await docker([
    ...compose,
    "exec",
    "-T",
    "web",
    "node",
    "-e",
    "fetch('http://127.0.0.1:3000/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
  ]);
  console.log(
    JSON.stringify({
      status: "passed",
      checks: [
        "packaged-migrations",
        "migration-repeatability",
        "nonprivileged-production-preflight",
        "compose-readiness",
        "private-metrics",
        "unprivileged-readonly-services",
        "standalone-web",
      ],
    }),
  );
} catch (error) {
  const code = /^[A-Z_]+$/.test(error.message)
    ? error.message
    : "RELEASE_SMOKE_FAILED";
  console.error(
    JSON.stringify({
      status: "failed",
      code,
      step,
      diagnostic: error.diagnostic,
      services: error.services,
    }),
  );
  process.exitCode = 1;
} finally {
  try {
    if (compose) await docker([...compose, "down", "--remove-orphans"]);
  } catch {
    console.error("CONTAINER_SMOKE_CLEANUP_FAILED");
    process.exitCode = 1;
  }
  try {
    if (createdDatabase)
      await admin.unsafe(`DROP DATABASE "${identity}" WITH (FORCE)`);
    if (createdRole) await admin.unsafe(`DROP ROLE "${identity}"`);
  } catch {
    console.error("DATABASE_SMOKE_CLEANUP_FAILED");
    process.exitCode = 1;
  }
  await admin.end();
  if (directory) await rm(directory, { recursive: true, force: true });
}
