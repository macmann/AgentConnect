import { readFile } from "node:fs/promises";
import { validateManifest } from "./release-manifest.mjs";
const [repository, commit, publicApiUrl] = process.argv.slice(2);
const images = {};
for (const service of ["api", "worker", "web"]) {
  const metadata = JSON.parse(
    await readFile(`${service}-metadata.json`, "utf8"),
  );
  images[service] =
    `ghcr.io/${repository}-${service}@${metadata["containerimage.digest"]}`;
}
console.log(
  JSON.stringify(
    validateManifest({ schemaVersion: 1, commit, publicApiUrl, images }),
    null,
    2,
  ),
);
