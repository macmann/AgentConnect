import { z } from "zod";
export const financialArguments = z
  .object({
    operation: z.enum([
      "sum",
      "difference",
      "ratio",
      "percentage",
      "percentage_change",
    ]),
    operands: z
      .array(
        z
          .object({
            label: z
              .string()
              .trim()
              .min(1)
              .max(100)
              .describe("Financial concept and period for this operand"),
            value: z
              .string()
              .trim()
              .min(1)
              .max(50)
              .describe(
                "Exact source numeric token, including sign, parentheses and separators. Do not strip uncertainty marks or infer missing values.",
              ),
            decimalSeparator: z.enum([".", ","]).default("."),
            unit: z
              .string()
              .trim()
              .min(1)
              .max(30)
              .describe(
                "Common base currency or unit before scaling, e.g. MMK. All operands must agree.",
              ),
            scale: z
              .enum(["1", "1000", "1000000", "1000000000"])
              .default("1")
              .describe(
                "Explicit display multiplier converting the raw value to the base unit; millions means 1000000. Ask for clarification if uncertain.",
              ),
            reference: z
              .number()
              .int()
              .positive()
              .nullable()
              .default(null)
              .describe(
                "Numeric reference ID from the currently retrieved passages",
              ),
            quote: z
              .string()
              .trim()
              .max(1500)
              .default("")
              .describe(
                "Exact verbatim passage quote containing the complete numeric token and useful period/metric context",
              ),
          })
          .strict(),
      )
      .min(2)
      .max(20),
    precision: z.number().int().min(0).max(12).default(2),
  })
  .strict();
