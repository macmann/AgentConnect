import { test } from "node:test";
import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import {
  parseDocument,
  parseHTML,
  type ParsedDocument,
} from "@agentconnect/rag/parsers";
import { structureDocument, validBlocks } from "@agentconnect/rag/advanced";
import { advancedChunks, tokenPieces } from "../src/knowledge-processing.js";
import { tokenCount } from "../src/context-control.js";
import {
  knowledgeInput,
  advancedProcessing,
} from "@agentconnect/schemas/knowledge";
import { randomUUID } from "node:crypto";
const signal = () => AbortSignal.timeout(5000);
const html =
  '<main><p>Amounts in USD thousands</p><table><caption>Financial statement</caption><tr><th rowspan="2">Metric</th><th colspan="2">Group</th><th colspan="2">Company</th></tr><tr><th>2026</th><th>2025</th><th>2026</th><th>2025</th></tr><tr><td>Revenue</td><td>125,000</td><td>110,000</td><td>80,000</td><td>72,000</td></tr><tr><td>Net income</td><td>(5,000)</td><td>3,000</td><td>1,000</td><td>2,000</td></tr></table></main>';
test("Advanced processing defaults off and requires an explicit model only for enabled LLM assistance", () => {
  const input = knowledgeInput.parse({
    name: "FAQ",
    embeddingModelId: randomUUID(),
  });
  assert.equal(input.advancedProcessing.enabled, false);
  assert.equal(input.parentContext, false);
  assert.equal(
    advancedProcessing.safeParse({ enabled: true, llmAssisted: true }).success,
    false,
  );
  assert.equal(
    advancedProcessing.safeParse({ enabled: false, llmAssisted: true }).success,
    true,
  );
  assert.equal(advancedProcessing.safeParse({ chunkTokens: 1 }).success, false);
});
test("HTML grouped headers retain entity/year identity and exact financial values", async () => {
  const plain = parseHTML(strToU8(html), "Annual report");
  assert.equal(plain.sections.length, 1);
  assert.equal(plain.sections[0]!.metadata.rawRows, undefined);
  const result = await structureDocument(
    parseHTML(strToU8(html), "Annual report", { advanced: true }),
  );
  assert.equal(result.report.tables.length, 1);
  assert.deepEqual(result.report.tables[0]!.columns, [
    "Metric",
    "Group / 2026",
    "Group / 2025",
    "Company / 2026",
    "Company / 2025",
  ]);
  const table = result.document.sections.find((s) => s.metadata.table)!;
  assert.match(table.text, /Group \/ 2026: 125,000/);
  assert.match(table.text, /Company \/ 2025: 72,000/);
  assert.match(table.text, /Group \/ 2026: \(5,000\)/);
  assert.match(String(table.metadata.context), /Amounts in USD thousands/);
});
test("Multiple tables in one Excel sheet preserve blank rows and expand grouped merged headers", async () => {
  const file = zipSync({
    "xl/worksheets/sheet1.xml": strToU8(
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Metric</t></is></c><c r="B1" t="inlineStr"><is><t>Group</t></is></c></row><row r="2"><c r="B2"><v>2026</v></c><c r="C2"><v>2025</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Revenue</t></is></c><c r="B3"><v>125000</v></c><c r="C3"><v>110000</v></c></row><row r="6"><c r="A6" t="inlineStr"><is><t>Cash flow</t></is></c></row><row r="7"><c r="A7" t="inlineStr"><is><t>Metric</t></is></c><c r="B7"><v>2026</v></c></row><row r="8"><c r="A8" t="inlineStr"><is><t>Operating cash</t></is></c><c r="B8"><v>4000</v></c></row></sheetData><mergeCells><mergeCell ref="B1:C1"/></mergeCells></worksheet>',
    ),
  });
  const result = await structureDocument(
    await parseDocument(file, "financial.xlsx", signal(), { advanced: true }),
  );
  assert.equal(result.report.tables.length, 2);
  assert.match(
    result.document.sections.map((s) => s.text).join("\n"),
    /Group \/ 2026: 125000/,
  );
  assert.match(
    result.document.sections.map((s) => s.text).join("\n"),
    /2026: 4000/,
  );
});
test("Layout plans reject omitted, duplicated, overlapping, invented and excessive header boundaries", () => {
  for (const value of [
    { blocks: [{ start: 1, end: 2, kind: "text", headerRows: 0 }] },
    { blocks: [{ start: 0, end: 1, kind: "text", headerRows: 0 }] },
    { blocks: [{ start: 0, end: 2, kind: "table", headerRows: 2 }] },
    { blocks: [{ start: 0, end: 2, kind: "text", headerRows: 1 }] },
    { blocks: [{ start: 0, end: 3, kind: "table", headerRows: 1 }] },
    {
      blocks: [
        { start: 0, end: 2, kind: "text", headerRows: 0, content: "invented" },
      ],
    },
  ])
    assert.throws(() => validBlocks(value, 2));
  assert.equal(
    validBlocks(
      { blocks: [{ start: 0, end: 2, kind: "table", headerRows: 1 }] },
      2,
    ).length,
    1,
  );
});
test("Token chunking preserves Unicode, numbers and all original text with bounded narrative contexts", () => {
  const text = "Revenue €125,000. 中文财务报告 😀. ".repeat(200);
  const pieces = tokenPieces(text, 100);
  assert.equal(pieces.join(""), text);
  assert.ok(pieces.every((p) => tokenCount(p, "o200k_base") <= 100));
  const doc: ParsedDocument = {
    title: "Report",
    metadata: {},
    links: [],
    sections: [{ text, page: 7, heading: "Results", metadata: {} }],
  };
  const chunks = advancedChunks(doc, 100);
  assert.equal(chunks.map((c) => c.content).join(""), text);
  assert.ok(
    chunks.every(
      (c) =>
        String(c.metadata.parentContent).includes(c.content) && c.page === 7,
    ),
  );
  assert.ok(
    chunks.some(
      (c) => String(c.metadata.parentContent).length > c.content.length,
    ),
  );
  assert.ok(
    chunks.every(
      (c) => tokenCount(String(c.metadata.parentContent), "o200k_base") <= 1500,
    ),
  );
});
test("Wide table rows stay intact and ambiguous headers produce extraction warnings", async () => {
  const result = await structureDocument(
    parseHTML(strToU8(html), "Report", { advanced: true }),
  );
  const chunks = advancedChunks(result.document, 100, []);
  assert.ok(
    chunks.some(
      (c) =>
        c.content.includes("Revenue") &&
        c.content.includes("125,000") &&
        c.content.includes("72,000"),
    ),
  );
  assert.ok(
    chunks
      .filter((c) => c.content.includes("Revenue"))
      .every((c) => c.content.includes("USD thousands")),
  );
  assert.ok(result.report.warnings.length);
  const ambiguous: ParsedDocument = {
    title: "Numbers",
    metadata: {},
    links: [],
    sections: [
      {
        text: "Revenue | 125000",
        page: 1,
        heading: null,
        metadata: { rawRows: [["Revenue", "125000"]] },
      },
    ],
  };
  const retained = await structureDocument(ambiguous);
  assert.match(retained.document.sections[0]!.text, /125000/);
  assert.ok(retained.report.warnings.some((w) => w.includes("header")));
});

