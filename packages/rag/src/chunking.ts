import { KnowledgeError, type ParsedDocument } from "./parsers.js";
export interface Chunk {
  content: string;
  page: number | null;
  heading: string | null;
  metadata: Record<string, unknown>;
}
export function chunkDocument(
  document: ParsedDocument,
  options: { chunkSize: number; chunkOverlap: number; chunkStrategy: string },
): Chunk[] {
  const { chunkSize, chunkOverlap } = options;
  if (chunkSize < 200 || chunkOverlap >= chunkSize || chunkOverlap < 0)
    throw new KnowledgeError("INVALID_CHUNK_CONFIG");
  const result: Chunk[] = [];
  for (const section of document.sections) {
    const parts =
      options.chunkStrategy === "heading"
        ? section.text.split(/(?=^#{1,6} +)/m)
        : [section.text];
    for (const text of parts) {
      let start = 0;
      while (start < text.length) {
        let end = Math.min(start + chunkSize, text.length);
        if (end < text.length && options.chunkStrategy !== "page") {
          const boundary = Math.max(
            text.lastIndexOf("\n", end),
            text.lastIndexOf(" ", end),
          );
          if (boundary > start + chunkSize * 0.6) end = boundary;
        }
        const content = text.slice(start, end).trim();
        if (content)
          result.push({
            content,
            page: section.page,
            heading: text.match(/^#{1,6} +(.+)/)?.[1] ?? section.heading,
            metadata: section.metadata,
          });
        if (result.length > 500) throw new KnowledgeError("CHUNK_LIMIT");
        if (end === text.length) break;
        start = Math.max(start + 1, end - chunkOverlap);
      }
    }
  }
  return result;
}
