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
  options?: ParseOptions,
) => Promise<ParsedDocument>;
export interface ParseOptions {
  ocr?: (
    data: Uint8Array,
    page: number,
    signal: AbortSignal,
  ) => Promise<string>;
  maxOcrPages?: number;
}
const section = (
  text: string,
  page: number | null = null,
  heading: string | null = null,
  metadata: Record<string, unknown> = {},
): Section => ({ text, page, heading, metadata });
/** Keep column identities with every row, including empty values and sparse cells. */
export function tableSection(
  rows: string[][],
  page: number | null = null,
  heading: string | null = null,
): Section {
  const headers =
    rows[0]?.map((value, i) => value.trim() || `Column ${i + 1}`) ?? [];
  const content = rows.slice(1).map((row, i) => {
    const columns = Array.from(
      { length: Math.max(headers.length, row.length) },
      (_, col) => `${headers[col] ?? `Column ${col + 1}`}: ${row[col] ?? ""}`,
    );
    return `Row ${i + 2}: ` + columns.join(" | ");
  });
  return section(
    content.length ? content.join("\n") : headers.join(" | "),
    page,
    heading,
    { table: true, columns: headers },
  );
}
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
  const links = $("a[href]")
    .map((_, a) => $(a).attr("href")!)
    .get()
    .slice(0, 500);
  $("script,style,noscript,iframe,object,svg,nav,footer").remove();
  const canonical = $('link[rel="canonical"]').attr("href");
  const label = ($("title").first().text().trim() || title).slice(0, 200);
  const container = $("main").first().length ? $("main").first() : $("body");
  container.find("table").each((_, table) => {
    const rows = $(table)
      .find("tr")
      .map((_, row) => [
        $(row)
          .find("th,td")
          .map((_, cell) => $(cell).text().trim())
          .get(),
      ])
      .get() as unknown as string[][];
    $(table).replaceWith(
      $("<pre></pre>").text("\n" + tableSection(rows).text + "\n"),
    );
  });
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
    sections: [tableSection(rows)],
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
        return /\.(xml|rels)$/.test(entry.name);
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
  const body = (doc.document as Record<string, unknown>)?.body as
    Record<string, unknown> | undefined;
  const tables = body?.tbl
    ? Array.isArray(body.tbl)
      ? body.tbl
      : [body.tbl]
    : [];
  const tableSections = tables.map((table, i) => {
    const raw = (table as Record<string, unknown>).tr ?? [];
    const rows = (Array.isArray(raw) ? raw : [raw]).map((row) => {
      const cells = (row as Record<string, unknown>).tc ?? [];
      return (Array.isArray(cells) ? cells : [cells]).map((cell) =>
        texts(cell)
          .filter((t) => t !== "\n")
          .join(" "),
      );
    });
    return tableSection(rows, null, `Table ${i + 1}`);
  });
  return {
    title: name,
    sections: [
      section(
        texts(body ? { ...body, tbl: undefined } : doc)
          .join(" ")
          .replace(/ *\n */g, "\n"),
      ),
      ...tableSections,
    ],
    metadata: { format: "docx", tables: tableSections.length },
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
  const workbook = files["xl/workbook.xml"]
    ? readXML(files["xl/workbook.xml"])
    : {};
  const rawSheets =
    (
      (workbook.workbook as Record<string, unknown>)?.sheets as Record<
        string,
        unknown
      >
    )?.sheet ?? [];
  const relationships = files["xl/_rels/workbook.xml.rels"]
    ? readXML(files["xl/_rels/workbook.xml.rels"])
    : {};
  const rawRelationships =
    (relationships.Relationships as Record<string, unknown>)?.Relationship ??
    [];
  const targets = new Map(
    (Array.isArray(rawRelationships)
      ? rawRelationships
      : [rawRelationships]
    ).map((r) => {
      const rel = r as Record<string, unknown>;
      return [
        String(rel["@_Id"] ?? ""),
        String(rel["@_Target"] ?? "")
          .replace(/^\/xl\//, "")
          .replace(/^\.\//, ""),
      ];
    }),
  );
  const sheetNames = new Map(
    (Array.isArray(rawSheets) ? rawSheets : [rawSheets]).map((v) => {
      const sheet = v as Record<string, unknown>;
      return [
        "xl/" + targets.get(String(sheet["@_id"] ?? "")),
        String(sheet["@_name"] ?? ""),
      ];
    }),
  );
  const sections = keys.map((key, i) => {
    const value = readXML(files[key]);
    const sheet = value.worksheet as Record<string, unknown>;
    const rows = (sheet?.sheetData as Record<string, unknown>)?.row ?? [];
    const parsedRows = (Array.isArray(rows) ? rows : [rows]).map(
      (row: Record<string, unknown>) => {
        const cells = row.c ?? [];
        const values: string[] = [];
        for (const c of (Array.isArray(cells) ? cells : [cells]) as Record<
          string,
          unknown
        >[]) {
          const reference = String(c["@_r"] ?? "").match(/^[A-Z]+/)?.[0];
          const col = reference
            ? [...reference].reduce(
                (n, letter) => n * 26 + letter.charCodeAt(0) - 64,
                0,
              ) - 1
            : values.length;
          if (col > 1000) throw new KnowledgeError("DOCUMENT_LIMIT");
          while (values.length < col) values.push("");
          values[col] =
            c["@_t"] === "s"
              ? (strings[Number(c.v)] ?? "")
              : c["@_t"] === "inlineStr"
                ? texts(c.is).join("")
                : String(c.v ?? "");
        }
        return values;
      },
    );
    return {
      ...tableSection(
        parsedRows,
        i + 1,
        sheetNames.get(key) || "Sheet " + (i + 1),
      ),
      metadata: { table: true, columns: parsedRows[0] ?? [], sheet: key },
    };
  });
  return {
    title: name,
    sections,
    metadata: { format: "xlsx", sheets: keys.length },
    links: [],
  };
});
registerParser("pdf", async (data, name, signal, options) => {
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
    let ocrPages = 0,
      unrecognizedPages = 0;
    for (let page = 1; page <= doc.numPages; page++) {
      signal.throwIfAborted();
      const p = await doc.getPage(page);
      const content = await p.getTextContent();
      let previous: { x: number; y: number; width: number } | null = null;
      let text = content.items
        .map((item) => {
          if (!("str" in item)) return "";
          const x = item.transform[4]!,
            y = item.transform[5]!;
          const gap =
            previous &&
            Math.abs(y - previous.y) < 3 &&
            x - previous.x - previous.width > 12
              ? " | "
              : " ";
          const line = previous && Math.abs(y - previous.y) >= 3 ? "\n" : gap;
          previous = item.hasEOL ? null : { x, y, width: item.width };
          return line + item.str + (item.hasEOL ? "\n" : "");
        })
        .join("");
      let ocr = false;
      if (text.replace(/\s/g, "").length < 20 && options?.ocr) {
        if (++ocrPages > (options.maxOcrPages ?? 20))
          throw new KnowledgeError("OCR_PAGE_LIMIT");
        text = await options.ocr(data, page, signal);
        ocr = true;
      }
      if (!ocr && text.replace(/\s/g, "").length < 20) unrecognizedPages++;
      sections.push(section(text, page, null, { ocr, positionalText: !ocr }));
      p.cleanup();
    }
    return {
      title: name,
      sections,
      metadata: {
        format: "pdf",
        pages: doc.numPages,
        ocrPages,
        unrecognizedPages,
      },
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
  options: ParseOptions = {},
) {
  if (data.byteLength > 10000000) throw new KnowledgeError("UPLOAD_LIMIT");
  const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
  const parser = parsers.get(extension);
  if (!parser) throw new KnowledgeError("UNSUPPORTED_FILE_TYPE");
  signal.throwIfAborted();
  const parsed = await parser(data, filename, signal, options);
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
