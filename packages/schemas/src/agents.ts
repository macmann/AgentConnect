import { z } from "zod";
import {
  quickAction,
  supportJourney,
  answerPolicy,
} from "@agentconnect/schemas/bank-experience";
import { generativeConfig } from "@agentconnect/schemas/generative";
import { environments } from "@agentconnect/schemas/operations";
import { agentTools } from "@agentconnect/schemas/tools";
import { ragConfig } from "@agentconnect/schemas/knowledge";
export const providerNames = [
  "openai",
  "openai-compatible",
  "anthropic",
  "gemini",
] as const;
export const modelInput = z.object({
  name: z.string().trim().min(1).max(100),
  provider: z.enum(providerNames),
  modelId: z.string().min(1).max(150),
  baseUrl: z.url().max(500).optional(),
  secretId: z.uuid().nullable().default(null),
  contextWindow: z.number().int().min(256).max(2000000).default(32768),
  maxOutputTokens: z.number().int().min(1).max(2000000).default(4096),
  capabilities: z
    .object({
      streaming: z.literal(true).default(true),
      temperature: z.boolean().default(true),
      topP: z.boolean().default(true),
    })
    .default({ streaming: true, temperature: true, topP: true }),
});
export const modelUpdate = modelInput.extend({
  revision: z.number().int().positive(),
});
export type ModelInput = z.infer<typeof modelInput>;
export const promptSchema = z.object({
  role: z.string().max(4000).default("You are a helpful assistant."),
  objective: z.string().max(4000).default(""),
  instructions: z.string().max(12000).default(""),
  constraints: z.string().max(4000).default(""),
  tone: z.string().max(1000).default(""),
  outputFormat: z.string().max(2000).default(""),
  escalationPolicy: z.string().max(2000).default(""),
  advanced: z.string().max(24000).nullable().default(null),
});
export const agentConfig = z
  .object({
    generative: generativeConfig,
    answerPolicy,
    quickActions: z.array(quickAction).max(20).default([]),
    journeys: z.array(supportJourney).max(12).default([]),
    schemaVersion: z.literal(1).default(1),
    rag: ragConfig,
    tools: agentTools,
    category: z
      .enum(["unstructured", "structured", "hybrid"])
      .default("hybrid"),
    modelId: z.uuid(),
    prompt: promptSchema.default({
      role: "You are a helpful assistant.",
      objective: "",
      instructions: "",
      constraints: "",
      tone: "",
      outputFormat: "",
      escalationPolicy: "",
      advanced: null,
    }),
    temperature: z.number().min(0).max(1).default(0.7),
    topP: z.number().gt(0).max(1).nullable().default(null),
    maxOutputTokens: z.number().int().min(1).max(2000000).default(1024),
    historyWindow: z.number().int().min(1).max(50).default(10),
    language: z.string().max(50).default("English"),
    timezone: z.string().max(100).default("UTC"),
    welcomeMessage: z.string().max(2000).default("How can I help you today?"),
    conversationStarters: z
      .array(z.string().min(1).max(300))
      .max(20)
      .default([]),
    fallbackResponse: z
      .string()
      .max(2000)
      .default("The model is unavailable. Please try again later."),
  })
  .superRefine((v, ctx) => {
    const add = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    if (new Set(v.quickActions.map((a) => a.id)).size !== v.quickActions.length)
      add(["quickActions"], "Quick action IDs must be unique");
    if (new Set(v.journeys.map((j) => j.id)).size !== v.journeys.length)
      add(["journeys"], "Journey IDs must be unique");
    v.quickActions.forEach((a, i) => {
      if (
        a.behavior === "journey" &&
        !v.journeys.some((j) => j.id === a.journeyId)
      )
        add(["quickActions", i, "journeyId"], "Select a configured journey");
    });
    for (const [base] of Object.entries(v.rag.releasePins))
      if (!v.rag.knowledgeBaseIds.includes(base))
        add(
          ["rag", "releasePins"],
          "Pinned releases must belong to attached knowledge",
        );
    if (v.answerPolicy.mode === "grounded") {
      if (!v.rag.knowledgeBaseIds.length)
        add(
          ["rag", "knowledgeBaseIds"],
          "Grounded mode requires attached knowledge",
        );
      if (v.rag.contentMode !== "approved")
        add(
          ["rag", "contentMode"],
          "Grounded mode requires approved knowledge releases",
        );
      if (v.rag.usageMode !== "always")
        add(
          ["rag", "usageMode"],
          "Grounded mode requires retrieval on every factual turn",
        );
      if (v.generative.enabled)
        add(
          ["generative"],
          "Use standard response mode for rich components; grounded mode validates text before displaying it",
        );
    }
  });
export const agentInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(""),
  publicDescription: z.string().max(2000).default(""),
  config: agentConfig,
});
export const agentUpdate = agentInput.extend({
  revision: z.number().int().min(1),
});
export const publishInput = z.object({ revision: z.number().int().min(1) });
export const deploymentInput = z.object({
  environment: z.enum(environments).default("production"),
  versionId: z.uuid(),
  name: z.string().trim().min(1).max(100),
});
export const chatInput = z.object({
  message: z.string().trim().min(1).max(12000),
  conversationId: z.uuid().optional(),
  quickActionId: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .optional(),
});
export type AgentConfig = z.infer<typeof agentConfig>;
export type AgentInput = z.infer<typeof agentInput>;
