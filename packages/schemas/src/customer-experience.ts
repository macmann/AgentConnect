import { z } from "zod";
export const branding = z
  .object({
    name: z.string().trim().max(100).default(""),
    welcomeMessage: z.string().max(1000).default(""),
    logoUrl: z
      .string()
      .max(1000)
      .default("")
      .refine(
        (v) =>
          !v ||
          (() => {
            try {
              const u = new URL(v);
              return u.protocol === "https:" && !u.username && !u.password;
            } catch {
              return false;
            }
          })(),
        "Use an HTTPS logo URL without credentials",
      ),
    primaryColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#6d43cc"),
    backgroundColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#ffffff"),
    textColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default("#182033"),
  })
  .strict();
export type Branding = z.infer<typeof branding>;
export const contextControls = z
  .object({
    enabled: z.boolean().default(false),
    tokenizer: z
      .enum(["o200k_base", "cl100k_base", "conservative"])
      .default("o200k_base"),
    inputBudget: z
      .number()
      .int()
      .min(128)
      .max(2000000)
      .nullable()
      .default(null),
    historyBudget: z.number().int().min(64).max(1000000).default(4096),
    knowledgeBudget: z.number().int().min(64).max(1000000).default(4096),
    summarize: z.boolean().default(false),
    summaryMaxTokens: z.number().int().min(64).max(2048).default(512),
    dailyTokenQuota: z
      .number()
      .int()
      .min(256)
      .max(100000000)
      .nullable()
      .default(null),
  })
  .default({
    enabled: false,
    tokenizer: "o200k_base",
    inputBudget: null,
    historyBudget: 4096,
    knowledgeBudget: 4096,
    summarize: false,
    summaryMaxTokens: 512,
    dailyTokenQuota: null,
  });
export const reportRange = z
  .object({
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    days: z.coerce.number().int().min(1).max(366).default(30),
  })
  .superRefine((v, c) => {
    if (!!v.from !== !!v.to)
      c.addIssue({ code: "custom", message: "Provide both from and to" });
    if (
      v.from &&
      v.to &&
      (Date.parse(v.to) <= Date.parse(v.from) ||
        Date.parse(v.to) - Date.parse(v.from) > 366 * 86400000)
    )
      c.addIssue({
        code: "custom",
        message: "Choose an increasing date range of up to 366 days",
      });
  });
