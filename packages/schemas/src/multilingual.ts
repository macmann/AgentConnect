import { z } from "zod";
export const languageTag = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .refine((value) => {
    try {
      new Intl.Locale(value);
      return true;
    } catch {
      return false;
    }
  }, "Use a BCP 47 language tag, such as en, th or my");
export const scripts = [
  "Latin",
  "Myanmar",
  "Thai",
  "Arabic",
  "Han",
  "Cyrillic",
  "Devanagari",
  "Hebrew",
  "Hangul",
  "Hiragana",
  "Katakana",
] as const;
export const multilingualCheck = z
  .object({
    intent: z.string().trim().min(1).max(100),
    queryLanguage: languageTag,
    sourceLanguage: languageTag,
    expectedAnswerLanguage: languageTag,
    expectedScripts: z.array(z.enum(scripts)).max(6).default([]),
    requireSourceCitations: z.boolean().default(true),
    minScriptRatio: z.number().min(0.1).max(1).default(0.6),
  })
  .strict();
