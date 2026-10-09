import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  toolInput,
  toolUpdate,
  connectorInput,
  connectorUpdate,
  executeToolInput,
} from "@agentconnect/schemas/tools";
import { actor, workspaceAccess, audit, HttpError, id, params } from "./app.js";
import { sql } from "./db.js";
import {
  ToolError,
  validateToolUrl,
  toolSecret,
  inputSchemaFor,
  discoverMcp,
  connectorFor,
  executeTool,
  type ToolContext,
} from "./tool-runtime.js";
const context = (w: { id: string; organization_id: string }): ToolContext => ({
  workspaceId: w.id,
  organizationId: w.organization_id,
});
async function owned(
  r: FastifyRequest,
  table: "tools" | "mcp_connectors",
  cap: "tool:manage" | "tool:read" | "tool:execute",
) {
  const u = await actor(r);
  const [row] =
    await sql`SELECT * FROM ${sql(table)} WHERE id=${id(params(r)[table === "tools" ? "toolId" : "connectorId"])}`;
  if (!row || row.archived_at)
    throw new HttpError(404, "Tool or connector unavailable");
  const w = await workspaceAccess(u.id, row.workspace_id, cap);
  return { u, w, row };
}
export async function registerToolRoutes(app: FastifyInstance) {
  const schema = (body: z.ZodType) => {
    // Defaults inside a discriminated union are applied by Zod, not Fastify's AJV.
    const json = z.toJSONSchema(body, { io: "input", target: "draft-7" });
    function stripDefaults(value: unknown) {
      if (value && typeof value === "object") {
        for (const key of Object.keys(value)) {
          if (
            key === "default" ||
            (key === "additionalProperties" &&
              (value as Record<string, unknown>)[key] === false)
          )
            delete (value as Record<string, unknown>)[key];
          else stripDefaults((value as Record<string, unknown>)[key]);
        }
      }
    }
    stripDefaults(json);
    return { schema: { body: json } };
  };
  async function prepare(data: z.infer<typeof toolInput>, c: ToolContext) {
    const conf = data.config;
    if (conf.kind === "http") {
      validateToolUrl(conf.url);
      if (conf.auth !== "none" && !conf.secretId)
        throw new ToolError("TOOL_CREDENTIAL_REQUIRED");
      if (conf.auth === "api-key" && !/^x-[a-z0-9-]+$/i.test(conf.headerName))
        throw new ToolError("TOOL_API_KEY_HEADER_INVALID");
    }
    if (conf.kind === "search")
      validateToolUrl("https://api.search.brave.com/res/v1/web/search");
    if ("secretId" in conf) await toolSecret(conf.secretId, c);
    return inputSchemaFor(conf, c);
  }
  app.get("/workspaces/:workspaceId/tools", async (r) => {
    const u = await actor(r);
    const w = await workspaceAccess(
      u.id,
      id(params(r).workspaceId),
      "tool:read",
    );
    // Builders see descriptions/schemas, admins may inspect config through detail routes.
    return sql`SELECT id,name,description,kind,input_schema,enabled,public_access,timeout_ms,revision FROM tools WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} AND archived_at IS NULL ORDER BY name`;
  });
  app.post(
    "/workspaces/:workspaceId/tools",
    schema(toolInput),
    async (r, reply) => {
      const u = await actor(r);
      const w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "tool:manage",
      );
      const data = toolInput.parse(r.body);
      const input = await prepare(data, context(w));
      const toolId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`INSERT INTO tools(id,workspace_id,organization_id,name,description,kind,config,input_schema,enabled,public_access,timeout_ms) VALUES (${toolId},${w.id},${w.organization_id},${data.name},${data.description},${data.config.kind},${tx.json(data.config)},${tx.json(input as never)},${data.enabled},${data.publicAccess},${data.timeoutMs})`;
        await audit(
          tx,
          r,
          u.id,
          "tool.created",
          toolId,
          w.organization_id,
          w.id,
        );
      });
      return reply.code(201).send({ id: toolId, revision: 1 });
    },
  );
  app.get("/tools/:toolId", async (r) => {
    const { row } = await owned(r, "tools", "tool:manage");
    return row;
  });
  app.put("/tools/:toolId", schema(toolUpdate), async (r) => {
    const { u, w, row } = await owned(r, "tools", "tool:manage");
    const data = toolUpdate.parse(r.body);
    const input = await prepare(data, context(w));
    return sql.begin(async (tx) => {
      const [saved] =
        await tx`UPDATE tools SET name=${data.name},description=${data.description},kind=${data.config.kind},config=${tx.json(data.config)},input_schema=${tx.json(input as never)},enabled=${data.enabled},public_access=${data.publicAccess},timeout_ms=${data.timeoutMs},revision=revision+1 WHERE id=${row.id} AND revision=${data.revision} RETURNING revision`;
      if (!saved)
        throw new HttpError(409, "Tool changed; reload before saving");
      await audit(tx, r, u.id, "tool.updated", row.id, w.organization_id, w.id);
      return { id: row.id, revision: saved.revision };
    });
  });
  app.delete("/tools/:toolId", async (r) => {
    const { u, w, row } = await owned(r, "tools", "tool:manage");
    await sql.begin(async (tx) => {
      await tx`UPDATE tools SET archived_at=now(),enabled=false,revision=revision+1 WHERE id=${row.id}`;
      await audit(
        tx,
        r,
        u.id,
        "tool.archived",
        row.id,
        w.organization_id,
        w.id,
      );
    });
    return { ok: true };
  });
  app.post(
    "/tools/:toolId/test",
    {
      ...schema(executeToolInput),
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (r) => {
      const { u, w, row } = await owned(r, "tools", "tool:execute");
      const data = executeToolInput.parse(r.body);
      const controller = new AbortController();
      const abort = () => controller.abort();
      r.raw.on("aborted", abort);
      try {
        return await executeTool(
          row.id,
          data.arguments,
          { ...context(w), userId: u.id },
          controller.signal,
        );
      } finally {
        r.raw.off("aborted", abort);
      }
    },
  );
  app.get("/conversations/:conversationId/tool-executions", async (r) => {
    const u = await actor(r);
    const [c] =
      await sql`SELECT id,workspace_id,organization_id FROM conversations WHERE id=${id(params(r).conversationId)}`;
    if (!c) throw new HttpError(404, "Conversation not found");
    await workspaceAccess(u.id, c.workspace_id, "conversation:view");
    await workspaceAccess(u.id, c.workspace_id, "tool:read");
    return sql`SELECT te.* FROM tool_executions te JOIN agent_runs ar ON ar.id=te.run_id WHERE ar.conversation_id=${c.id} AND te.workspace_id=${c.workspace_id} AND te.organization_id=${c.organization_id} ORDER BY te.started_at LIMIT 250`;
  });
  app.get("/workspaces/:workspaceId/tool-executions", async (r) => {
    const u = await actor(r);
    const w = await workspaceAccess(
      u.id,
      id(params(r).workspaceId),
      "tool:read",
    );
    return sql`SELECT id,tool_id,tool_name,tool_revision,run_id,status,error_code,duration_ms,started_at,finished_at,arguments,result FROM tool_executions WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} ORDER BY started_at DESC LIMIT 50`;
  });
  app.get("/workspaces/:workspaceId/mcp-connectors", async (r) => {
    const u = await actor(r);
    const w = await workspaceAccess(
      u.id,
      id(params(r).workspaceId),
      "tool:manage",
    );
    return sql`SELECT * FROM mcp_connectors WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} ORDER BY name`;
  });
  app.post(
    "/workspaces/:workspaceId/mcp-connectors",
    schema(connectorInput),
    async (r, reply) => {
      const u = await actor(r);
      const w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "tool:manage",
      );
      const data = connectorInput.parse(r.body);
      validateToolUrl(data.url);
      await toolSecret(data.secretId, context(w));
      const connectorId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`INSERT INTO mcp_connectors(id,workspace_id,organization_id,name,url,secret_id,enabled) VALUES (${connectorId},${w.id},${w.organization_id},${data.name},${data.url},${data.secretId},${data.enabled})`;
        await audit(
          tx,
          r,
          u.id,
          "mcp.created",
          connectorId,
          w.organization_id,
          w.id,
        );
      });
      return reply.code(201).send({ id: connectorId, revision: 1 });
    },
  );
  app.put(
    "/mcp-connectors/:connectorId",
    schema(connectorUpdate),
    async (r) => {
      const { u, w, row } = await owned(r, "mcp_connectors", "tool:manage");
      const data = connectorUpdate.parse(r.body);
      validateToolUrl(data.url);
      await toolSecret(data.secretId, context(w));
      return sql.begin(async (tx) => {
        const [saved] =
          await tx`UPDATE mcp_connectors SET name=${data.name},url=${data.url},secret_id=${data.secretId},enabled=${data.enabled},capabilities='{}'::jsonb,discovered_at=NULL,revision=revision+1 WHERE id=${row.id} AND revision=${data.revision} RETURNING revision`;
        if (!saved)
          throw new HttpError(409, "Connector changed; reload before saving");
        await audit(
          tx,
          r,
          u.id,
          "mcp.updated",
          row.id,
          w.organization_id,
          w.id,
        );
        return { id: row.id, revision: saved.revision };
      });
    },
  );
  app.post("/mcp-connectors/:connectorId/discover", async (r) => {
    const { u, w, row } = await owned(r, "mcp_connectors", "tool:manage");
    const c = await connectorFor(row.id, context(w));
    const capabilities = await discoverMcp(
      c,
      context(w),
      AbortSignal.timeout(15000),
    );
    await sql.begin(async (tx) => {
      const [saved] =
        await tx`UPDATE mcp_connectors SET capabilities=${tx.json(capabilities as never)},discovered_at=now() WHERE id=${row.id} AND revision=${row.revision} AND enabled=true RETURNING id`;
      if (!saved)
        throw new HttpError(409, "Connector changed during discovery");
      await audit(
        tx,
        r,
        u.id,
        "mcp.discovered",
        row.id,
        w.organization_id,
        w.id,
      );
    });
    return capabilities;
  });
}
