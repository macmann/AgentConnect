import { zipSync, strToU8 } from "fflate";
const xml = (v: unknown) =>
  String(v ?? "")
    .replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[c]!,
    )
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
const column = (i: number): string =>
  i < 26
    ? String.fromCharCode(65 + i)
    : column(Math.floor(i / 26) - 1) + column(i % 26);
export function excelReport(sheets: Record<string, Record<string, unknown>[]>) {
  const files: Record<string, Uint8Array> = {},
    names = Object.keys(sheets);
  files["[Content_Types].xml"] = strToU8(
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
  );
  files["_rels/.rels"] = strToU8(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  files["xl/workbook.xml"] = strToU8(
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xml(n.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
  );
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
  );
  for (const [i, n] of names.entries()) {
    const rows = sheets[n]!,
      keys = Array.from(new Set(rows.flatMap(Object.keys))),
      data = [keys, ...rows.map((r) => keys.map((k) => r[k]))];
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => (typeof v === "number" && Number.isFinite(v) ? `<c r="${column(c)}${r + 1}"><v>${v}</v></c>` : `<c r="${column(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${xml(v instanceof Date ? v.toISOString() : typeof v === "object" && v !== null ? JSON.stringify(v) : v)}</t></is></c>`)).join("")}</row>`).join("")}</sheetData></worksheet>`,
    );
  }
  return Buffer.from(zipSync(files));
}
