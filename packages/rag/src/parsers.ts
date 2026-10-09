import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { load } from "cheerio";
import { parse as csv } from "csv-parse/sync";
export class KnowledgeError extends Error {
  constructor(
    public code: string,
    public retryable = false,
  ) {
    super("Knowledge operation failed");
  }
}
export interface Section {
  text: string;
  page: number | null;
  heading: string | null;
  metadata: Record<string, unknown>;
}
export interface ParsedDocument {
  title: string;
  sections: Section[];
  metadata: Record<string, unknown>;
  links: string[];
}
export type DocumentParser = (
  data: Uint8Array,
  filename: string,
  signal: AbortSignal,
) => Promise<ParsedDocument>;
const section = (
  text: string,
  page: number | null = null,
  heading: string | null = null,
  metadata: Record<string, unknown> = {},
): Section => ({ text, page, heading, metadata });
export const supportedExtensions = [
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  "csv",
  "txt",
  "md",
  "markdown",
  "html",
  "htm",
  "json",
];
const plain = (data: Uint8Array) => {
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(data)
      .replace(/\u0000/g, "");
  } catch {
    throw new KnowledgeError("INVALID_TEXT_ENCODING");
  }
};
export function parseHTML(data: Uint8Array, title: string): ParsedDocument {
  const $ = load(plain(data));
  $("script,style,noscript,iframe,object,svg,nav,footer").remove();
  const links = $("a[href]")
    .map((_, a) => $(a).attr("href")!)
    .get()
    .slice(0, 500);
  const canonical = $('link[rel="canonical"]').attr("href");
  const label = ($("title").first().text().trim() || title).slice(0, 200);
  const container = $("main").first().length ? $("main").first() : $("body");
  container.find("br").replaceWith("\n");
  container.find("p,div,li,tr,h1,h2,h3,h4,h5,h6").each((_, el) => {
    $(el).prepend("\n").append("\n");
  });
  const text = container
    .text()
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    title: label,
    sections: [section(text)],
    metadata: {
      canonical: canonical ?? null,
      headings: $("h1,h2,h3")
        .map((_, h) => $(h).text())
        .get()
        .slice(0, 100),
    },
    links,
  };
}
const parsers = new Map<string, DocumentParser>();
export function registerParser(extension: string, parser: DocumentParser) {
  parsers.set(extension, parser);
}
for (const ext of ["txt", "md", "markdown"])
  registerParser(ext, async (data, filename) => {
    const text = plain(data);
    if (ext === "txt")
      return {
        title: filename,
        sections: [section(text)],
        metadata: {},
        links: [],
      };
    const parts = text.split(/(?=^#{1,6} +)/m);
    return {
      title: filename,
      sections: parts.map((t) =>
        section(t, null, t.match(/^#{1,6} +(.+)/)?.[1] ?? null),
      ),
      metadata: {},
      links: [],
    };
  });
for (const ext of ["html", "htm"])
  registerParser(ext, async (data, name) => parseHTML(data, name));
registerParser("csv", async (data, name) => {
  const rows = csv(plain(data), {
    bom: true,
    relax_column_count: true,
    max_record_size: 100000,
    skip_empty_lines: true,
  }) as string[][];
  if (rows.length > 50000) throw new KnowledgeError("DOCUMENT_LIMIT");
  return {
    title: name,
    sections: [section(rows.map((r) => r.join(" | ")).join("\n"))],
    metadata: { rows: rows.length, columns: rows[0] ?? [] },
    links: [],
  };
});
registerParser("json", async (data, name) => {
  let value: unknown;
  try {
    value = JSON.parse(plain(data));
  } catch {
    throw new KnowledgeError("INVALID_JSON");
  }
  return {
    title: name,
    sections: [section(JSON.stringify(value, null, 2))],
    metadata: {},
    links: [],
  };
});
function office(data: Uint8Array) {
  let expanded = 0,
    count = 0;
  try {
    return unzipSync(data, {
      filter: (entry) => {
        expanded += entry.originalSize;
        count++;
        if (
          expanded > 30000000 ||
          entry.originalSize > 10000000 ||
          count > 2000
        )
          throw new KnowledgeError("ARCHIVE_LIMIT");
        return /\.xml$/.test(entry.name);
      },
    });
  } catch (e) {
    if (e instanceof KnowledgeError) throw e;
    throw new KnowledgeError("INVALID_OFFICE_DOCUMENT");
  }
}
const xml = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  processEntities: false,
  parseTagValue: false,
  textNodeName: "#text",
});
function readXML(bytes: Uint8Array | undefined) {
  if (!bytes) throw new KnowledgeError("INVALID_OFFICE_DOCUMENT");
  const text = plain(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new KnowledgeError("UNSAFE_XML");
  return xml.parse(text) as Record<string, unknown>;
}
function texts(node: unknown, tag = "t"): string[] {
  if (!node || typeof node !== "object") return [];
  const result: string[] = [];
  for (const [k, v] of Object.entries(node)) {
    if (k === tag) {
      const list = Array.isArray(v) ? v : [v];
      for (const t of list)
        result.push(
          typeof t === "string"
            ? t
            : String((t as Record<string, unknown>)?.["#text"] ?? ""),
        );
    } else if (k === "p" || k === "row" || k === "tr") {
      for (const item of Array.isArray(v) ? v : [v]) {
        result.push(...texts(item, tag));
        result.push("\n");
      }
    } else result.push(...texts(v, tag));
  }
  return result;
}
registerParser("docx", async (data, name) => {
  const files = office(data);
  const doc = readXML(files["word/document.xml"]);
  return {
    title: name,
    sections: [
      section(
        texts(doc)
          .join(" ")
          .replace(/ *\n */g, "\n"),
      ),
    ],
    metadata: { format: "docx" },
    links: [],
  };
});
registerParser("pptx", async (data, name) => {
  const files = office(data);
  const keys = Object.keys(files)
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort(
      (a, b) =>
        Number(a.match(/slide(\d+)/)?.[1]) - Number(b.match(/slide(\d+)/)?.[1]),
    );
  if (keys.length > 200) throw new KnowledgeError("DOCUMENT_LIMIT");
  return {
    title: name,
    sections: keys.map((key, i) =>
      section(texts(readXML(files[key])).join(" "), i + 1, "Slide " + (i + 1)),
    ),
    metadata: { format: "pptx" },
    links: [],
  };
});
registerParser("xlsx", async (data, name) => {
  const files = office(data);
  const shared = files["xl/sharedStrings.xml"]
    ? readXML(files["xl/sharedStrings.xml"])
    : {};
  const raw = (shared.sst as Record<string, unknown>)?.si ?? [];
  const strings = (Array.isArray(raw) ? raw : [raw]).map((v) =>
    texts(v).join(""),
  );
  const keys = Object.keys(files)
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort(
      (a, b) =>
        Number(a.match(/sheet(\d+)/)?.[1]) - Number(b.match(/sheet(\d+)/)?.[1]),
    );
  if (keys.length > 100) throw new KnowledgeError("DOCUMENT_LIMIT");
  const sections = keys.map((key, i) => {
    const value = readXML(files[key]);
    const sheet = value.worksheet as Record<string, unknown>;
    const rows = (sheet?.sheetData as Record<string, unknown>)?.row ?? [];
    const lines = (Array.isArray(rows) ? rows : [rows]).map(
      (row: Record<string, unknown>) => {
        const cells = row.c ?? [];
        return (Array.isArray(cells) ? cells : [cells])
          .map((c: Record<string, unknown>) =>
            c["@_t"] === "s"
              ? (strings[Number(c.v)] ?? "")
              : c["@_t"] === "inlineStr"
                ? texts(c.is).join("")
                : String(c.v ?? ""),
          )
          .join(" | ");
      },
    );
    return section(lines.join("\n"), i + 1, "Sheet " + (i + 1), { sheet: key });
  });
  return {
    title: name,
    sections,
    metadata: { format: "xlsx", sheets: keys.length },
    links: [],
  };
});
registerParser("pdf", async (data, name, signal) => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    if (doc.numPages > 200) throw new KnowledgeError("DOCUMENT_LIMIT");
    const sections: Section[] = [];
    for (let page = 1; page <= doc.numPages; page++) {
      signal.throwIfAborted();
      const p = await doc.getPage(page);
      const content = await p.getTextContent();
      sections.push(
        section(
          content.items
            .map((item) =>
              "str" in item
                ? item.str + ("hasEOL" in item && item.hasEOL ? "\n" : " ")
                : "",
            )
            .join(""),
          page,
        ),
      );
      p.cleanup();
    }
    return {
      title: name,
      sections,
      metadata: { format: "pdf", pages: doc.numPages },
      links: [],
    };
  } finally {
    await doc.destroy();
  }
});
export async function parseDocument(
  data: Uint8Array,
  filename: string,
  signal: AbortSignal,
) {
  if (data.byteLength > 10000000) throw new KnowledgeError("UPLOAD_LIMIT");
  const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
  const parser = parsers.get(extension);
  if (!parser) throw new KnowledgeError("UNSUPPORTED_FILE_TYPE");
  signal.throwIfAborted();
  const parsed = await parser(data, filename, signal);
  let size = 0;
  for (const s of parsed.sections) {
    s.text = s.text.replace(/\u0000/g, "").trim();
    size += s.text.length;
  }
  if (size > 2000000) throw new KnowledgeError("EXTRACTED_TEXT_LIMIT");
  if (!parsed.sections.some((s) => s.text))
    throw new KnowledgeError("NO_EXTRACTABLE_TEXT");
  return parsed;
}
