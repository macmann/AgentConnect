import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
// Fully disposable stack; no production configuration, volumes or host ports.
if (process.env.NODE_ENV === "production")
  throw new Error("LOCAL_SMOKE_REQUIRED");
let dockerEnv = { ...process.env };
const apiOrigin =
  process.env.COOLIFY_SMOKE_API_ORIGIN ?? "https://api.coolify.example";
const project = "agentconnex-coolify-smoke-" + randomBytes(6).toString("hex");
const directory = await mkdtemp(path.join(tmpdir(), project));
const envFile = path.join(directory, "fixture.env"),
  file = path.join(directory, "compose.json");
const password = () => randomBytes(24).toString("hex");
let created = false;
async function docker(args) {
  const child = spawn("docker", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: dockerEnv,
  });
  let output = "",
    error = "";
  child.stdout.on("data", (v) => {
    output += v;
  });
  child.stderr.on("data", (v) => {
    if (error.length < 64000) error += v;
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) {
    const e = new Error("COOLIFY_SMOKE_DOCKER_FAILED");
    e.operation = args[0];
    if (error.includes("Cannot find package"))
      e.diagnostic = "MODULE_NOT_FOUND";
    throw e;
  }
  return output;
}
const compose = (...args) =>
  docker(["compose", "-p", project, "-f", file, ...args]);
