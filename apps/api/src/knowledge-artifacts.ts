import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { KnowledgeError, type ParsedDocument } from "@agentconnect/rag/parsers";
import { readKnowledge, storeKnowledge } from "./knowledge-storage.js";

export const parsedArtifact = z.object({
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  document: z.object({
    title: z.string().max(200),
    sections: z
      .array(
        z.object({
          text: z.string(),
          page: z.number().int().positive().nullable(),
          heading: z.string().nullable(),
          metadata: z.record(z.string(), z.unknown()),
        }),
      )
      .max(10000),
    metadata: z.record(z.string(), z.unknown()),
    links: z.array(z.string()),
  }),
});
export const digestInput = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
export function ownedArtifact(key: unknown, prefix: string) {
  if (typeof key !== "string" || !key.startsWith(prefix) || key.includes(".."))
    throw new KnowledgeError("EXTRACTION_ARTIFACT_UNAVAILABLE");
  return key;
}
export async function readParsedArtifact(
  key: unknown,
  prefix: string,
  signal: AbortSignal,
) {
  const value = parsedArtifact.parse(
    JSON.parse(
      (await readKnowledge(ownedArtifact(key, prefix), signal)).toString(
        "utf8",
      ),
    ),
  );
  if (value.document.sections.reduce((n, s) => n + s.text.length, 0) > 2000000)
    throw new KnowledgeError("EXTRACTED_TEXT_LIMIT");
  return value;
}
export async function saveParsedArtifact(
  prefix: string,
  inputHash: string,
  document: ParsedDocument,
) {
  const artifact = parsedArtifact.parse({ inputHash, document });
  if (
    artifact.document.sections.reduce((n, s) => n + s.text.length, 0) > 2000000
  )
    throw new KnowledgeError("EXTRACTED_TEXT_LIMIT");
  const key = `${prefix}parsed/${randomUUID()}.json`;
  await storeKnowledge(key, Buffer.from(JSON.stringify(artifact)));
  return key;
}