test("PDF coordinate extraction separates table columns and preserves page provenance", async () => {
  const content =
    "BT /F1 12 Tf 1 0 0 1 40 260 Tm (Amounts in USD thousands) Tj 1 0 0 1 40 230 Tm (Metric) Tj 1 0 0 1 180 230 Tm (2026) Tj 1 0 0 1 300 230 Tm (2025) Tj 1 0 0 1 40 200 Tm (Revenue) Tj 1 0 0 1 180 200 Tm (125000) Tj 1 0 0 1 300 200 Tm (110000) Tj ET";
  const parts = ["%PDF-1.4\n"],
    offsets: number[] = [];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  objects.forEach((o, i) => {
    offsets.push(parts.join("").length);
    parts.push(`${i + 1} 0 obj\n${o}\nendobj\n`);
  });
  const xref = parts.join("").length;
  parts.push(
    "xref\n0 6\n0000000000 65535 f \n" +
      offsets.map((n) => String(n).padStart(10, "0") + " 00000 n \n").join("") +
      `trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`,
  );
  const doc = await parseDocument(
    strToU8(parts.join("")),
    "financial.pdf",
    signal(),
    { advanced: true },
  );
  const result = await structureDocument(doc);
  assert.equal(result.report.tables.length, 1);
  assert.equal(result.report.tables[0]!.page, 1);
  const table = result.document.sections.find((s) => s.metadata.table)!;
  assert.match(table.text, /2026: 125000/);
  assert.match(table.text, /2025: 110000/);
  assert.match(String(table.metadata.context), /USD thousands/);
});
test("Word table grid spans preserve grouped headers and separate tables", async () => {
  const cell = (value: string, span = 1) =>
    `<w:tc><w:tcPr><w:gridSpan w:val="${span}"/></w:tcPr><w:p><w:r><w:t>${value}</w:t></w:r></w:p></w:tc>`;
  const row = (cells: string[]) => `<w:tr>${cells.join("")}</w:tr>`;
  const table =
    "<w:tbl>" +
    row([cell("Metric"), cell("Group", 2)]) +
    row([cell(""), cell("2026"), cell("2025")]) +
    row([cell("Revenue"), cell("125000"), cell("110000")]) +
    "</w:tbl>";
  const doc = await parseDocument(
    zipSync({
      "word/document.xml": strToU8(
        `<w:document xmlns:w="fixture"><w:body>${table}${table}</w:body></w:document>`,
      ),
    }),
    "financial.docx",
    signal(),
    { advanced: true },
  );
  const result = await structureDocument(doc);
  assert.equal(result.report.tables.length, 2);
  assert.match(
    result.document.sections.map((s) => s.text).join("\n"),
    /Group \/ 2026: 125000/,
  );
});
