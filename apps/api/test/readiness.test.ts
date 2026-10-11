import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createReadinessProbe,
  readinessServices,
  type ReadinessChecks,
} from "../src/readiness.js";
import {
  requiredMigrations,
  supportedVectorVersion,
} from "../src/release-requirements.js";
const checks = (
  fn: (signal: AbortSignal) => Promise<unknown>,
): ReadinessChecks =>
  Object.fromEntries(readinessServices.map((s) => [s, fn])) as ReadinessChecks;
test("readiness coalesces concurrent calls and caches results without amplifying dependency load", async () => {
  let calls = 0,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const probe = createReadinessProbe(
    checks(async () => {
      calls++;
      await gate;
    }),
    1000,
    1000,
  );
  const pending = Array.from({ length: 20 }, () => probe());
  release();
  const results = await Promise.all(pending);
  assert.equal(calls, 4);
  assert.ok(results.every((r) => r.status === "ready"));
  await probe();
  assert.equal(calls, 4);
});
test("readiness deadlines abort hung probes, sanitize errors and recover after a fresh check", async () => {
  let hung = true,
    aborted = false;
  const dependencies = checks(async () => {});
  dependencies.storage = async (signal) => {
    if (hung)
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
  };
  const probe = createReadinessProbe(dependencies, 25, 0);
  const start = Date.now();
  assert.deepEqual(await probe(), {
    status: "unavailable",
    service: "storage",
  });
  assert.ok(Date.now() - start < 1000);
  assert.equal(aborted, true);
  hung = false;
  assert.equal((await probe()).status, "ready");
  dependencies.redis = async () => {
    throw new Error("redis://password-secret@private-host");
  };
  assert.deepEqual(await probe(), { status: "unavailable", service: "redis" });
});
test("readiness returns deterministic service codes for simultaneous dependency failures", async () => {
  const probe = createReadinessProbe(
    checks(async () => {
      throw new Error("secret");
    }),
    100,
    0,
  );
  assert.deepEqual(await probe(), {
    status: "unavailable",
    service: "postgres",
  });
});
test("release schema and vector requirements reject missing and unsupported extension versions", () => {
  assert.equal(requiredMigrations.length, 24);
  assert.equal(requiredMigrations.at(-1), "0024");
  for (const v of [
    undefined,
    "",
    "0.8.6",
    "0.7.99",
    "junk",
    "0.8.7-prerelease",
  ])
    assert.equal(supportedVectorVersion(v), false);
  for (const v of ["0.8.7", "0.8.8", "0.9.0", "1.0.0"])
    assert.equal(supportedVectorVersion(v), true);
});

test("production preflight rejects development mode, elevated/missing roles and default credentials", async () => {
  const { deploymentEnvironmentCode, deploymentPolicyCode } =
    await import("../src/deployment-policy.js");
  const config = {
    NODE_ENV: "production",
    S3_ACCESS_KEY: "scoped-service-account",
    MASTER_KEY: "0123456789abcdef".repeat(4),
  };
  const role = { rolsuper: false, rolbypassrls: false };
  assert.equal(
    deploymentEnvironmentCode({ ...config, NODE_ENV: "development" }, false),
    "PRODUCTION_ENV_REQUIRED",
  );
  assert.equal(deploymentEnvironmentCode(config, false), null);
  assert.equal(deploymentPolicyCode(config, role, false), null);
  for (const elevated of [
    { rolsuper: true, rolbypassrls: false },
    { rolsuper: false, rolbypassrls: true },
    undefined,
  ])
    assert.equal(
      deploymentPolicyCode(config, elevated, false),
      "APPLICATION_ROLE_TOO_PRIVILEGED",
    );
  assert.equal(
    deploymentPolicyCode(
      { ...config, MASTER_KEY: "0".repeat(64) },
      role,
      false,
    ),
    "DEVELOPMENT_CREDENTIALS_REJECTED",
  );
  assert.equal(
    deploymentPolicyCode(
      { ...config, S3_ACCESS_KEY: "minioadmin" },
      role,
      false,
    ),
    "DEVELOPMENT_CREDENTIALS_REJECTED",
  );
  assert.equal(
    deploymentPolicyCode(config, { rolsuper: true, rolbypassrls: true }, true),
    null,
  );
});
