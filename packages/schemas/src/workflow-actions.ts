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
export const httpMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const httpConnectionInput = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    baseUrl: z.url().max(1000),
    auth: z.enum(["none", "bearer", "api-key", "basic"]).default("none"),
    secretId: z.uuid().nullable().default(null),
    headerName: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9-]{0,79}$/)
      .default("X-API-Key"),
    methods: z.array(z.enum(httpMethods)).min(1).max(5).default(["GET"]),
    idempotencySupported: z.boolean().default(false),
    scopes: z.array(z.string().min(1).max(100)).max(20).default([]),
    enabled: z.boolean().default(true),
  })
  .superRefine((v, c) => {
    if ((v.auth === "none") !== (v.secretId === null))
      c.addIssue({
        code: "custom",
        message: "Select a secret for authenticated connections only",
      });
  });
const requestFields = z
  .record(z.string().min(1).max(100), workflowExpression)
  .refine((v) => Object.keys(v).length <= 30, "At most 30 request fields");
// Metadata describes a deterministic invocation of an existing capability; it never embeds its configuration.
export const workflowAction = z
  .strictObject({
    id: workflowIdentifier,
    name: z.string().trim().min(1).max(100),
    connector: z.enum([
      "agentconnect.tool",
      "agentconnect.mcp",
      "agentconnect.http",
      "agentconnect.mcp-operation",
    ]),
    description: z.string().max(1500).default(""),
    operation: z.string().trim().min(1).max(128),
    toolId: z.uuid().optional(),
    allowSideEffects: z.boolean().default(false),
    idempotencyKey: workflowExpression.optional(),
    idempotencyArgument: workflowIdentifier.optional(),
    http: z
      .strictObject({
        method: z.enum(httpMethods),
        url: workflowExpression,
        headers: requestFields.default({}),
        query: requestFields.default({}),
        body: workflowExpression.optional(),
      })
      .optional(),
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
  })
  .superRefine((v, c) => {
    const legacy = ["agentconnect.tool", "agentconnect.mcp"].includes(
      v.connector,
    );
    if (legacy && (!v.toolId || v.operation !== "execute" || v.http))
      c.addIssue({
        code: "custom",
        message: "Legacy Actions reference a registered Tool execute operation",
      });
    if (!legacy && v.toolId)
      c.addIssue({
        code: "custom",
        message: "Direct Actions select a connection, not an Agent Tool",
      });
    if (
      v.connector === "agentconnect.http" &&
      (!v.http || v.operation !== v.http.method)
    )
      c.addIssue({
        code: "custom",
        message: "Configure an HTTP method and request",
      });
    if (v.connector !== "agentconnect.http" && v.http)
      c.addIssue({
        code: "custom",
        message: "HTTP configuration belongs to HTTP Actions",
      });
    if (v.connector === "agentconnect.mcp-operation" && !v.connectionId)
      c.addIssue({ code: "custom", message: "Select an existing MCP server" });
    if (
      !legacy &&
      v.sideEffect !== "read" &&
      (!v.allowSideEffects || v.riskLevel === "low")
    )
      c.addIssue({
        code: "custom",
        message: "Explicitly enable side effects and select medium/high risk",
      });
    if (
      !legacy &&
      v.sideEffect !== "read" &&
      v.retry.maxAttempts > 1 &&
      v.idempotency !== "key"
    )
      c.addIssue({
        code: "custom",
        message:
          "Write retries require an idempotency-capable connection/operation",
      });
  });
export type WorkflowAction = z.infer<typeof workflowAction>;
