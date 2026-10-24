import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const config = () =>
  JSON.parse(
    execFileSync(
      "docker",
      ["compose", "-f", "compose.coolify.yaml", "config", "--format", "json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SERVICE_URL_WEB_3000: "https://app.example.com",
          SERVICE_URL_API_4000: "https://api.example.com",
          SERVICE_PASSWORD_POSTGRES: "fixtureadmin",
          SERVICE_PASSWORD_APPDB: "fixtureapp",
          SERVICE_PASSWORD_TEMPORAL: "fixturetemporal",
          SERVICE_PASSWORD_REDIS: "fixtureredis",
          SERVICE_HEX_64_MASTERKEY: "a".repeat(64),
          SERVICE_USER_STORAGE: "fixturestorage",
          SERVICE_PASSWORD_64_STORAGE: "fixturestoragesecret",
          SERVICE_PASSWORD_64_MONITORING: "m".repeat(64),
          SMTP_URL: "smtps://fixture.example:465",
          MAIL_FROM: "noreply@example.com",
        },
      },
    ),
  );
test("Coolify deployment keeps infrastructure private and credentials consistent across services", () => {
  const { services: s, volumes } = config();
  for (const [name, v] of Object.entries(s))
    assert(!v.ports?.length, `${name} publishes a host port`);
  assert.deepEqual(Object.keys(volumes).sort(), [
    "postgres",
    "redis",
    "storage",
  ]);
  assert.equal(
    s.api.environment.DATABASE_URL,
    s.worker.environment.DATABASE_URL,
  );
  assert(s.api.environment.DATABASE_URL.startsWith("postgres://agentconnex:"));
  assert.equal(s.api.environment.MASTER_KEY, s.worker.environment.MASTER_KEY);
  assert.equal(s.api.environment.REQUIRE_EMAIL_VERIFICATION, "true");
  assert.equal(
    s.api.environment.S3_SECRET_KEY,
    s.storage.environment.RUSTFS_SECRET_KEY,
  );
  assert(s.temporal.image.includes("@sha256:"));
  assert(!JSON.stringify(s.temporal.command ?? "").includes("start-dev"));
});
test("Coolify boots schema/storage before worker and bakes the same API origin into every application build", () => {
  const { services: s } = config();
  assert.deepEqual(s.api.command, ["node", "apps/api/dist/bootstrap.js"]);
  assert.equal(s.worker.depends_on.api.condition, "service_healthy");
  for (const name of ["api", "worker", "web"]) {
    assert.equal(
      s[name].build.args.NEXT_PUBLIC_API_URL,
      "https://api.example.com",
    );
    assert(s[name].healthcheck);
    assert.equal(s[name].read_only, true);
  }
  assert.equal(s.api.environment.WEB_ORIGIN, "https://app.example.com");
  assert.equal(
    s.api.environment.MESSAGING_PUBLIC_URL,
    "https://api.example.com",
  );
  assert.equal(s.temporal.environment.SKIP_DB_CREATE, "true");
});
