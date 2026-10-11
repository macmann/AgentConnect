import { z } from "zod";

export const modelRouting = z
  .object({
    enabled: z.boolean().default(false),
    lightModelId: z.uuid().nullable().default(null),
    // Rules are intentionally explicit: short text alone does not establish an easy query.
    phrases: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
    maxQueryCharacters: z.number().int().min(10).max(2000).default(300),
    firstTurnOnly: z.boolean().default(true),
    fallbackModelIds: z.array(z.uuid()).max(2).default([]),
    fallbackOnRateLimit: z.boolean().default(false),
    firstTokenTimeoutMs: z.number().int().min(1000).max(30000).default(15000),
  })
  .default({
    enabled: false,
    lightModelId: null,
    phrases: [],
    maxQueryCharacters: 300,
    firstTurnOnly: true,
    fallbackModelIds: [],
    fallbackOnRateLimit: false,
    firstTokenTimeoutMs: 15000,
  });
