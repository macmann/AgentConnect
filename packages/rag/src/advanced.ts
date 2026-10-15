import {
  type ParsedDocument,
  type Section,
  KnowledgeError,
} from "./parsers.js";
export interface LayoutBlock {
  start: number;
  end: number;
  kind: "text" | "table";
  headerRows: number;
}
export interface ProcessingReport {
  version: number;
  warnings: string[];
  tables: {
    heading: string | null;
    page: number | null;
    columns: string[];
    rowCount: number;
    preview: string;
  }[];
  llm: {
    status: string;
    calls: number;
    inputTokens: number | null;
    outputTokens: number | null;
  };
}
const numeric = (s: string) => /^[-+($€£¥]?\s*\d[\d,. %()−–-]*$/.test(s.trim());
const yearHeader = (row: string[]) =>
  (!row[0]?.trim() ||
    /^(year|period|financial year|metric|item|line item|description)$/i.test(
      row[0].trim(),
    )) &&
  row.slice(1).filter((v) => v.trim()).length > 0 &&
  row
    .slice(1)
    .filter((v) => v.trim())
    .every((v) => /^20\d{2}$/.test(v.trim()));
export const isDataRow = (row: string[]) =>
  !!row[0]?.trim() &&
  !numeric(row[0]) &&
  row.slice(1).some(numeric) &&
  !yearHeader(row);
const hasCells = (row: string[]) => row.filter((v) => v.trim()).length > 1;
/** Conservative boundaries; uncertain layouts are retained as text, never repaired by inventing values. */
export function deterministicBlocks(rows: string[][]): LayoutBlock[] {
  const blocks: LayoutBlock[] = [];
  let start = 0;
  while (start < rows.length) {
    if (!hasCells(rows[start]!)) {
      let end = start + 1;
      while (end < rows.length && !hasCells(rows[end]!)) end++;
      blocks.push({ start, end, kind: "text", headerRows: 0 });
      start = end;
      continue;
    }
    let end = start + 1;
    while (end < rows.length && hasCells(rows[end]!)) {
      // A new textual header after numeric rows starts another table.
      if (
        isDataRow(rows[end - 1]!) &&
        !rows[end]!.some(numeric) &&
        !isDataRow(rows[end]!)
      )
        break;
      end++;
    }
    let headers = rows.slice(start, end).findIndex(isDataRow);
    if (headers < 0) headers = end - start > 1 ? 1 : 0;
    if (headers > 6) {
      blocks.push({ start, end: start + headers, kind: "text", headerRows: 0 });
      start += headers;
      headers = 0;
    }
    blocks.push({ start, end, kind: "table", headerRows: headers });
    start = end;
  }
  return blocks;
}
export function validBlocks(value: unknown, rowCount: number): LayoutBlock[] {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).join() !== "blocks"
  )
    throw new KnowledgeError("INVALID_LAYOUT_RESPONSE");
  const blocks = (value as { blocks: unknown }).blocks;
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > rowCount)
    throw new KnowledgeError("INVALID_LAYOUT_RESPONSE");
  let next = 0;
  for (const b of blocks) {
    if (
      !b ||
      typeof b !== "object" ||
      Object.keys(b).sort().join() !== "end,headerRows,kind,start" ||
      !Number.isInteger(b.start) ||
      b.start !== next ||
      !Number.isInteger(b.end) ||
      b.end <= b.start ||
      b.end > rowCount ||
      !["table", "text"].includes(b.kind) ||
      !Number.isInteger(b.headerRows) ||
      b.headerRows < 0 ||
      b.headerRows > 6 ||
      b.headerRows >= b.end - b.start ||
      (b.kind === "text" && b.headerRows !== 0)
    )
      throw new KnowledgeError("INVALID_LAYOUT_RESPONSE");
    next = b.end;
  }
  if (next !== rowCount) throw new KnowledgeError("INVALID_LAYOUT_RESPONSE");
  return blocks as LayoutBlock[];
}
function columnsFor(headers: string[][], width: number) {
  const expanded = headers.map((row) => {
    let last = "";
    return Array.from({ length: width }, (_, i) => {
      const v = row[i]?.trim() ?? "";
      if (v) last = v;
      // Never carry a last value beyond the supplied row width.
      return v || (i < row.length ? last : "");
    });
  });
  return Array.from({ length: width }, (_, col) => {
    const parts = [...new Set(expanded.map((row) => row[col]).filter(Boolean))];
    return parts.join(" / ") || (col === 0 ? "Line item" : `Column ${col + 1}`);
  });
}
export async function structureDocument(
  document: ParsedDocument,
  choose?: (rows: string[][]) => Promise<LayoutBlock[] | null>,
): Promise<{ document: ParsedDocument; report: ProcessingReport }> {
  const report: ProcessingReport = {
    version: 1,
    warnings: [],
    tables: [],
    llm: {
      status: choose ? "pending" : "disabled",
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
  };
  if (document.metadata.format === "xlsx")
    report.warnings.push(
      "Spreadsheet display formats are not reconstructed and formulas are not recalculated; verify cached values, percentages and units.",
    );
  const sections: Section[] = [];
  let previousTable: Section | undefined;
  for (const original of document.sections) {
    const raw = original.metadata.rawRows;
    const rows: string[][] = Array.isArray(raw)
      ? raw.map((row) => (Array.isArray(row) ? row.map(String) : [String(row)]))
      : original.text.split("\n").map((line) => [line]);
    if (!rows.length || (!original.text.trim() && !Array.isArray(raw)))
      continue;
    let blocks = deterministicBlocks(rows);
    if (original.metadata.layoutBlocks) {
      blocks = validBlocks(
        { blocks: original.metadata.layoutBlocks },
        rows.length,
      );
    } else if (choose) {
      const selected = await choose(rows);
      if (selected) blocks = validBlocks({ blocks: selected }, rows.length);
      else
        report.warnings.push(
          "LLM assistance skipped or rejected; deterministic boundaries were used.",
        );
    }
    const cleanMetadata = { ...original.metadata };
    delete cleanMetadata.rawRows;
    let context = String(
      original.metadata.sourceContext ?? original.heading ?? "",
    );
    for (const b of blocks) {
      const selected = rows.slice(b.start, b.end);
      if (b.kind === "text") {
        const text = selected.map((row) => row.join(" | ")).join("\n");
        if (text.trim()) {
          sections.push({
            ...original,
            text,
            metadata: {
              ...cleanMetadata,
              table: false,
              columns: undefined,
              advanced: true,
            },
          });
          context = text.slice(-1000);
        }
        continue;
      }
      const width = Math.max(...selected.map((row) => row.length));
      const continued =
        b.headerRows === 0 &&
        original.page !== null &&
        previousTable?.page === original.page - 1 &&
        (previousTable.metadata.columns as string[] | undefined)?.length ===
          width;
      const columns = continued
        ? (previousTable!.metadata.columns as string[])
        : columnsFor(selected.slice(0, b.headerRows), width);
      const data = selected.slice(b.headerRows);
      const headerText = selected
        .slice(0, b.headerRows)
        .map((row) => row.join(" | "))
        .join("\n");
      const prefix = [
        document.title,
        original.heading,
        context,
        continued
          ? "Continued table from previous page; verify alignment."
          : "",
        headerText,
        original.metadata.footnotes ? String(original.metadata.footnotes) : "",
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 2500);
      const content = data
        .map(
          (row, i) =>
            `Row ${b.start + b.headerRows + i + 1}: ` +
            Array.from(
              { length: Math.max(columns.length, row.length) },
              (_, col) =>
                `${columns[col] ?? `Column ${col + 1}`}: ${row[col] ?? ""}`,
            ).join(" | "),
        )
        .join("\n");
      const warnings = [
        ...(b.headerRows === 0 && !continued
          ? [
              "Table header could not be identified; generic column labels were retained.",
            ]
          : []),
        ...(new Set(selected.map((row) => row.length)).size > 1
          ? ["Uneven table rows detected; verify column alignment."]
          : []),
        ...(original.metadata.layoutHeuristic
          ? [
              "Layout inferred from document structure; verify headers, units and values.",
            ]
          : []),
        ...(continued
          ? ["Possible continued table; verify the inherited headers."]
          : []),
      ];
      report.warnings.push(...warnings);
      const heading =
        original.heading ||
        context.split("\n").find((line) => line.trim()) ||
        `Table ${report.tables.length + 1}`;
      const table: Section = {
        text: content,
        page: original.page,
        heading: heading.slice(0, 300),
        metadata: {
          ...cleanMetadata,
          table: true,
          columns,
          context: prefix,
          advanced: true,
          warnings,
        },
      };
      sections.push(table);
      previousTable = table;
      if (report.tables.length < 100)
        report.tables.push({
          heading: table.heading,
          page: table.page,
          columns,
          rowCount: data.length,
          preview: (prefix + "\n" + content).slice(0, 6000),
        });
    }
  }
  report.warnings = [...new Set(report.warnings)];
  return { document: { ...document, sections }, report };
}
