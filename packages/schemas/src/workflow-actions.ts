import { z } from "zod";
import {
  workflowExpression,
  workflowIdentifier,
  workflowJson,
} from "@agentconnect/schemas/workflow-values";
export const actionRetry = z
  .strictObject({
    maxAttempts: z.number().int().min(1).max(3).default(1),
    delayMs: z.number().int().min(100).max(10000).default(1000),
  })
  .default({ maxAttempts: 1, delayMs: 1000 });
export const actionJsonSchema = z
  .record(z.string(), workflowJson)
  .refine((v) => JSON.stringify(v).length <= 16000, "Schema exceeds 16 KB");
export const actionInputs = z
  .record(workflowIdentifier, workflowExpression)
  .refine((v) => Object.keys(v).length <= 30, "At most 30 mapped inputs");
// Metadata describes a deterministic invocation of an existing capability; it never embeds its configuration.
export const workflowAction = z.strictObject({
  id: workflowIdentifier,
  name: z.string().trim().min(1).max(100),
  connector: z.enum(["agentconnect.tool", "agentconnect.mcp"]),
  operation: z.literal("execute"),
  toolId: z.uuid(),
  connectionId: z.uuid().optional(),
  inputSchema: actionJsonSchema.default({ type: "object" }),
  outputSchema: actionJsonSchema.default({}),
  staticInputs: z.record(workflowIdentifier, workflowJson).default({}),
  mappedInputs: actionInputs.default({}),
  timeoutMs: z.number().int().min(100).max(15000).default(5000),
  retry: actionRetry,
  sideEffect: z.enum(["read", "write", "delete"]).default("read"),
  riskLevel: z.enum(["low", "medium", "high"]).default("low"),
  idempotency: z
    .enum(["not-required", "unsupported", "key"])
    .default("not-required"),
  requiredPermissions: z
    .array(z.enum(["workflow:execute", "tool:read", "tool:execute"]))
    .max(3)
    .default([]),
  requiredScopes: z
    .array(z.string().trim().min(1).max(120))
    .max(20)
    .default([]),
});
export type WorkflowAction = z.infer<typeof workflowAction>;
