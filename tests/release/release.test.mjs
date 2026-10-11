import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  chmod,
  rm,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { validateManifest } from "../../scripts/release-manifest.mjs";
const digest = "a".repeat(64);
const manifest = {
  schemaVersion: 1,
  commit: "b".repeat(40),
  publicApiUrl: "https://api.example.test",
  images: Object.fromEntries(
    ["api", "worker", "web"].map((s) => [
      s,
      `ghcr.io/example/${s}@sha256:${digest}`,
    ]),
  ),
};
test("Release manifest requires immutable images and a credential-free HTTPS API URL", () => {
  assert.deepEqual(validateManifest(manifest), manifest);
  for (const value of [
    { ...manifest, commit: "main" },
    { ...manifest, images: { ...manifest.images, api: "example/api:latest" } },
    { ...manifest, publicApiUrl: "http://api.example.test" },
    { ...manifest, publicApiUrl: "https://key:password@api.example.test" },
  ])
    assert.throws(() => validateManifest(value));
});
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "agentconnect-release-test-"));
  const bin = path.join(dir, "bin"),
    state = path.join(dir, "state");
  await mkdir(bin);
  await mkdir(state);
  await writeFile(path.join(dir, "release.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(dir, "runtime.env"),
    "SECRET_FIXTURE=never-print-this\n",
    { mode: 0o600 },
  );
  await writeFile(
    path.join(bin, "docker"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify(args)+'\\n');
if (process.env.RELEASE_TEST_FAIL && args.includes(process.env.RELEASE_TEST_FAIL)) process.exit(1);
`,
    { mode: 0o700 },
  );
  async function run(action, extra = {}) {
    const child = spawn(
      process.execPath,
      [
        "scripts/release.mjs",
        action,
        path.join(dir, "release.json"),
        path.join(dir, "runtime.env"),
        state,
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          RELEASE_TEST_LOG: path.join(dir, "calls.log"),
          ...extra,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (v) => (output += v));
    child.stderr.on("data", (v) => (output += v));
    const code = await new Promise((r, e) => {
      child.on("exit", r);
      child.on("error", e);
    });
    assert(!output.includes("never-print-this"));
    let calls = [];
    try {
      calls = (await readFile(path.join(dir, "calls.log"), "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
    } catch {}
    return { code, output, calls };
  }
  return {
    dir,
    state,
    run,
    close: () => rm(dir, { recursive: true, force: true }),
  };
}
test("Deploy checks configuration and preflight before rollout and records only a successful manifest", async () => {
  const f = await fixture();
  try {
    const r = await f.run("deploy");
    assert.equal(r.code, 0, r.output);
    assert.deepEqual(
      r.calls.map((v) => v[3]),
      ["config", "pull", "run", "up"],
    );
    assert(r.calls[2].includes("apps/api/dist/deployment-check.js"));
    assert(r.calls[3].includes("--wait"));
    assert.deepEqual(
      JSON.parse(await readFile(path.join(f.state, "current.json"), "utf8")),
      manifest,
    );
  } finally {
    await f.close();
  }
});
test("Failed preflight never rolls out or changes the current release", async () => {
  const f = await fixture();
  try {
    const prior = { ...manifest, commit: "c".repeat(40) };
    await writeFile(path.join(f.state, "current.json"), JSON.stringify(prior));
    const r = await f.run("deploy", {
      RELEASE_TEST_FAIL: "apps/api/dist/deployment-check.js",
    });
    assert.equal(r.code, 1);
    assert(!r.calls.some((c) => c.includes("up")));
    assert.deepEqual(
      JSON.parse(await readFile(path.join(f.state, "current.json"), "utf8")),
      prior,
    );
  } finally {
    await f.close();
  }
});
test("Failed rollout preserves current state and never attempts automatic database reversal", async () => {
  const f = await fixture();
  try {
    const prior = { ...manifest, commit: "c".repeat(40) };
    await writeFile(path.join(f.state, "current.json"), JSON.stringify(prior));
    const r = await f.run("deploy", { RELEASE_TEST_FAIL: "up" });
    assert.equal(r.code, 1);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(f.state, "current.json"), "utf8")),
      prior,
    );
    assert(!r.calls.some((c) => c.includes("apps/api/dist/migrate.js")));
  } finally {
    await f.close();
  }
});
test("Migrations require backup confirmation; rollback requires compatibility confirmation", async () => {
  const f = await fixture();
  try {
    const migrate = await f.run("migrate");
    assert.equal(migrate.code, 1);
    assert(!migrate.calls.some((c) => c.includes("run")));
    const rollback = await f.run("rollback");
    assert.equal(rollback.code, 1);
    const confirmed = await f.run("migrate", {
      RELEASE_BACKUP_CONFIRMED: "yes",
    });
    assert.equal(confirmed.code, 0, confirmed.output);
    assert(confirmed.calls.some((c) => c.includes("apps/api/dist/migrate.js")));
  } finally {
    await f.close();
  }
});
test("World-readable runtime secrets are rejected before Docker runs", async () => {
  const f = await fixture();
  try {
    await chmod(path.join(f.dir, "runtime.env"), 0o644);
    const r = await f.run("check");
    assert.equal(r.code, 1);
    assert.equal(r.calls.length, 0);
    assert.match(r.output, /RUNTIME_ENV_MUST_BE_PRIVATE/);
  } finally {
    await f.close();
  }
});
