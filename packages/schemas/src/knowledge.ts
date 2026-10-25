import { metadataFilter } from "@agentconnect/schemas/knowledge-metadata";
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
export const visionExtraction = z.object({
  enabled: z.boolean().default(false),
  modelId: z.uuid().nullable().default(null),
  scope: z.enum(["scanned", "complex", "all"]).default("scanned"),
  languages: z.string().trim().max(200).default("auto"),
  maxPages: z.number().int().min(1).max(200).default(20),
  maxOutputTokens: z.number().int().min(1024).max(1000000).default(8192),
});
export const advancedProcessing = z
  .object({
    vision: visionExtraction.prefault({}),
    enabled: z.boolean().default(false),
    llmAssisted: z.boolean().default(false),
    modelId: z.uuid().nullable().default(null),
    chunkTokens: z.number().int().min(100).max(1500).default(500),
  })
  .superRefine((v, ctx) => {
    if (v.vision.enabled && (!v.enabled || !v.vision.modelId))
      ctx.addIssue({
        code: "custom",
        path: ["vision", "modelId"],
        message:
          "Enable advanced processing and select a vision-capable workspace model",
      });
    if (v.enabled && v.llmAssisted && !v.modelId)
      ctx.addIssue({
        code: "custom",
        path: ["modelId"],
        message: "Select a workspace model for LLM-assisted processing",
      });
  });
export type AdvancedProcessing = z.infer<typeof advancedProcessing>;
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
    approvalRequired: z.boolean().default(false),
    ocrEnabled: z.boolean().default(false),
    advancedProcessing: advancedProcessing.prefault({}),
    parentContext: z.boolean().default(false),
  })
  .refine((v) => v.chunkOverlap < v.chunkSize, {
    message: "Overlap must be smaller than chunk size",
    path: ["chunkOverlap"],
  });
export const knowledgeUpdate = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(""),
  publicAccess: z.boolean(),
  approvalRequired: z.boolean().optional(),
  ocrEnabled: z.boolean().optional(),
  advancedProcessing: advancedProcessing.optional(),
  parentContext: z.boolean().optional(),
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
export const websiteInput = z
  .object({
    url: z.url().trim().max(1000),
    crawler: z.enum(["builtin", "firecrawl"]).default("builtin"),
    secretId: z.uuid().nullable().default(null),
    maxPages: z.number().int().min(1).max(100).default(20),
    maxDepth: z.number().int().min(0).max(5).default(2),
    allowedPaths: z
      .array(z.string().regex(/^\//).max(200))
      .max(20)
      .default(["/"]),
    blockedPaths: z.array(z.string().regex(/^\//).max(200)).max(20).default([]),
  })
  .superRefine((data, ctx) => {
    let url: URL;
    try {
      url = new URL(data.url);
    } catch {
      return;
    }
    if (!["http:", "https:"].includes(url.protocol))
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "Use an HTTP or HTTPS website URL",
      });
    if (url.username || url.password)
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "Website URLs cannot contain embedded credentials",
      });
    if (data.crawler === "firecrawl" && !/^https:\/\//i.test(data.url))
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "Firecrawl requires a public HTTPS website",
      });
    if (data.crawler === "firecrawl" && !data.secretId)
      ctx.addIssue({
        code: "custom",
        path: ["secretId"],
        message: "Select a workspace Firecrawl API key",
      });
    if (data.crawler === "builtin" && data.secretId)
      ctx.addIssue({
        code: "custom",
        path: ["secretId"],
        message: "Built-in crawling does not use a credential",
      });
  });
export const retrievalInput = z.object({
  metadataFilter: metadataFilter.optional(),
  query: z.string().trim().min(1).max(4000),
  topK: z.number().int().min(1).max(10).default(5),
  minScore: z.number().min(0).max(1).default(0),
  mode: z.enum(["vector", "hybrid"]).default("hybrid"),
  sourceIds: z.array(z.uuid()).max(30).default([]),
});
export type RetrievalInput = z.infer<typeof retrievalInput>;
export const ragConfig = z
  .object({
    metadataFilter: metadataFilter.optional(),
    answerSourcePolicy: z
      .enum(["balanced", "prefer_approved_qa"])
      .default("balanced"),
    qaMinScore: z.number().min(0).max(1).default(0.75),
    queryRewrite: z.boolean().default(false),
    contextualRewrite: z.boolean().optional(),
    rerank: z.boolean().default(false),
    rerankerId: z.uuid().nullable().default(null),
    rerankMaxOutputTokens: z.number().int().min(128).max(2000000).default(1024),
    candidateCount: z.number().int().min(5).max(30).default(15),
    knowledgeBaseIds: z.array(z.uuid()).max(5).default([]),
    contentMode: z.enum(["current", "approved"]).default("current"),
    releasePins: z.record(z.uuid(), z.uuid()).default({}),
    usageMode: z.enum(["automatic", "always", "disabled"]).default("always"),
    usageInstructions: z.string().trim().max(4000).default(""),
    topK: z.number().int().min(1).max(10).default(5),
    minScore: z.number().min(0).max(1).default(0.2),
    mode: z.enum(["vector", "hybrid"]).default("hybrid"),
    requireCitations: z.boolean().default(true),
  })
  .default({
    answerSourcePolicy: "balanced",
    qaMinScore: 0.75,
    queryRewrite: false,
    rerank: false,
    rerankerId: null,
    rerankMaxOutputTokens: 1024,
    candidateCount: 15,
    knowledgeBaseIds: [],
    contentMode: "current",
    releasePins: {},
    usageMode: "always",
    usageInstructions: "",
    topK: 5,
    minScore: 0.2,
    mode: "hybrid",
    requireCitations: true,
  });
