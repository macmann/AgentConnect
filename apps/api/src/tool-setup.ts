import { randomUUID, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  connectorInput,
  toolConfig,
  toolInput,
  type ToolConfig,
} from "@agentconnect/schemas/tools";
import { toolTemplates } from "@agentconnect/schemas/tool-templates";
import { actor, workspaceAccess, params, id, audit } from "./app.js";
import { sql } from "./db.js";
import { encrypt } from "./security.js";
import {
  ToolError,
  validateToolUrl,
  toolSecret,
  inputSchemaFor,
  validateInputSchema,
  discoverMcp,
  connectorFor,
  databaseEndpoint,
  type Connector,
  type ToolContext,
} from "./tool-runtime.js";
import { stdioProfiles, validateStdio } from "./tool-stdio.js";
import { importOpenApi } from "./tool-openapi.js";
const setup = z
  .object({
    mode: z.enum(["template", "mcp", "api"]),
    templateId: z.string().max(50).optional(),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1500).default(""),
    credential: z.string().min(1).max(8000).optional(),
    secretId: z.uuid().nullable().default(null),
    connector: connectorInput.optional(),
    connectorId: z.uuid().optional(),
    spec: z.string().max(300000).optional(),
    database: z
      .object({
        schema: z.string(),
        table: z.string(),
        columns: z.array(z.string()),
        filterColumns: z.array(z.string()),
      })
      .optional(),
    serverUrl: z.string().max(1000).optional(),
    selected: z.array(z.string().min(1).max(128)).min(1).max(8).optional(),
    publicAccess: z.boolean().default(false),
    allowMutations: z.boolean().default(false),
    acknowledged: z.boolean().default(false),
    reviewFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
type Setup = z.infer<typeof setup>;
type Choice = {
  id: string;
  name: string;
  description: string;
  config: ToolConfig;
  inputSchema: Record<string, unknown>;
  sideEffect: boolean;
};
export async function registerToolSetupRoutes(app: FastifyInstance) {
  app.get("/workspaces/:workspaceId/tool-setup", async (r) => {
    const u = await actor(r);
    await workspaceAccess(u.id, id(params(r).workspaceId), "tool:manage");
    return { templates: toolTemplates, stdioProfiles: stdioProfiles() };
  });
  async function inspect(data: Setup, context: ToolContext) {
    if (data.credential && data.secretId)
      throw new ToolError("TOOL_CHOOSE_ONE_CREDENTIAL");
    if (data.connectorId && (data.credential || data.secretId))
      throw new ToolError("MCP_EXISTING_CONNECTION_OWNS_CREDENTIAL");
    const existingSecret = await toolSecret(data.secretId, context);
    const template =
      data.mode === "template"
        ? toolTemplates.find((t) => t.id === data.templateId)
        : undefined;
    if (data.mode === "template" && !template)
      throw new ToolError("TOOL_TEMPLATE_UNAVAILABLE");
    let connector: Connector | undefined,
      choices: Choice[] = [],
      warnings: string[] = [];
    if (template?.kind === "financial" || template?.kind === "search") {
      if (template.kind === "search") {
        validateToolUrl("https://api.search.brave.com/res/v1/web/search");
        if (!existingSecret && !data.credential)
          throw new ToolError("TOOL_CREDENTIAL_REQUIRED");
      }
      const config: ToolConfig =
        template.kind === "financial"
          ? { kind: "financial", requireEvidence: true }
          : {
              kind: "search",
              provider: "brave",
              secretId: data.secretId ?? randomUUID(),
              resultCount: 5,
              allowedDomains: [],
              deniedDomains: [],
            };
      choices = [
        {
          id: template.id,
          name: data.name,
          description: data.description || template.description,
          config,
          inputSchema: await inputSchemaFor(config, context),
          sideEffect: false,
        },
      ];
    } else if (template?.kind === "database") {
      const credential = data.credential || existingSecret;
      if (!credential) throw new ToolError("TOOL_CREDENTIAL_REQUIRED");
      databaseEndpoint(credential);
      const config = toolConfig.parse({
        kind: "database",
        ...data.database,
        secretId: data.secretId ?? randomUUID(),
      });
      choices = [
        {
          id: template.id,
          name: data.name,
          description: data.description || template.description,
          config,
          inputSchema: await inputSchemaFor(config, context),
          sideEffect: false,
        },
      ];
    } else if (data.mode === "api") {
      if (!data.spec) throw new ToolError("OPENAPI_SPEC_REQUIRED");
      const imported = importOpenApi(data.spec, data.serverUrl || undefined);
      warnings = imported.warnings;
      choices = imported.operations.map((op) => {
        validateToolUrl(op.config.url);
        if (op.config.auth !== "none" && !existingSecret && !data.credential)
          throw new ToolError("TOOL_CREDENTIAL_REQUIRED");
        validateInputSchema(op.config.inputSchema);
        return {
          ...op,
          config: op.config,
          inputSchema: op.config.inputSchema,
          sideEffect: op.config.method !== "GET",
        };
      });
    } else {
      if (data.connectorId)
        connector = await connectorFor(data.connectorId, context);
      else {
        if (!data.connector) throw new ToolError("MCP_CONNECTION_REQUIRED");
        const c = data.connector;
        // Credential selection is centralized so a hidden connector credential can never be substituted.
        if (c.secretId) throw new ToolError("TOOL_CHOOSE_ONE_CREDENTIAL");
        if (c.transport === "stdio") validateStdio(c.stdio);
        else validateToolUrl(c.url);
        connector = {
          id: randomUUID(),
          name: data.name,
          url: c.url,
          transport: c.transport,
          auth_header: c.authHeader,
          stdio: c.stdio,
          secret_id: data.secretId,
          enabled: true,
          revision: 1,
          capabilities: {},
        };
      }
      // Preview credentials remain in memory; discovery never stores a secret or connection.
      const capabilities = await discoverMcp(
        connector,
        context,
        AbortSignal.timeout(15000),
        data.connectorId
          ? undefined
          : { value: data.credential || existingSecret || null },
      ).catch((error) => {
        if (error instanceof ToolError) throw error;
        throw new ToolError("MCP_CONNECTION_FAILED");
      });
      connector.capabilities = capabilities as Record<string, unknown>;
      const tools =
        (
          capabilities as {
            tools?: {
              name: string;
              description?: string;
              inputSchema: Record<string, unknown>;
              annotations?: { readOnlyHint?: boolean };
            }[];
          }
        ).tools ?? [];
      for (const tool of tools) {
        try {
          validateInputSchema(tool.inputSchema);
          choices.push({
            id: tool.name,
            name: tool.name,
            description: (tool.description || tool.name).slice(0, 1500),
            config: {
              kind: "mcp",
              connectorId: connector.id,
              remoteName: tool.name,
              allowMutations: tool.annotations?.readOnlyHint !== true,
            },
            inputSchema: tool.inputSchema,
            sideEffect: tool.annotations?.readOnlyHint !== true,
          });
        } catch {
          warnings.push(`${tool.name}: unsupported input schema`);
        }
      }
      if (!choices.length) throw new ToolError("MCP_NO_SUPPORTED_TOOLS");
    }
    return { choices, warnings, connector };
  }
  for (const save of [false, true])
    app.post(
      `/workspaces/:workspaceId/tool-setup${save ? "" : "/inspect"}`,
      {
        bodyLimit: 400000,
        config: { rateLimit: { max: 15, timeWindow: "1 minute" } },
      },
      async (r, reply) => {
        const u = await actor(r),
          w = await workspaceAccess(
            u.id,
            id(params(r).workspaceId),
            "tool:manage",
          ),
          context = { workspaceId: w.id, organizationId: w.organization_id };
        const data = setup.parse(r.body);
        const result = await inspect(data, context);
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              connection: result.connector
                ? {
                    id: data.connectorId ?? null,
                    url: result.connector.url,
                    transport: result.connector.transport ?? "http",
                    authHeader: result.connector.auth_header ?? "Authorization",
                    stdio: result.connector.stdio ?? null,
                  }
                : null,
              choices: result.choices.map(({ config, ...choice }) => ({
                ...choice,
                config: Object.fromEntries(
                  Object.entries(config).filter(
                    ([key]) => !["secretId", "connectorId"].includes(key),
                  ),
                ),
              })),
            }),
          )
          .digest("hex");
        if (!save)
          return {
            fingerprint,
            operations: result.choices.map(({ config, ...choice }) => ({
              ...choice,
              method: config.kind === "api" ? config.method : undefined,
              path: config.kind === "api" ? config.path : undefined,
            })),
            warnings: result.warnings,
          };
        if (data.reviewFingerprint !== fingerprint)
          throw new ToolError("TOOL_REVIEW_CHANGED_VALIDATE_AGAIN");
        if (!data.acknowledged) throw new ToolError("TOOL_REVIEW_REQUIRED");
        const selection = data.selected ?? [],
          chosen = result.choices.filter((c) => selection.includes(c.id));
        if (
          !chosen.length ||
          chosen.length !== new Set(selection).size ||
          selection.length !== new Set(selection).size
        )
          throw new ToolError("TOOL_SELECTION_INVALID");
        if (chosen.some((c) => c.sideEffect) && !data.allowMutations)
          throw new ToolError("TOOL_SIDE_EFFECT_ACKNOWLEDGEMENT_REQUIRED");
        const credentialId = data.credential ? randomUUID() : data.secretId,
          secretName = `TOOL_${data.name
            .toUpperCase()
            .replace(/[^A-Z0-9_]/g, "_")
            .slice(0, 40)}_${randomUUID().slice(0, 8).toUpperCase()}`;
        const created = await sql.begin(async (tx) => {
          if (data.credential)
            await tx`INSERT INTO secrets(id,organization_id,workspace_id,name,ciphertext,created_by) VALUES(${credentialId},${w.organization_id},${w.id},${secretName},${tx.json(encrypt(data.credential, `${w.organization_id}:${w.id}:${secretName}`))},${u.id})`;
          if (result.connector && !data.connectorId) {
            const c = result.connector;
            await tx`INSERT INTO mcp_connectors(id,organization_id,workspace_id,name,url,secret_id,transport,stdio,auth_header,capabilities,discovered_at) VALUES(${c.id},${w.organization_id},${w.id},${data.name},${c.url},${credentialId},${c.transport ?? "http"},${tx.json(c.stdio ?? null)},${c.auth_header ?? "Authorization"},${tx.json(c.capabilities as never)},now())`;
            await audit(
              tx,
              r,
              u.id,
              "mcp.created",
              c.id,
              w.organization_id,
              w.id,
            );
          }
          // Existing MCP discovery is refreshed with revision checking before approving registered schemas.
          if (result.connector && data.connectorId) {
            const [current] =
              await tx`UPDATE mcp_connectors SET capabilities=${tx.json(result.connector.capabilities as never)},discovered_at=now() WHERE id=${data.connectorId} AND workspace_id=${w.id} AND organization_id=${w.organization_id} AND revision=${result.connector.revision} AND enabled=true RETURNING id`;
            if (!current) throw new ToolError("MCP_CONNECTOR_CHANGED");
          }
          const tools = [];
          for (const choice of chosen) {
            let conf = choice.config;
            if ("secretId" in conf)
              conf = { ...conf, secretId: credentialId } as ToolConfig;
            const value = toolInput.parse({
              name:
                chosen.length === 1
                  ? data.name
                  : `${data.name} · ${choice.name}`.slice(0, 100),
              description: data.description || choice.description,
              config: conf,
              publicAccess: data.publicAccess,
              readOnlyAcknowledged: true,
            });
            const toolId = randomUUID();
            await tx`INSERT INTO tools(id,organization_id,workspace_id,name,description,kind,config,input_schema,public_access,timeout_ms) VALUES(${toolId},${w.organization_id},${w.id},${value.name},${value.description},${conf.kind},${tx.json(conf)},${tx.json(choice.inputSchema as never)},${value.publicAccess},${value.timeoutMs})`;
            await audit(
              tx,
              r,
              u.id,
              "tool.created",
              toolId,
              w.organization_id,
              w.id,
            );
            tools.push({ id: toolId, name: value.name });
          }
          return tools;
        });
        return reply.code(201).send({ tools: created });
      },
    );
}
