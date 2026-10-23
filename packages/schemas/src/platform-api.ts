import { z } from "zod";
export const agentInvocation = z
  .object({
    message: z.string().trim().min(1).max(16000),
    conversationId: z.uuid().optional(),
    versionId: z.uuid().optional(),
    includeDetails: z.boolean().default(false),
  })
  .strict();
export const knowledgeSearch = z
  .object({
    query: z.string().trim().min(1).max(4000),
    mode: z.enum(["semantic", "vector", "hybrid"]).default("hybrid"),
    topK: z.number().int().min(1).max(30).default(5),
    minScore: z.number().min(0).max(1).default(0),
    sourceIds: z.array(z.uuid()).max(100).optional(),
    contentMode: z.enum(["current", "approved"]).default("current"),
    includeDetails: z.boolean().default(false),
  })
  .strict();
