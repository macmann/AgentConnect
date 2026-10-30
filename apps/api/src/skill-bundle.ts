import { crc32, inflateRawSync } from "node:zlib";
import { parseDocument } from "yaml";
import { HttpError } from "./http-error.js";
const fail = (message: string): never => {
  throw new HttpError(400, message);
};
const utf8 = (bytes: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("Skill instructions and text references must use UTF-8.");
  }
};
function safePath(name: string) {
  if (
    !name ||
    name.length > 240 ||
    /[\\\x00-\x1f\x7f:]/.test(name) ||
    name.startsWith("/") ||
    name.split("/").some((part) => part === ".." || part === "." || !part)
  )
    fail("The ZIP contains an unsafe or ambiguous file path.");
  return name;
}
/** Read bounded ZIP entries in memory; never extract files to the host filesystem. */
export function readSkillZip(data: Uint8Array) {
  if (data.byteLength > 5_000_000) fail("Skill uploads are limited to 5 MB.");
  const bytes = Buffer.from(data);
  let end = -1;
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 65557);
    offset--
  ) {
    if (
      bytes.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0) fail("Invalid ZIP archive.");
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6))
    fail("Multipart ZIP archives are not supported.");
  const count = bytes.readUInt16LE(end + 10),
    directory = bytes.readUInt32LE(end + 16),
    directorySize = bytes.readUInt32LE(end + 12);
  if (
    !count ||
    count > 64 ||
    bytes.readUInt16LE(end + 8) !== count ||
    directory + directorySize !== end
  )
    fail("ZIP must contain 1–64 entries and cannot use ZIP64.");
  let offset = directory,
    total = 0;
  const names = new Set<string>();
  const files: { path: string; bytes: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
      fail("Invalid ZIP directory.");
    const flags = bytes.readUInt16LE(offset + 8),
      method = bytes.readUInt16LE(offset + 10),
      crc = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20),
      size = bytes.readUInt32LE(offset + 24),
      nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30),
      commentLength = bytes.readUInt16LE(offset + 32),
      local = bytes.readUInt32LE(offset + 42);
    const mode = bytes.readUInt32LE(offset + 38) >>> 16;
    if (
      flags & 1 ||
      (method !== 0 && method !== 8) ||
      (mode & 0xf000) === 0xa000 ||
      bytes.readUInt16LE(offset + 34)
    )
      fail(
        "Encrypted, symbolic-link or unsupported ZIP entries are not allowed.",
      );
    if (size > 262144 || compressed > 5_000_000 || (total += size) > 1_000_000)
      fail("Expanded skills are limited to 1 MB total and 256 KB per file.");
    if (offset + 46 + nameLength + extraLength + commentLength > end)
      fail("Invalid ZIP directory entry.");
    const rawName = utf8(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const directoryEntry = rawName.endsWith("/");
    const path = safePath(directoryEntry ? rawName.slice(0, -1) : rawName);
    const key = path.toLocaleLowerCase();
    if (names.has(key))
      fail("ZIP file paths must be unique, including letter case.");
    names.add(key);
    if (local + 30 > directory || bytes.readUInt32LE(local) !== 0x04034b50)
      fail("Invalid ZIP local entry.");
    const localNameLength = bytes.readUInt16LE(local + 26),
      localExtra = bytes.readUInt16LE(local + 28),
      start = local + 30 + localNameLength + localExtra;
    if (
      start + compressed > directory ||
      bytes.readUInt16LE(local + 8) !== method ||
      bytes.readUInt16LE(local + 6) !== flags ||
      utf8(bytes.subarray(local + 30, local + 30 + localNameLength)) !== rawName
    )
      fail("ZIP entry metadata does not match its directory.");
    let content: Uint8Array;
    try {
      content =
        method === 0
          ? bytes.subarray(start, start + compressed)
          : inflateRawSync(bytes.subarray(start, start + compressed), {
              maxOutputLength: 262144,
            });
    } catch {
      return fail("Invalid or oversized compressed skill entry.");
    }
    if (content.length !== size || crc32(content) !== crc)
      fail("ZIP entry checksum or size is invalid.");
    if (
      !directoryEntry &&
      !path.startsWith("__MACOSX/") &&
      !path.split("/").some((part) => part.startsWith("."))
    )
      files.push({ path, bytes: content });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== end) fail("Invalid ZIP directory size.");
  return files;
}
export type SkillBundle = {
  name: string;
  description: string;
  instructions: string;
  references: { path: string; content: string }[];
  ignoredFiles: string[];
  warnings: string[];
};
export function parseSkillBundle(
  data: Uint8Array,
  filename: string,
): SkillBundle {
  const zip = filename.toLowerCase().endsWith(".zip");
  if (!zip && filename.toLowerCase() !== "skill.md")
    fail("Upload SKILL.md or a ZIP containing one SKILL.md.");
  const entries = zip
    ? readSkillZip(data)
    : [{ path: "SKILL.md", bytes: data }];
  const mains = entries.filter(
    (entry) => entry.path.split("/").at(-1)?.toLowerCase() === "skill.md",
  );
  if (mains.length !== 1)
    fail("Each upload must contain exactly one SKILL.md.");
  const main = mains[0]!;
  if (main.bytes.length > 65536) fail("SKILL.md is limited to 64 KB.");
  const prefix = main.path.slice(0, -"SKILL.md".length);
  let instructions = utf8(main.bytes)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n");
  let metadata: Record<string, unknown> = {};
  if (instructions.startsWith("---\n")) {
    const close = instructions.indexOf("\n---", 4);
    if (
      close < 0 ||
      close > 8192 ||
      !/^\n---(?:\n|$)/.test(instructions.slice(close))
    )
      fail("Invalid or oversized SKILL.md frontmatter.");
    const doc = parseDocument(instructions.slice(4, close), {
      uniqueKeys: true,
    });
    if (doc.errors.length || doc.warnings.length)
      fail("Invalid YAML frontmatter.");
    let parsed: unknown;
    try {
      parsed = doc.toJS({ maxAliasCount: 0 });
    } catch {
      return fail("YAML aliases are not supported in skills.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      fail("Skill frontmatter must be a mapping.");
    metadata = parsed as Record<string, unknown>;
    instructions = instructions.slice(close + 4).trim();
  }
  instructions = instructions.trim();
  if (!instructions || instructions.includes("\0"))
    fail("SKILL.md must contain usable instructions.");
  if (
    (metadata.name !== undefined && typeof metadata.name !== "string") ||
    (metadata.description !== undefined &&
      typeof metadata.description !== "string")
  )
    fail("Skill name and description must be text.");
  const name =
    typeof metadata.name === "string"
      ? metadata.name.trim()
      : (instructions.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "Uploaded skill");
  const description =
    typeof metadata.description === "string"
      ? metadata.description.trim()
      : instructions
          .replace(/^#+.*$/gm, "")
          .trim()
          .split(/\n\s*\n/)[0]!
          .slice(0, 300);
  if (!name || name.length > 100 || !description || description.length > 1000)
    fail(
      "Provide a skill name (1–100 characters) and description (1–1,000 characters).",
    );
  const references: SkillBundle["references"] = [],
    ignoredFiles: string[] = [],
    warnings: string[] = [];
  let textBytes = main.bytes.length;
  for (const entry of entries) {
    if (entry === main) continue;
    if (!entry.path.startsWith(prefix))
      fail("All bundle files must be inside the SKILL.md folder.");
    const relative = entry.path.slice(prefix.length);
    if (/\.(md|txt|csv|json|ya?ml)$/i.test(relative)) {
      if (
        entry.bytes.length > 65536 ||
        (textBytes += entry.bytes.length) > 262144
      )
        fail(
          "Text references are limited to 64 KB each and 256 KB total including SKILL.md.",
        );
      const content = utf8(entry.bytes);
      if (content.includes("\0"))
        fail("Text references cannot contain binary content.");
      references.push({ path: relative, content });
    } else ignoredFiles.push(relative);
  }
  if (ignoredFiles.length)
    warnings.push(
      "Scripts and binary assets are not executed or included in runtime context. Only SKILL.md and text references are supported.",
    );
  if (metadata["allowed-tools"])
    warnings.push(
      "Frontmatter allowed-tools does not grant tool access. Attach approved tools separately.",
    );
  return {
    name,
    description,
    instructions,
    references,
    ignoredFiles,
    warnings,
  };
}
