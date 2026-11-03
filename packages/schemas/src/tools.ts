import { z } from "zod";
const name = z.string().trim().min(1).max(100);
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
export const apiOperationConfig = z.object({
  kind: z.literal("api"),
  url: z.url().max(1000),
  path: z.string().regex(/^\//).max(1000),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  parameters: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        in: z.enum(["path", "query"]),
        required: z.boolean(),
        schema: z.record(z.string(), z.json()),
      }),
    )
    .max(30),
  bodySchema: z.record(z.string(), z.json()).nullable().default(null),
  bodyRequired: z.boolean().default(false),
  secretId: z.uuid().nullable().default(null),
  auth: z.enum(["none", "bearer", "api-key"]).default("none"),
  headerName: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9-]{0,62}$/)
    .default("X-API-Key"),
  inputSchema: z.record(z.string(), z.json()),
});
export const stdioSettings = z.object({
  command: z.string().min(1).max(1000),
  args: z.array(z.string().max(2000)).max(30).default([]),
  credentialEnv: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,62}$/)
    .nullable()
    .default(null),
});
export const toolConfig = z.discriminatedUnion("kind", [
  apiOperationConfig,
  z.object({
    kind: z.literal("financial"),
    requireEvidence: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("http"),
    url: z.url().max(1000),
    queryParameters: z.array(identifier).max(12).default([]),
    secretId: z.uuid().nullable().default(null),
    auth: z.enum(["none", "bearer", "api-key"]).default("none"),
    headerName: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9-]{0,62}$/)
      .default("X-API-Key"),
  }),
  z.object({
    kind: z.literal("database"),
    secretId: z.uuid(),
    schema: identifier.default("public"),
    table: identifier,
    columns: z.array(identifier).min(1).max(20),
    filterColumns: z.array(identifier).max(10).default([]),
    rowLimit: z.number().int().min(1).max(100).default(20),
  }),
  z.object({
    kind: z.literal("search"),
    provider: z.literal("brave"),
    secretId: z.uuid(),
    resultCount: z.number().int().min(1).max(10).default(5),
    allowedDomains: z
      .array(z.string().regex(/^[a-z0-9.-]+$/))
      .max(20)
      .default([]),
    deniedDomains: z
      .array(z.string().regex(/^[a-z0-9.-]+$/))
      .max(20)
      .default([]),
  }),
  z.object({
    kind: z.literal("mcp"),
    connectorId: z.uuid(),
    remoteName: z.string().min(1).max(128),
    allowMutations: z.boolean().default(false),
  }),
]);
export const toolInput = z.object({
  name,
  description: z.string().min(1).max(1500),
  config: toolConfig,
  enabled: z.boolean().default(true),
  publicAccess: z.boolean().default(false),
  readOnlyAcknowledged: z.literal(true),
  timeoutMs: z.number().int().min(500).max(15000).default(5000),
});
export const toolUpdate = toolInput.extend({
  revision: z.number().int().min(1),
});
export const connectorInput = z.object({
  name,
  url: z.string().max(1000).default(""),
  transport: z.enum(["http", "stdio"]).default("http"),
  authHeader: z
    .string()
    .regex(
      /^(?:Authorization|(?!(?:host$|cookie$|content-|proxy-|connection$|transfer-|set-cookie$|te$|trailer$))[A-Za-z][A-Za-z0-9_-]{0,62})$/i,
    )
    .default("Authorization"),
  stdio: stdioSettings.nullable().default(null),
  secretId: z.uuid().nullable().default(null),
  enabled: z.boolean().default(true),
});
export const connectorUpdate = connectorInput.extend({
  revision: z.number().int().min(1),
});
export const executeToolInput = z.object({
  arguments: z.record(z.string(), z.json()).default({}),
});
export const agentTools = z
  .object({
    toolIds: z.array(z.uuid()).max(8).default([]),
    usageMode: z.enum(["automatic", "always", "disabled"]).default("automatic"),
    usageInstructions: z.string().trim().max(4000).default(""),
    maxCalls: z.number().int().min(1).max(5).default(3),
  })
  .default({
    toolIds: [],
    maxCalls: 3,
    usageMode: "automatic",
    usageInstructions: "",
  });
export type ToolConfig = z.infer<typeof toolConfig>;
