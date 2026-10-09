import { z } from "zod";
export const embeddingInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    provider: z.enum(["openai", "openai-compatible", "gemini"]),
    modelId: z.string().min(1).max(150),
    baseUrl: z.url().max(500).optional(),
    secretId: z.uuid().nullable().default(null),
    dimensions: z.number().int().min(1).max(2000),
  })
  .refine((v) => v.provider !== "openai-compatible" || !!v.baseUrl, {
    message: "Compatible embedding providers require a base URL",
    path: ["baseUrl"],
  });
export const knowledgeInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000).default(""),
    embeddingModelId: z.uuid(),
    chunkSize: z.number().int().min(200).max(4000).default(1600),
    chunkOverlap: z.number().int().min(0).max(1000).default(200),
    chunkStrategy: z
      .enum(["recursive", "page", "heading"])
      .default("recursive"),
    publicAccess: z.boolean().default(false),
  })
  .refine((v) => v.chunkOverlap < v.chunkSize, {
    message: "Overlap must be smaller than chunk size",
    path: ["chunkOverlap"],
  });
export const knowledgeUpdate = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(""),
  publicAccess: z.boolean(),
  revision: z.number().int().min(1),
});
export const textSource = z.object({
  title: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(200000),
});
export const qaInput = z.object({
  question: z.string().trim().min(1).max(2000),
  answer: z.string().trim().min(1).max(20000),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
});
export const websiteInput = z.object({
  url: z.url().max(1000),
  maxPages: z.number().int().min(1).max(20).default(1),
  maxDepth: z.number().int().min(0).max(3).default(0),
  allowedPaths: z
    .array(z.string().regex(/^\//).max(200))
    .max(20)
    .default(["/"]),
  blockedPaths: z.array(z.string().regex(/^\//).max(200)).max(20).default([]),
});
export const retrievalInput = z.object({
  query: z.string().trim().min(1).max(4000),
  topK: z.number().int().min(1).max(10).default(5),
  minScore: z.number().min(0).max(1).default(0),
  mode: z.enum(["vector", "hybrid"]).default("hybrid"),
  sourceIds: z.array(z.uuid()).max(30).default([]),
});
export type RetrievalInput = z.infer<typeof retrievalInput>;
export const ragConfig = z
  .object({
    knowledgeBaseIds: z.array(z.uuid()).max(5).default([]),
    topK: z.number().int().min(1).max(10).default(5),
    minScore: z.number().min(0).max(1).default(0.2),
    mode: z.enum(["vector", "hybrid"]).default("hybrid"),
    requireCitations: z.boolean().default(true),
  })
  .default({
    knowledgeBaseIds: [],
    topK: 5,
    minScore: 0.2,
    mode: "hybrid",
    requireCitations: true,
  });
