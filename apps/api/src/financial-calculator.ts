import { z } from "zod";
import { financialArguments } from "@agentconnect/schemas/financial";
import type { Citation } from "@agentconnect/rag/tool";
import { ToolError } from "./tool-errors.js";
const fail = (code: string): never => {
  throw new ToolError(code);
};
const ascii = (s: string) =>
  s
    .replace(/[၀-၉٠-٩۰-۹]/g, (c) =>
      String(
        c.charCodeAt(0) -
          (c >= "၀" && c <= "၉"
            ? 0x1040
            : c >= "٠" && c <= "٩"
              ? 0x660
              : 0x6f0),
      ),
    )
    .replaceAll("−", "-");
const BASE = 10n ** 12n;
/** Strict grouping and explicit decimal convention; no currency/percent stripping or guesses. */
export function financialNumber(
  raw: string,
  decimalSeparator: "." | "," = ".",
) {
  let value = ascii(raw.trim());
  let negative = false;
  if (/^\(.+\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1);
  } else if (value.startsWith("-")) {
    negative = true;
    value = value.slice(1);
  } else if (value.startsWith("+")) value = value.slice(1);
  const group = decimalSeparator === "." ? "," : ".";
  const pieces = value.split(decimalSeparator);
  if (pieces.length > 2) fail("FINANCIAL_NUMBER_INVALID");
  const whole = pieces[0]!,
    fraction = pieces[1] ?? "";
  const validGrouped = new RegExp(`^\\d{1,3}(?:\\${group}\\d{3})+$`);
  if (
    !(/^\d+$/.test(whole) || validGrouped.test(whole)) ||
    !/^[0-9]{0,12}$/.test(fraction) ||
    (pieces.length === 2 && !fraction) ||
    whole.replaceAll(group, "").length > 24
  )
    fail("FINANCIAL_NUMBER_INVALID");
  const n =
    BigInt(whole.replaceAll(group, "")) * BASE +
    BigInt(fraction.padEnd(12, "0"));
  return negative ? -n : n;
}
function render(n: bigint, d: bigint, precision: number) {
  if (d === 0n) fail("FINANCIAL_DIVISION_BY_ZERO");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const negative = n < 0n,
    abs = negative ? -n : n,
    factor = 10n ** BigInt(precision);
  const scaled = abs * factor;
  let rounded = scaled / d;
  if ((scaled % d) * 2n >= d) rounded++;
  const text = rounded.toString().padStart(precision + 1, "0");
  return (
    (negative && rounded !== 0n ? "-" : "") +
    (precision
      ? text.slice(0, -precision) + "." + text.slice(-precision)
      : text)
  );
}
export function calculateFinancial(
  input: unknown,
  requireEvidence = true,
  sources: Pick<
    Citation,
    "id" | "sourceId" | "chunkId" | "documentId" | "title" | "page" | "content"
  >[] = [],
) {
  const parsed = financialArguments.safeParse(input);
  if (!parsed.success) fail("FINANCIAL_ARGUMENTS_INVALID");
  const args = parsed.data!;
  if (args.operation !== "sum" && args.operands.length !== 2)
    fail("FINANCIAL_OPERAND_COUNT");
  const unit = args.operands[0]!.unit;
  if (args.operands.some((o) => o.unit !== unit))
    fail("FINANCIAL_UNIT_MISMATCH");
  const operands = args.operands.map((o) => {
    const value = financialNumber(o.value, o.decimalSeparator);
    const source =
      o.reference === null
        ? undefined
        : sources.find((s) => s.id === o.reference);
    if (o.reference !== null || requireEvidence) {
      if (/\[uncertain\]/i.test(o.quote)) fail("FINANCIAL_UNCERTAIN_VALUE");
      // The exact quote must come from an authorized retrieved passage, and contain the whole numeric token.
      const escaped = o.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (
        !source ||
        !o.quote ||
        !source.content.includes(o.quote) ||
        !new RegExp(
          `(?<![\\p{N}.,+()−-])${escaped}(?![\\p{N}.,+()−-])`,
          "u",
        ).test(o.quote)
      )
        fail("FINANCIAL_EVIDENCE_REQUIRED");
    }
    return {
      ...o,
      canonical: render(value, BASE, 12).replace(/\.?0+$/, ""),
      normalized: render(value * BigInt(o.scale), BASE, 12).replace(
        /\.?0+$/,
        "",
      ),
      n: value * BigInt(o.scale),
      provenance: source
        ? {
            reference: source.id,
            sourceId: source.sourceId,
            chunkId: source.chunkId,
            documentId: source.documentId,
            title: source.title,
            page: source.page,
            quote: o.quote,
          }
        : null,
    };
  });
  const a = operands[0]!.n,
    b = operands[1]!.n;
  let n: bigint, d: bigint, formula: string;
  switch (args.operation) {
    case "sum":
      n = operands.reduce((sum, o) => sum + o.n, 0n);
      d = BASE;
      formula = "sum(scaled operands)";
      break;
    case "difference":
      n = a - b;
      d = BASE;
      formula = "first - second";
      break;
    case "ratio":
      n = a;
      d = b;
      formula = "first / second";
      break;
    case "percentage":
      n = a * 100n;
      d = b;
      formula = "first / second × 100";
      break;
    case "percentage_change":
      n = (a - b) * 100n;
      d = b < 0n ? -b : b;
      formula = "(current - previous) / abs(previous) × 100";
      break;
  }
  const result = render(n, d, args.precision);
  return {
    operation: args.operation,
    formula,
    result,
    unit: ["percentage", "percentage_change"].includes(args.operation)
      ? "%"
      : args.operation === "ratio"
        ? "ratio"
        : unit,
    precision: args.precision,
    rounding: "half away from zero",
    operands: operands.map((operand) => {
      const { n, ...rest } = operand;
      void n;
      return rest;
    }),
    warning:
      "Verify selected periods, currency, units and scale against the source. No currency conversion or missing-value inference is performed.",
  };
}
export const financialInputSchema = z.toJSONSchema(financialArguments, {
  io: "input",
  target: "draft-7",
}) as Record<string, unknown>;
