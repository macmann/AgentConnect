import { z } from "zod";
export const reviewInput = z
  .object({
    rating: z.enum(["like", "dislike"]).nullable().default(null),
    label: z
      .enum([
        "correct",
        "incorrect",
        "incomplete",
        "hallucination",
        "retrieval_issue",
        "tool_issue",
        "policy_issue",
      ])
      .nullable()
      .default(null),
    comment: z.string().trim().max(4000).default(""),
    correctedResponse: z
      .string()
      .trim()
      .min(1)
      .max(24000)
      .nullable()
      .default(null),
    reason: z.string().trim().max(4000).default(""),
  })
  .refine(
    (v) => v.rating || v.label || v.comment || v.correctedResponse,
    "Provide feedback or a correction",
  )
  .refine(
    (v) => !v.correctedResponse || v.reason.length > 0,
    "A correction requires a reason",
  );
export const priceInput = z.object({
  modelId: z.uuid(),
  inputUsdPerMillion: z.number().min(0).max(10000),
  outputUsdPerMillion: z.number().min(0).max(10000),
});
export const apiKeyInput = z.object({
  label: z.string().trim().min(1).max(100),
  agentId: z.uuid(),
  expiresInDays: z.number().int().min(1).max(365).default(30),
});
export const webhookInput = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.url().max(500),
});
export const environments = ["development", "staging", "production"] as const;
export const deploymentPromotion = z.object({
  versionId: z.uuid(),
  environment: z.enum(environments),
});