const api = (code) => compose("exec", "-T", "api", "node", "-e", code);
try {
  const fixture = {
    SERVICE_URL_WEB_3000: "https://app.coolify.example",
    SERVICE_URL_API_4000: apiOrigin,
    SERVICE_PASSWORD_POSTGRES: password(),
    SERVICE_PASSWORD_APPDB: password(),
    SERVICE_PASSWORD_TEMPORAL: password(),
    SERVICE_PASSWORD_REDIS: password(),
    SERVICE_HEX_64_MASTERKEY: randomBytes(32).toString("hex"),
    SERVICE_USER_STORAGE: "ac" + randomBytes(8).toString("hex"),
    SERVICE_PASSWORD_64_STORAGE: password(),
    SERVICE_PASSWORD_64_MONITORING: password(),
    SMTP_URL: "smtp://mail:1025",
    MAIL_FROM: "noreply@coolify.example",
    LANGFUSE_PUBLIC_KEY: "",
    LANGFUSE_SECRET_KEY: "",
    LANGFUSE_BASE_URL: "",
    LANGFUSE_CAPTURE_CONTENT: "false",
  };
  // Host environment variables take precedence over --env-file. Override them
  // explicitly so a developer's real SMTP/tracing credentials never enter tests.
  dockerEnv = { ...process.env, ...fixture };
  await writeFile(
    envFile,
    Object.entries(fixture)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  const config = JSON.parse(
    await docker([
      "compose",
      "--env-file",
      envFile,
      "-f",
      "compose.coolify.yaml",
      "config",
      "--format",
      "json",
    ]),
  );
  delete config.name;
  // `compose config` materializes names from the caller's directory. Replace
  // every generated resource name so this fixture can never adopt local data.
  for (const [name, volume] of Object.entries(config.volumes ?? {})) {
    if (volume.external) throw new Error("EXTERNAL_FIXTURE_VOLUME_REJECTED");
    volume.name = project + "_" + name;
  }
  for (const [name, network] of Object.entries(config.networks ?? {})) {
    if (network.external) throw new Error("EXTERNAL_FIXTURE_NETWORK_REJECTED");
    network.name = project + "_" + name;
  }

  for (const [service, image] of Object.entries({
    api: "agentconnex-coolify-api:check",
    worker: "agentconnex-coolify-worker:check",
    web: "agentconnex-coolify-web:check",
    postgres: "agentconnex-coolify-postgres:check",
  })) {
    delete config.services[service].build;
    config.services[service].image = image;
    config.services[service].pull_policy = "never";
  }
  config.services.mail = {
    image:
      "axllent/mailpit:latest@sha256:b68349e3a014b90c5610bfb26b2ae36f3892d7b8cf25ee140c6c71c98d2fcf48",
  };
  for (const service of Object.values(config.services)) {
    if (service.ports?.length) throw new Error("SMOKE_PORT_EXPOSURE");
    if (service.environment?.NO_PROXY) {
      service.environment.NO_PROXY += ",mail";
      service.environment.no_proxy += ",mail";
    }
  }
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  created = true;
  await compose("up", "-d", "--wait", "--wait-timeout", "300");
  console.log("Fresh Coolify stack: healthy");
  if (process.env.COOLIFY_SMOKE_EXPECT_PDF_TOOLS === "true")
    await compose("exec", "-T", "worker", "pdftoppm", "-v");
  await compose(
    "exec",
    "-T",
    "web",
    "node",
    "-e",
    `const fs=require('node:fs');function find(p){return fs.readdirSync(p,{withFileTypes:true}).some(e=>e.isDirectory()?find(p+'/'+e.name):e.name.endsWith('.js')&&fs.readFileSync(p+'/'+e.name,'utf8').includes(${JSON.stringify(apiOrigin)}));}if(!find('/app/apps/web/.next/static'))process.exit(1);`,
  );
  await api(
    "fetch('http://127.0.0.1:4000/auth/me',{method:'OPTIONS',headers:{Origin:'https://app.coolify.example','Access-Control-Request-Method':'GET'}}).then(r=>{if(r.status!==204||r.headers.get('access-control-allow-origin')!=='https://app.coolify.example')process.exit(1)}).catch(()=>process.exit(1))",
  );
  // Real packaged production preflight, migration idempotency, persistence and mail.
  await compose(
    "exec",
    "-T",
    "api",
    "node",
    "apps/api/dist/deployment-check.js",
  );
  const before = await compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "agentconnex_admin",
    "-d",
    "agentconnex",
    "-tAc",
    "SELECT count(*) FROM schema_migrations",
  );
  await compose("exec", "-T", "api", "node", "apps/api/dist/migrate.js");
  const after = await compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "agentconnex_admin",
    "-d",
    "agentconnex",
    "-tAc",
    "SELECT count(*) FROM schema_migrations",
  );
  if (before.trim() !== after.trim())
    throw new Error("MIGRATION_RERUN_CHANGED_SCHEMA");
  const role = await compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "agentconnex_admin",
    "-d",
    "agentconnex",
    "-tAc",
    "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname='agentconnex'",
  );
  if (role.trim() !== "f") throw new Error("PRIVILEGED_APPLICATION_ROLE");
  await api(
    `fetch('http://127.0.0.1:4000/auth/register',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://app.coolify.example'},body:JSON.stringify({email:'smoke@coolify.example',name:'Smoke user',password:'Strong-smoke-password-294!'} )}).then(async r=>{if(r.status!==201)throw new Error('REGISTER_FAILED')}).catch(()=>process.exit(1))`,
  );
  let delivered = false;
  for (let n = 0; n < 20; n++) {
    const result = await api(
      `fetch('http://mail:8025/api/v1/messages').then(r=>r.json()).then(v=>console.log(v.total>0?'delivered':'waiting')).catch(()=>console.log('waiting'))`,
    );
    if (result.includes("delivered")) {
      delivered = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!delivered) throw new Error("MAIL_NOT_DELIVERED");
  console.log(
    "Registration and verification email: delivered to fixture inbox",
  );
  const usersBefore = await compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "agentconnex_admin",
    "-d",
    "agentconnex",
    "-tAc",
    "SELECT count(*) FROM users WHERE email='smoke@coolify.example'",
  );
  await compose("restart", "api", "worker", "web");
  await compose("up", "-d", "--wait", "--wait-timeout", "180");
  const usersAfter = await compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "agentconnex_admin",
    "-d",
    "agentconnex",
    "-tAc",
    "SELECT count(*) FROM users WHERE email='smoke@coolify.example'",
  );
  if (usersBefore.trim() !== "1" || usersAfter.trim() !== "1")
    throw new Error("PERSISTENCE_FAILED");
  console.log("Restart, repeat bootstrap and database persistence: passed");
} catch (error) {
  console.error(
    JSON.stringify({
      status: "failed",
      code: error.message,
      operation: error.operation,
      diagnostic: error.diagnostic,
    }),
  );
  if (created) {
    try {
      const states = await compose("ps", "--all", "--format", "json");
      for (const line of states.trim().split("\n").filter(Boolean)) {
        const s = JSON.parse(line);
        console.error(
          JSON.stringify({
            service: s.Service,
            state: s.State,
            health: s.Health,
          }),
        );
      }
    } catch {
      /* preserve original failure */
    }
  }
  process.exitCode = 1;
} finally {
  if (created)
    await compose("down", "--volumes", "--remove-orphans").catch(() => {
      console.error("FIXTURE_CLEANUP_FAILED");
      process.exitCode = 1;
    });
  await rm(directory, { recursive: true, force: true });
}
