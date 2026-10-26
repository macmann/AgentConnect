import { z } from "zod";
import { promptSchema } from "./agents.js";

export const creationSettings = z
  .object({
    enabled: z.boolean().default(false),
    modelId: z.uuid().nullable().default(null),
    revision: z.number().int().min(0),
  })
  .refine((value) => !value.enabled || !!value.modelId, {
    message: "Select an assistant model before enabling AI creation",
    path: ["modelId"],
  });
export const creationRequest = z
  .object({
    kind: z.enum(["agent", "workflow"]),
    mode: z.enum(["guided", "assisted"]),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().trim().min(1).max(4000),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
export const suggestedAgent = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000).default(""),
    publicDescription: z.string().max(1000).default(""),
    modelId: z.uuid(),
    prompt: promptSchema,
    knowledgeBaseIds: z.array(z.uuid()).max(5).default([]),
    toolIds: z.array(z.uuid()).max(8).default([]),
    language: z.string().trim().min(1).max(80).default("English"),
    welcomeMessage: z.string().max(1000).default("How can I help you?"),
    conversationStarters: z
      .array(z.string().min(1).max(200))
      .max(6)
      .default([]),
  })
  .strict();
export const suggestedWorkflow = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000).default(""),
    steps: z
      .array(
        z
          .object({
            agentVersionId: z.uuid(),
            label: z.string().min(1).max(100),
            instructions: z.string().max(2000).default(""),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
export const creationReply = z
  .object({
    message: z.string().min(1).max(4000),
    suggestions: z.array(z.string().min(1).max(180)).max(4).default([]),
    agent: suggestedAgent.nullable().optional(),
    workflow: suggestedWorkflow.nullable().optional(),
  })
  .strict();
export type CreationRequest = z.infer<typeof creationRequest>;
