import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { parseSkillBundle, readSkillZip } from "../src/skill-bundle.js";
const skill =
  "---\nname: report-writer\ndescription: >\n  Write clear reports\nallowed-tools: Bash\n---\n# Reports\nUse the outline in references/outline.md. Never invent figures.";
const zip = (files: Record<string, string | Uint8Array>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([path, text]) => [
        path,
        typeof text === "string" ? strToU8(text) : text,
      ]),
    ),
  );
const rejects = (data: Uint8Array, filename = "skill.zip") =>
  assert.throws(
    () => parseSkillBundle(data, filename),
    (e: unknown) => (e as { statusCode?: number }).statusCode === 400,
  );
function central(data: Uint8Array) {
  const b = Buffer.from(data);
  for (let i = 0; i < b.length - 4; i++)
    if (b.readUInt32LE(i) === 0x02014b50) return i;
  throw new Error("No directory");
}
test("standalone SKILL.md parses folded frontmatter; plain markdown has sensible metadata", () => {
  const parsed = parseSkillBundle(strToU8(skill), "skill.md");
  assert.equal(parsed.name, "report-writer");
  assert.equal(parsed.description, "Write clear reports");
  assert.ok(parsed.instructions.startsWith("# Reports"));
  assert.match(parsed.warnings.join(), /does not grant tool access/);
  const plain = parseSkillBundle(
    strToU8("# Friendly guide\n\nHelp people write clearer emails."),
    "SKILL.md",
  );
  assert.equal(plain.name, "Friendly guide");
  assert.equal(plain.description, "Help people write clearer emails.");
});
test("ZIP root folders and UTF-8 text references are supported; scripts/binary files stay non-executable", () => {
  const parsed = parseSkillBundle(
    zip({
      "reports/SKILL.md": skill,
      "reports/references/outline.md": "# Outline\nမြန်မာစာ — résumé",
      "reports/data/values.csv": "year,value\n2026,12",
      "reports/scripts/run.py": "raise Exception('must never execute')",
      "reports/logo.png": new Uint8Array([137, 80, 78, 71]),
      "reports/.config/credentials.json": strToU8('{"secret":"must-not-load"}'),
    }),
    "reports.zip",
  );
  assert.equal(parsed.references.length, 2);
  assert.equal(parsed.references[0]!.path, "references/outline.md");
  assert.match(parsed.references[0]!.content, /မြန်မာစာ/);
  assert.deepEqual(parsed.ignoredFiles, ["scripts/run.py", "logo.png"]);
  assert.ok(
    parsed.warnings.some((message) => message.includes("not executed")),
  );
});
test("unsafe paths, ambiguous packages, non-UTF-8 instructions and YAML aliases are rejected", () => {
  for (const path of [
    "../escape.md",
    "/absolute.md",
    "C:/escape.md",
    "scripts/../../escape.py",
    "bad\\path.txt",
  ])
    rejects(zip({ "SKILL.md": skill, [path]: "escape" }));
  rejects(zip({ "one/SKILL.md": skill, "two/SKILL.md": skill }));
  rejects(zip({ "SKILL.md": skill, "skill.md": skill }));
  rejects(zip({ "README.md": "No skill here" }));
  rejects(new Uint8Array([0xff, 0xfe, 0]), "SKILL.md");
  rejects(
    strToU8("---\nname: x\ndescription: &a Hello\ncopy: *a\n---\nDo something"),
    "SKILL.md",
  );
  rejects(
    strToU8(
      "---\nname: duplicate\nname: again\ndescription: test\n---\nDo something",
    ),
    "SKILL.md",
  );
  rejects(
    strToU8("---\nname: [bad]\ndescription: test\n---\nDo something"),
    "SKILL.md",
  );
  rejects(strToU8("---\nname: x\n"), "SKILL.md");
  rejects(strToU8(""), "SKILL.md");
  rejects(strToU8(skill), "instructions.txt");
});
test("entry, expansion and instruction/reference limits stop oversized archives", () => {
  rejects(new Uint8Array(5000001));
  rejects(zip({ "SKILL.md": skill, "huge.txt": "x".repeat(262145) }));
  rejects(zip({ "SKILL.md": "x".repeat(65537) }));
  rejects(zip({ "SKILL.md": skill, "large.md": "x".repeat(65537) }));
  rejects(
    zip(
      Object.fromEntries([
        ["SKILL.md", skill],
        ...Array.from({ length: 64 }, (_, i) => [`file${i}.txt`, "x"]),
      ]),
    ),
  );
  // A forged small declared size cannot bypass the native inflater's output ceiling.
  const forged = Buffer.from(zip({ "SKILL.md": "x".repeat(800000) }));
  forged.writeUInt32LE(32, central(forged) + 24);
  rejects(forged);
});
test("symlinks, encryption, checksum corruption and malformed ZIP structures are rejected", () => {
  for (const mutation of ["symlink", "encrypted", "checksum", "truncated"]) {
    const data = Buffer.from(zip({ "SKILL.md": skill }));
    const position = central(data);
    if (mutation === "symlink")
      data.writeUInt32LE((0o120777 << 16) >>> 0, position + 38);
    if (mutation === "encrypted")
      data.writeUInt16LE(data.readUInt16LE(position + 8) | 1, position + 8);
    if (mutation === "checksum")
      data.writeUInt32LE(
        (data.readUInt32LE(position + 16) ^ 1) >>> 0,
        position + 16,
      );
    rejects(
      mutation === "truncated" ? data.subarray(0, data.length - 2) : data,
    );
  }
  assert.throws(() => readSkillZip(new Uint8Array([80, 75, 3, 4])));
});
