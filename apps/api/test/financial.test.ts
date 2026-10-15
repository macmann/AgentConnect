import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateFinancial,
  financialNumber,
} from "../src/financial-calculator.js";
const operand = (value: string, extra = {}) => ({
  label: "Value",
  value,
  unit: "MMK",
  ...extra,
});
const calc = (operation: string, values: string[], extra = {}) =>
  calculateFinancial(
    { operation, operands: values.map((v) => operand(v)), ...extra },
    false,
  );
test("Financial arithmetic uses exact decimals, explicit rounding and no binary float errors", () => {
  assert.equal(calc("sum", ["0.1", "0.2"]).result, "0.30");
  assert.equal(
    calc("difference", ["9007199254740993", "1"]).result,
    "9007199254740992.00",
  );
  assert.equal(calc("ratio", ["2", "3"]).result, "0.67");
  assert.equal(calc("sum", ["-1.005", "0"]).result, "-1.01");
  assert.equal(calc("sum", ["1.005", "0"]).result, "1.01");
  assert.equal(calc("percentage", ["25", "200"]).result, "12.50");
  assert.equal(calc("percentage_change", ["1250", "1000"]).result, "25.00");
  assert.equal(calc("percentage_change", ["-80", "-100"]).result, "20.00");
});
test("Financial parsing handles multilingual digits, grouped decimals and accounting negatives explicitly", () => {
  assert.equal(financialNumber("(1,250.25)"), -1250250000000000n);
  assert.equal(financialNumber("၁,၂၅၀.၂၅"), 1250250000000000n);
  assert.equal(financialNumber("١٢.٥"), 12500000000000n);
  assert.equal(financialNumber("1.250,25", ","), 1250250000000000n);
  for (const s of [
    "1,25",
    "1.2.3",
    "—",
    "N/A",
    "1e6",
    "$10",
    "10%",
    "[uncertain]",
    "1,000,00",
    "(−10)",
    "",
    "1.",
  ])
    assert.throws(() => financialNumber(s), /FINANCIAL_NUMBER_INVALID/);
});
test("Financial calculations reject zero denominators, incompatible units and invalid operands", () => {
  assert.throws(() => calc("ratio", ["1", "0"]), /FINANCIAL_DIVISION_BY_ZERO/);
  assert.throws(
    () => calc("percentage_change", ["1", "0"]),
    /FINANCIAL_DIVISION_BY_ZERO/,
  );
  assert.throws(
    () => calc("difference", ["1", "2", "3"]),
    /FINANCIAL_OPERAND_COUNT/,
  );
  assert.throws(
    () =>
      calculateFinancial(
        {
          operation: "sum",
          operands: [operand("1"), operand("2", { unit: "USD" })],
        },
        false,
      ),
    /FINANCIAL_UNIT_MISMATCH/,
  );
  assert.throws(
    () => calc("sum", ["1", "2"], { precision: 13 }),
    /FINANCIAL_ARGUMENTS_INVALID/,
  );
});
const source = {
  id: 1,
  sourceId: "source",
  chunkId: "chunk",
  documentId: "document",
  title: "Financial statement",
  page: 2,
  content: "MMK millions: 2026 revenue 1,250.00; 2025 revenue 1,000.00.",
};
test("Grounded calculator requires exact authorized quote and whole numeric token, retaining source provenance", () => {
  const operands = [
    operand("1,250.00", {
      reference: 1,
      quote: "2026 revenue 1,250.00",
      scale: "1000000",
    }),
    operand("1,000.00", {
      reference: 1,
      quote: "2025 revenue 1,000.00",
      scale: "1000000",
    }),
  ];
  const result = calculateFinancial(
    { operation: "difference", operands },
    true,
    [source],
  );
  assert.equal(result.result, "250000000.00");
  assert.equal(result.operands[0]!.provenance?.page, 2);
  assert.equal(result.operands[0]!.provenance?.sourceId, "source");
  assert.equal(result.operands[0]!.normalized, "1250000000");
  assert.throws(
    () => calculateFinancial({ operation: "sum", operands }, true, []),
    /FINANCIAL_EVIDENCE_REQUIRED/,
  );
  for (const patch of [
    { value: "250.00" },
    { quote: "invented 1,250.00" },
    { reference: 2 },
    { quote: "" },
  ])
    assert.throws(
      () =>
        calculateFinancial(
          {
            operation: "sum",
            operands: [{ ...operands[0], ...patch }, operands[1]],
          },
          true,
          [source],
        ),
      /FINANCIAL_EVIDENCE_REQUIRED/,
    );
  assert.throws(
    () =>
      calculateFinancial(
        { operation: "sum", operands: [operand("1"), operand("2")] },
        true,
        [source],
      ),
    /FINANCIAL_EVIDENCE_REQUIRED/,
  );
});

test("Evidence cannot flip a negative number to positive by quoting only its magnitude", () => {
  for (const number of ["-900", "−900", "(900)"]) {
    const evidence = { ...source, content: `Loss ${number}; Revenue 1000` };
    assert.throws(
      () =>
        calculateFinancial(
          {
            operation: "sum",
            operands: [
              operand("900", { reference: 1, quote: `Loss ${number}` }),
              operand("1000", { reference: 1, quote: "Revenue 1000" }),
            ],
          },
          true,
          [evidence],
        ),
      /FINANCIAL_EVIDENCE_REQUIRED/,
    );
  }
});

test("Uncertain extracted figures cannot be silently promoted into verified calculations", () => {
  const evidence = { ...source, content: "Revenue [uncertain] 100; Cost 50" };
  assert.throws(
    () =>
      calculateFinancial(
        {
          operation: "difference",
          operands: [
            operand("100", { reference: 1, quote: "Revenue [uncertain] 100" }),
            operand("50", { reference: 1, quote: "Cost 50" }),
          ],
        },
        true,
        [evidence],
      ),
    /FINANCIAL_UNCERTAIN_VALUE/,
  );
});
