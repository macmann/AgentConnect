import { validateManifest } from "./release-manifest.mjs";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
const [action, manifestPath, runtimePath, stateDirectory = ".local/release"] =
  process.argv.slice(2);
const allowed = new Set(["check", "deploy", "rollback", "migrate"]);
if (!allowed.has(action) || !manifestPath || !runtimePath) {
  console.error(
    "Usage: node scripts/release.mjs check|deploy|rollback|migrate MANIFEST.json RUNTIME.env [STATE_DIR]",
  );
  process.exit(1);
}
async function run(args, env) {
  const child = spawn("docker", args, { stdio: "inherit", env });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error("RELEASE_COMMAND_FAILED");
}
try {
  if (
    action === "rollback" &&
    process.env.RELEASE_ROLLBACK_COMPATIBLE !== "yes"
  )
    throw new Error("ROLLBACK_COMPATIBILITY_CONFIRMATION_REQUIRED");
  const manifest = validateManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  const runtime = path.resolve(runtimePath),
    state = path.resolve(stateDirectory);
  const permission = await stat(runtime);
  if ((permission.mode & 0o077) !== 0)
    throw new Error("RUNTIME_ENV_MUST_BE_PRIVATE");
  const env = {
    ...process.env,
    API_IMAGE: manifest.images.api,
    WORKER_IMAGE: manifest.images.worker,
    WEB_IMAGE: manifest.images.web,
    RUNTIME_ENV_FILE: runtime,
  };
  const compose = ["compose", "-f", "deploy/compose.yaml"];
  // Quiet validation never prints the runtime environment or resolved secrets.
  await run([...compose, "config", "--quiet"], env);
  if (action === "migrate") {
    if (process.env.RELEASE_BACKUP_CONFIRMED !== "yes")
      throw new Error("BACKUP_CONFIRMATION_REQUIRED");
    await run(
      [
        ...compose,
        "run",
        "--rm",
        "--no-deps",
        "api",
        "node",
        "apps/api/dist/migrate.js",
      ],
      env,
    );
  } else {
    await run([...compose, "pull"], env);
    await run(
      [
        ...compose,
        "run",
        "--rm",
        "--no-deps",
        "api",
        "node",
        "apps/api/dist/deployment-check.js",
      ],
      env,
    );
    if (action !== "check") {
      await mkdir(state, { recursive: true, mode: 0o700 });
      const current = path.join(state, "current.json");
      let previous;
      try {
        previous = await readFile(current, "utf8");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (previous)
        await writeFile(path.join(state, "previous.json"), previous, {
          mode: 0o600,
        });
      await run(
        [...compose, "up", "-d", "--wait", "--wait-timeout", "180"],
        env,
      );
      await writeFile(current, JSON.stringify(manifest, null, 2) + "\n", {
        mode: 0o600,
      });
    }
  }
  console.log(
    JSON.stringify({ status: "passed", action, commit: manifest.commit }),
  );
} catch (e) {
  console.error(
    JSON.stringify({
      status: "failed",
      code: /^[A-Z_]+$/.test(e.message) ? e.message : "RELEASE_FAILED",
    }),
  );
  process.exitCode = 1;
}
