import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Next's production webpack bundle and its external SSR runtime must use the
// same React mode. Next preserves an inherited NODE_ENV (even development).
const result = spawnSync(
  process.execPath,
  [
    require.resolve("next/dist/bin/next"),
    "build",
    "--webpack",
    ...process.argv.slice(2),
  ],
  {
    env: { ...process.env, NODE_ENV: "production" },
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
