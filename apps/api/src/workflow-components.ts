import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { componentInput } from "@agentconnect/schemas/workflow-components";
import { actor, workspaceAccess, audit, HttpError, id, params } from "./app.js";
import { sql } from "./db.js";
export async function registerWorkflowComponentRoutes(app: FastifyInstance) {
  async function owned(
    r: FastifyRequest,
    cap: "workflow:read" | "workflow:manage",
  ) {
    const u = await actor(r);
    const [c] =
      await sql`SELECT * FROM workflow_components WHERE id=${id(params(r).componentId)} AND archived_at IS NULL`;
    if (!c) throw new HttpError(404, "Component unavailable");
    await workspaceAccess(u.id, c.workspace_id, cap);
    return { u, c };
  }
  async function references(
    data: z.infer<typeof componentInput>,
    workspace: string,
    org: string,
  ) {
    for (const n of data.graph.nodes) {
      if (n.data.agentVersionId) {
        const [v] =
          await sql`SELECT id FROM agent_versions WHERE id=${n.data.agentVersionId} AND workspace_id=${workspace} AND organization_id=${org}`;
        if (!v)
          throw new HttpError(400, "Select an agent version in this workspace");
      }
      if (n.data.toolId) {
        const [t] =
          await sql`SELECT id FROM tools WHERE id=${n.data.toolId} AND workspace_id=${workspace} AND organization_id=${org} AND archived_at IS NULL`;
        if (!t) throw new HttpError(400, "Select a tool in this workspace");
      }
    }
  }
  app.get("/workspaces/:workspaceId/workflow-components", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "workflow:read",
      );
    return sql`SELECT c.id,c.name,c.description,c.revision,v.graph FROM workflow_components c JOIN workflow_component_versions v ON v.component_id=c.id AND v.version=c.revision WHERE c.workspace_id=${w.id} AND c.organization_id=${w.organization_id} AND c.archived_at IS NULL ORDER BY c.name LIMIT 100`;
  });
  app.post(
    "/workspaces/:workspaceId/workflow-components",
    { bodyLimit: 200000 },
    async (r, reply) => {
      const u = await actor(r),
        w = await workspaceAccess(
          u.id,
          id(params(r).workspaceId),
          "workflow:manage",
        ),
        data = componentInput.parse(r.body),
        componentId = randomUUID();
      await references(data, w.id, w.organization_id);
      await sql.begin(async (tx) => {
        await tx`SELECT id FROM workspaces WHERE id=${w.id} FOR UPDATE`;
        const [count] =
          await tx`SELECT count(*)::int AS n FROM workflow_components WHERE workspace_id=${w.id} AND archived_at IS NULL`;
        if (count!.n >= 100)
          throw new HttpError(
            409,
            "Archive an unused component before adding another",
          );
        await tx`INSERT INTO workflow_components(id,workspace_id,organization_id,name,description,created_by) VALUES(${componentId},${w.id},${w.organization_id},${data.name},${data.description},${u.id})`;
        await tx`INSERT INTO workflow_component_versions(component_id,version,graph) VALUES(${componentId},1,${tx.json(data.graph)})`;
        await audit(
          tx,
          r,
          u.id,
          "workflow.component.created",
          componentId,
          w.organization_id,
          w.id,
        );
      });
      return reply.code(201).send({ id: componentId, revision: 1 });
    },
  );
  app.post(
    "/workflow-components/:componentId/versions",
    { bodyLimit: 200000 },
    async (r, reply) => {
      const { u, c } = await owned(r, "workflow:manage"),
        data = componentInput.parse(r.body),
        revision = z
          .object({ revision: z.number().int().positive() })
          .parse(r.body).revision;
      await references(data, c.workspace_id, c.organization_id);
      const result = await sql.begin(async (tx) => {
        const [saved] =
          await tx`UPDATE workflow_components SET name=${data.name},description=${data.description},revision=revision+1,updated_at=now() WHERE id=${c.id} AND revision=${revision} AND archived_at IS NULL RETURNING revision`;
        if (!saved)
          throw new HttpError(
            409,
            "Component changed; reload before creating a version",
          );
        await tx`INSERT INTO workflow_component_versions(component_id,version,graph) VALUES(${c.id},${saved.revision},${tx.json(data.graph)})`;
        await audit(
          tx,
          r,
          u.id,
          "workflow.component.versioned",
          c.id,
          c.organization_id,
          c.workspace_id,
        );
        return { id: c.id, revision: saved.revision };
      });
      return reply.code(201).send(result);
    },
  );
  app.get("/workflow-components/:componentId/versions", async (r) => {
    const { c } = await owned(r, "workflow:read");
    return sql`SELECT version,graph,created_at FROM workflow_component_versions WHERE component_id=${c.id} ORDER BY version DESC LIMIT 100`;
  });
  app.delete("/workflow-components/:componentId", async (r) => {
    const { u, c } = await owned(r, "workflow:manage");
    await sql.begin(async (tx) => {
      await tx`UPDATE workflow_components SET archived_at=now() WHERE id=${c.id}`;
      await audit(
        tx,
        r,
        u.id,
        "workflow.component.archived",
        c.id,
        c.organization_id,
        c.workspace_id,
      );
    });
    return { ok: true };
  });
}
