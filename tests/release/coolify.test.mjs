import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const config = (overrides = {}) =>
  JSON.parse(
    execFileSync(
      "docker",
      ["compose", "-f", "compose.coolify.yaml", "config", "--format", "json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          WEB_ORIGIN: "https://app.example.com",
          API_PUBLIC_URL: "https://api.example.com",
          NEXT_PUBLIC_API_URL: "https://browser-api.example.com",
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
          ...overrides,
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
test("Coolify boots schema/storage before worker and uses explicit public origins and bakes the browser API origin into every build", () => {
  const { services: s } = config();
  assert.deepEqual(s.api.command, ["node", "apps/api/dist/bootstrap.js"]);
  assert.equal(s.worker.depends_on.api.condition, "service_healthy");
  for (const name of ["api", "worker", "web"]) {
    assert.equal(
      s[name].build.args.NEXT_PUBLIC_API_URL,
      "https://browser-api.example.com",
    );
    assert(s[name].healthcheck);
    assert.equal(s[name].read_only, true);
  }
  assert.equal(s.api.environment.WEB_ORIGIN, "https://app.example.com");
  assert.equal(
    s.api.environment.MESSAGING_PUBLIC_URL,
    "https://api.example.com",
  );
  assert.equal(s.worker.environment.WEB_ORIGIN, "https://app.example.com");
  assert.equal(
    s.api.environment.CONNECTOR_OAUTH_API_ORIGIN,
    "https://api.example.com",
  );
  assert.deepEqual(s.web.expose, ["3000"]);
  assert.deepEqual(s.api.expose, ["4000"]);
  assert(!JSON.stringify(s).includes("SERVICE_URL_"));
  assert.equal(s.temporal.environment.SKIP_DB_CREATE, "true");
});

test("Coolify domain defaults work when public URL variables are blank", () => {
  const { services: s } = config({
    WEB_ORIGIN: "",
    API_PUBLIC_URL: "",
    NEXT_PUBLIC_API_URL: "",
  });
  assert.equal(
    s.api.environment.WEB_ORIGIN,
    "https://agentconex.b-connect.site",
  );
  assert.equal(
    s.worker.environment.WEB_ORIGIN,
    "https://agentconex.b-connect.site",
  );
  assert.equal(
    s.api.environment.MESSAGING_PUBLIC_URL,
    "https://api.agentconex.b-connect.site",
  );
  assert.equal(
    s.api.environment.CONNECTOR_OAUTH_API_ORIGIN,
    "https://api.agentconex.b-connect.site",
  );
  assert.equal(
    s.web.build.args.NEXT_PUBLIC_API_URL,
    "https://api.agentconex.b-connect.site",
  );
});
