import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { httpConnectionInput } from "@agentconnect/schemas/workflow-actions";
import { workflowIdentifier } from "@agentconnect/schemas/workflow-values";
import { actor, workspaceAccess, id, params, audit, HttpError } from "./app.js";
import { sql } from "./db.js";
import { validateToolUrl, toolSecret, connectorFor } from "./tool-runtime.js";
import { capabilityHash } from "./workflow-action-runtime.js";
import { schemaValidator } from "./workflow-action-schema.js";
export async function actionConnectionCatalog(
  workspaceId: string,
  organizationId: string,
) {
  const http =
    await sql`SELECT id,name,base_url,auth,secret_id,header_name,methods,idempotency_supported,scopes,enabled,revision FROM workflow_http_connections WHERE workspace_id=${workspaceId} AND organization_id=${organizationId} ORDER BY name`;
  const servers =
    await sql`SELECT id,name,enabled,capabilities FROM mcp_connectors WHERE workspace_id=${workspaceId} AND organization_id=${organizationId} ORDER BY name`;
  const grants =
    await sql`SELECT id,connector_id,operation,side_effect,risk_level,idempotency_argument,scopes,enabled,capability_hash FROM workflow_mcp_action_grants WHERE workspace_id=${workspaceId} AND organization_id=${organizationId}`;
  const mcp = servers.map((server) => ({
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    operations: (
      (server.capabilities.tools ?? []) as Record<string, unknown>[]
    ).map((metadata) => {
      const grant = grants.find(
        (g) => g.connector_id === server.id && g.operation === metadata.name,
      );
      const readOnly =
        (metadata.annotations as { readOnlyHint?: boolean } | undefined)
          ?.readOnlyHint === true;
      const allowed =
        (readOnly && !grant) ||
        (!!grant?.enabled &&
          grant.capability_hash === capabilityHash(metadata));
      return {
        name: metadata.name,
        description: metadata.description ?? "",
        inputSchema: metadata.inputSchema,
        outputSchema: metadata.outputSchema ?? {},
        sideEffect: grant?.side_effect ?? (readOnly ? "read" : "write"),
        riskLevel: grant?.risk_level ?? (readOnly ? "low" : "high"),
        idempotency: grant?.idempotency_argument
          ? "key"
          : readOnly
            ? "not-required"
            : "unsupported",
        idempotencyArgument: grant?.idempotency_argument ?? undefined,
        scopes: grant?.scopes ?? [],
        allowed,
        grantId: grant?.id,
        annotations: metadata.annotations ?? {},
      };
    }),
  }));
  return { http, mcp };
}
export async function registerActionConnections(app: FastifyInstance) {
  app.get("/workspaces/:workspaceId/action-connections", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "workflow:read",
      );
    return actionConnectionCatalog(w.id, w.organization_id);
  });
  app.post(
    "/workspaces/:workspaceId/action-connections",
    { bodyLimit: 20000 },
    async (r, reply) => {
      const u = await actor(r),
        w = await workspaceAccess(
          u.id,
          id(params(r).workspaceId),
          "tool:manage",
        ),
        data = httpConnectionInput.parse(r.body);
      const endpoint = validateToolUrl(data.baseUrl);
      if (endpoint.search || endpoint.hash)
        throw new HttpError(
          400,
          "Use an origin and base path without query parameters or fragments",
        );
      if (
        /^(host|connection|content-length|transfer-encoding|upgrade|proxy-.*|x-forwarded-.*|forwarded|keep-alive|trailer|te)$/i.test(
          data.headerName,
        )
      )
        throw new HttpError(
          400,
          "Choose a credential header rather than a transport header",
        );
      if (data.secretId)
        await toolSecret(data.secretId, {
          workspaceId: w.id,
          organizationId: w.organization_id,
        });
      const connectionId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`INSERT INTO workflow_http_connections(id,workspace_id,organization_id,name,base_url,auth,secret_id,header_name,methods,idempotency_supported,scopes,enabled,created_by) VALUES (${connectionId},${w.id},${w.organization_id},${data.name},${data.baseUrl},${data.auth},${data.secretId},${data.headerName},${tx.json(data.methods)},${data.idempotencySupported},${tx.json(data.scopes)},${data.enabled},${u.id})`;
        await audit(
          tx,
          r,
          u.id,
          "workflow.http_connection_created",
          connectionId,
          w.organization_id,
          w.id,
        );
      });
      return reply.code(201).send({ id: connectionId, revision: 1 });
    },
  );
  app.put(
    "/workflow-action-connections/:connectionId",
    { bodyLimit: 20000 },
    async (r) => {
      const u = await actor(r),
        [row] =
          await sql`SELECT * FROM workflow_http_connections WHERE id=${id(params(r).connectionId)}`;
      if (!row) throw new HttpError(404, "Connection unavailable");
      await workspaceAccess(u.id, row.workspace_id, "tool:manage");
      const data = httpConnectionInput
        .safeExtend({ revision: z.number().int().min(1) })
        .parse(r.body);
      const endpoint = validateToolUrl(data.baseUrl);
      if (endpoint.search || endpoint.hash)
        throw new HttpError(
          400,
          "Use an origin and base path without query parameters or fragments",
        );
      if (
        /^(host|connection|content-length|transfer-encoding|upgrade|proxy-.*|x-forwarded-.*|forwarded|keep-alive|trailer|te)$/i.test(
          data.headerName,
        )
      )
        throw new HttpError(400, "Unsafe credential header");
      if (data.secretId)
        await toolSecret(data.secretId, {
          workspaceId: row.workspace_id,
          organizationId: row.organization_id,
        });
      await sql.begin(async (tx) => {
        const saved =
          await tx`UPDATE workflow_http_connections SET name=${data.name},base_url=${data.baseUrl},auth=${data.auth},secret_id=${data.secretId},header_name=${data.headerName},methods=${tx.json(data.methods)},idempotency_supported=${data.idempotencySupported},scopes=${tx.json(data.scopes)},enabled=${data.enabled},revision=revision+1 WHERE id=${row.id} AND revision=${data.revision} RETURNING id`;
        if (!saved.length)
          throw new HttpError(409, "Connection changed; reload before saving");
        await audit(
          tx,
          r,
          u.id,
          "workflow.http_connection_updated",
          row.id,
          row.organization_id,
          row.workspace_id,
        );
      });
      return { id: row.id, revision: data.revision + 1 };
    },
  );
  app.post(
    "/workspaces/:workspaceId/mcp-action-grants",
    { bodyLimit: 20000 },
    async (r) => {
      const u = await actor(r),
        w = await workspaceAccess(
          u.id,
          id(params(r).workspaceId),
          "tool:manage",
        );
      const data = z
        .strictObject({
          connectorId: z.uuid(),
          operation: z.string().min(1).max(128),
          sideEffect: z.enum(["read", "write", "delete"]),
          riskLevel: z.enum(["low", "medium", "high"]),
          allowWrites: z.boolean().default(false),
          enabled: z.boolean().default(true),
          idempotencyArgument: workflowIdentifier.optional(),
          scopes: z.array(z.string().min(1).max(100)).max(20).default([]),
        })
        .parse(r.body);
      const connector = await connectorFor(data.connectorId, {
        workspaceId: w.id,
        organizationId: w.organization_id,
      });
      const metadata = (
        connector.capabilities.tools as Record<string, unknown>[] | undefined
      )?.find((t) => t.name === data.operation);
      if (!metadata)
        throw new HttpError(400, "Discover the MCP operation in Tools first");
      const annotations = metadata.annotations as
        { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined;
      if (
        (data.sideEffect === "read" && annotations?.readOnlyHint !== true) ||
        (data.sideEffect !== "read" &&
          (!data.allowWrites || data.riskLevel === "low")) ||
        (annotations?.destructiveHint &&
          (data.sideEffect !== "delete" || data.riskLevel !== "high"))
      )
        throw new HttpError(
          400,
          "Explicitly allow and classify this MCP operation",
        );
      schemaValidator(metadata.inputSchema as Record<string, unknown>);
      if (metadata.outputSchema)
        schemaValidator(metadata.outputSchema as Record<string, unknown>);
      const schema = metadata.inputSchema as {
        properties?: Record<string, { type?: string }>;
      };
      if (
        data.idempotencyArgument &&
        schema.properties?.[data.idempotencyArgument]?.type !== "string"
      )
        throw new HttpError(
          400,
          "The idempotency argument must be an operation string input",
        );
      const grantId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`INSERT INTO workflow_mcp_action_grants(id,workspace_id,organization_id,connector_id,operation,side_effect,risk_level,capability_hash,metadata,idempotency_argument,scopes,enabled,created_by) VALUES (${grantId},${w.id},${w.organization_id},${connector.id},${data.operation},${data.sideEffect},${data.riskLevel},${capabilityHash(metadata)},${tx.json(metadata as never)},${data.idempotencyArgument ?? null},${tx.json(data.scopes)},${data.enabled},${u.id}) ON CONFLICT(connector_id,operation) DO UPDATE SET side_effect=EXCLUDED.side_effect,risk_level=EXCLUDED.risk_level,capability_hash=EXCLUDED.capability_hash,metadata=EXCLUDED.metadata,idempotency_argument=EXCLUDED.idempotency_argument,scopes=EXCLUDED.scopes,enabled=EXCLUDED.enabled`;
        await audit(
          tx,
          r,
          u.id,
          "workflow.mcp_action_policy_saved",
          connector.id,
          w.organization_id,
          w.id,
        );
      });
      return { ok: true };
    },
  );
}
