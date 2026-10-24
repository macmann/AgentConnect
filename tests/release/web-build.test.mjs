import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";

test("web renderer and client libraries resolve the same React installation", () => {
  const web = createRequire(
    new URL("../../apps/web/package.json", import.meta.url),
  );
  const expected = realpathSync(web.resolve("react"));
  for (const dependency of [
    "react-dom",
    "next",
    "lucide-react",
    "@radix-ui/react-dialog",
    "@tanstack/react-query",
    "react-hook-form",
    "@xyflow/react",
  ]) {
    const fromDependency = createRequire(web.resolve(dependency));
    assert.equal(
      realpathSync(fromDependency.resolve("react")),
      expected,
      dependency,
    );
  }
  assert.equal(
    web("react/package.json").version,
    web("react-dom/package.json").version,
  );
});

test("web build starts the real Next CLI in production regardless of inherited mode", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agentconnex-web-build-"));
  const preload = path.join(dir, "observe.mjs");
  const trace = path.join(dir, "mode.json");
  try {
    await writeFile(
      preload,
      `import { writeFileSync } from "node:fs";
if (process.argv[1]?.replaceAll("\\\\", "/").endsWith("/next/dist/bin/next")) {
  writeFileSync(process.env.WEB_BUILD_TEST_TRACE, JSON.stringify({
    mode: process.env.NODE_ENV, args: process.argv.slice(2),
    publicApiUrl: process.env.NEXT_PUBLIC_API_URL
  }));
}`,
    );
    for (const inherited of [
      undefined,
      "development",
      "test",
      "production",
      "staging",
    ]) {
      const env = {
        ...process.env,
        NEXT_PUBLIC_API_URL: "https://api.example.test",
        WEB_BUILD_TEST_TRACE: trace,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`,
      };
      if (inherited === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = inherited;
      // --help exercises the installed CLI without rebuilding for each mode.
      const result = spawnSync(process.execPath, ["build.mjs", "--help"], {
        cwd: new URL("../../apps/web/", import.meta.url),
        env,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(await readFile(trace, "utf8")), {
        mode: "production",
        args: ["build", "--webpack", "--help"],
        publicApiUrl: "https://api.example.test",
      });
    }
    const failed = spawnSync(
      process.execPath,
      ["build.mjs", "--invalid-option-fixture"],
      {
        cwd: new URL("../../apps/web/", import.meta.url),
        encoding: "utf8",
      },
    );
    assert.equal(failed.status, 1, "Next CLI failures must fail the build");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
