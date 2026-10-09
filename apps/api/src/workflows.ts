import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  workflowInput,
  workflowUpdate,
  workflowRunInput,
  workflowApprovalInput,
  workflowGraph,
  analyzeWorkflow,
} from "@agentconnect/schemas/workflows";
import { actor, workspaceAccess, audit, HttpError, id, params } from "./app.js";
import { sql } from "./db.js";
import {
  validateWorkflowDependencies,
  WorkflowError,
} from "./workflow-runtime.js";
async function owned(
  r: FastifyRequest,
  cap: "workflow:read" | "workflow:manage" | "workflow:execute",
) {
  const u = await actor(r);
  const [w] =
    await sql`SELECT * FROM workflows WHERE id=${id(params(r).workflowId)} AND archived_at IS NULL`;
  if (!w) throw new HttpError(404, "Workflow unavailable");
  await workspaceAccess(u.id, w.workspace_id, cap);
  return { u, w };
}
async function ownedRun(
  r: FastifyRequest,
  cap: "workflow:read" | "workflow:execute" | "workflow:approve",
) {
  const u = await actor(r);
  const [run] =
    await sql`SELECT * FROM workflow_runs WHERE id=${id(params(r).runId)}`;
  if (!run) throw new HttpError(404, "Run unavailable");
  await workspaceAccess(u.id, run.workspace_id, cap);
  return { u, run };
}
export async function registerWorkflowRoutes(app: FastifyInstance) {
  const schema = (body: z.ZodType) => ({
    schema: { body: z.toJSONSchema(body, { io: "input", target: "draft-7" }) },
    bodyLimit: 200000,
  });
  app.get("/workspaces/:workspaceId/workflows", async (r) => {
    const u = await actor(r);
    const w = await workspaceAccess(
      u.id,
      id(params(r).workspaceId),
      "workflow:read",
    );
    return sql`SELECT id,name,description,revision,updated_at FROM workflows WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} AND archived_at IS NULL ORDER BY updated_at DESC`;
  });
  app.get("/workspaces/:workspaceId/workflow-agents", async (r) => {
    const u = await actor(r);
    const w = await workspaceAccess(
      u.id,
      id(params(r).workspaceId),
      "workflow:read",
    );
    return sql`SELECT v.id,v.agent_id,v.name,v.version FROM agent_versions v JOIN agents a ON a.id=v.agent_id WHERE v.workspace_id=${w.id} AND v.organization_id=${w.organization_id} AND a.archived_at IS NULL ORDER BY v.name,v.version DESC`;
  });
  app.post(
    "/workspaces/:workspaceId/workflows",
    schema(workflowInput),
    async (r, reply) => {
      const u = await actor(r);
      const w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "workflow:manage",
      );
      const data = workflowInput.parse(r.body),
        workflowId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`INSERT INTO workflows(id,workspace_id,organization_id,name,description,draft_graph,created_by) VALUES (${workflowId},${w.id},${w.organization_id},${data.name},${data.description},${tx.json(data.graph)},${u.id})`;
        await audit(
          tx,
          r,
          u.id,
          "workflow.created",
          workflowId,
          w.organization_id,
          w.id,
        );
      });
      return reply.code(201).send({
        id: workflowId,
        revision: 1,
        validation: analyzeWorkflow(data.graph).errors,
      });
    },
  );
  app.get(
    "/workflows/:workflowId",
    async (r) => (await owned(r, "workflow:read")).w,
  );
  app.put("/workflows/:workflowId", schema(workflowUpdate), async (r) => {
    const { u, w } = await owned(r, "workflow:manage");
    const data = workflowUpdate.parse(r.body);
    return sql.begin(async (tx) => {
      const [saved] =
        await tx`UPDATE workflows SET name=${data.name},description=${data.description},draft_graph=${tx.json(data.graph)},revision=revision+1,updated_at=now() WHERE id=${w.id} AND revision=${data.revision} RETURNING revision`;
      if (!saved)
        throw new HttpError(409, "Workflow changed; reload before saving");
      await audit(
        tx,
        r,
        u.id,
        "workflow.updated",
        w.id,
        w.organization_id,
        w.workspace_id,
      );
      return {
        id: w.id,
        revision: saved.revision,
        validation: analyzeWorkflow(data.graph).errors,
      };
    });
  });
  app.post("/workflows/:workflowId/validate", async (r) => {
    const { w } = await owned(r, "workflow:manage");
    const graph = workflowGraph.parse(w.draft_graph),
      errors = analyzeWorkflow(graph).errors;
    if (!errors.length)
      try {
        await validateWorkflowDependencies(graph, {
          workspaceId: w.workspace_id,
          organizationId: w.organization_id,
        });
      } catch (e) {
        errors.push(
          e instanceof WorkflowError
            ? e.code
            : "A selected agent, model, credential, knowledge base or tool is unavailable",
        );
      }
    return { valid: !errors.length, errors };
  });
  app.post(
    "/workflows/:workflowId/publish",
    schema(z.object({ revision: z.number().int().min(1) })),
    async (r, reply) => {
      const { u, w } = await owned(r, "workflow:manage");
      const data = z
        .object({ revision: z.number().int().min(1) })
        .parse(r.body);
      const published = await sql.begin(async (tx) => {
        const [locked] =
          await tx`SELECT * FROM workflows WHERE id=${w.id} FOR UPDATE`;
        if (!locked || locked.revision !== data.revision)
          throw new HttpError(
            409,
            "Workflow changed; reload before publishing",
          );
        const graph = workflowGraph.parse(locked.draft_graph);
        await validateWorkflowDependencies(graph, {
          workspaceId: w.workspace_id,
          organizationId: w.organization_id,
        });
        const [previous] =
          await tx`SELECT COALESCE(max(version),0) AS latest FROM workflow_versions WHERE workflow_id=${w.id}`;
        const version = Number(previous!.latest) + 1,
          versionId = randomUUID();
        await tx`INSERT INTO workflow_versions(id,workflow_id,workspace_id,organization_id,version,name,graph,published_by) VALUES (${versionId},${w.id},${w.workspace_id},${w.organization_id},${version},${locked.name},${tx.json(graph)},${u.id})`;
        await audit(
          tx,
          r,
          u.id,
          "workflow.published",
          versionId,
          w.organization_id,
          w.workspace_id,
        );
        return { id: versionId, version };
      });
      return reply.code(201).send(published);
    },
  );
  app.get("/workflows/:workflowId/versions", async (r) => {
    const { w } = await owned(r, "workflow:read");
    return sql`SELECT id,version,name,graph,published_at FROM workflow_versions WHERE workflow_id=${w.id} ORDER BY version DESC`;
  });
  app.post(
    "/workflows/:workflowId/restore/:versionId",
    schema(z.object({ revision: z.number().int().min(1) })),
    async (r) => {
      const { u, w } = await owned(r, "workflow:manage");
      const data = z
        .object({ revision: z.number().int().min(1) })
        .parse(r.body);
      const [v] =
        await sql`SELECT name,graph FROM workflow_versions WHERE id=${id(params(r).versionId)} AND workflow_id=${w.id}`;
      if (!v) throw new HttpError(404, "Version unavailable");
      return sql.begin(async (tx) => {
        const [saved] =
          await tx`UPDATE workflows SET name=${v.name},draft_graph=${tx.json(v.graph)},revision=revision+1,updated_at=now() WHERE id=${w.id} AND revision=${data.revision} RETURNING revision`;
        if (!saved)
          throw new HttpError(409, "Workflow changed; reload before restoring");
        await audit(
          tx,
          r,
          u.id,
          "workflow.restored",
          w.id,
          w.organization_id,
          w.workspace_id,
        );
        return { id: w.id, revision: saved.revision };
      });
    },
  );
  app.delete("/workflows/:workflowId", async (r) => {
    const { u, w } = await owned(r, "workflow:manage");
    await sql.begin(async (tx) => {
      await tx`UPDATE workflows SET archived_at=now() WHERE id=${w.id}`;
      await tx`UPDATE workflow_runs SET cancel_requested=true,finished_at=CASE WHEN status IN ('queued','waiting') THEN now() ELSE finished_at END,status=CASE WHEN status IN ('queued','waiting') THEN 'cancelled' ELSE status END WHERE workflow_id=${w.id} AND status IN ('queued','running','waiting')`;
      await audit(
        tx,
        r,
        u.id,
        "workflow.archived",
        w.id,
        w.organization_id,
        w.workspace_id,
      );
    });
    return { ok: true };
  });
  app.post(
    "/workflows/:workflowId/runs",
    {
      ...schema(workflowRunInput),
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (r, reply) => {
      const { u, w } = await owned(r, "workflow:execute");
      const data = workflowRunInput.parse(r.body);
      let graph;
      if (data.versionId) {
        const [v] =
          await sql`SELECT graph FROM workflow_versions WHERE id=${data.versionId} AND workflow_id=${w.id}`;
        if (!v) throw new HttpError(404, "Version unavailable");
        graph = workflowGraph.parse(v.graph);
      } else {
        if (data.revision !== w.revision)
          throw new HttpError(
            409,
            "Save and reload the current draft before testing",
          );
        graph = workflowGraph.parse(w.draft_graph);
      }
      await validateWorkflowDependencies(graph, {
        workspaceId: w.workspace_id,
        organizationId: w.organization_id,
      });
      const runId = randomUUID();
      await sql.begin(async (tx) => {
        const [active] =
          await tx`SELECT id FROM workflows WHERE id=${w.id} AND archived_at IS NULL FOR SHARE`;
        if (!active) throw new HttpError(404, "Workflow unavailable");
        await tx`SELECT id FROM workspaces WHERE id=${w.workspace_id} FOR UPDATE`;
        const [count] =
          await tx`SELECT count(*) AS n FROM workflow_runs WHERE workspace_id=${w.workspace_id} AND status IN ('queued','running','waiting')`;
        if (Number(count!.n) >= 20)
          throw new HttpError(
            429,
            "Workspace has too many active workflow runs",
          );
        await tx`INSERT INTO workflow_runs(id,workflow_id,version_id,workspace_id,organization_id,user_id,graph_snapshot,input,status) VALUES (${runId},${w.id},${data.versionId ?? null},${w.workspace_id},${w.organization_id},${u.id},${tx.json(graph)},${data.input},'queued')`;
        await audit(
          tx,
          r,
          u.id,
          "workflow.run_queued",
          runId,
          w.organization_id,
          w.workspace_id,
        );
      });
      return reply.code(202).send({ id: runId, status: "queued" });
    },
  );
  app.get("/workflows/:workflowId/runs", async (r) => {
    const { w } = await owned(r, "workflow:read");
    return sql`SELECT id,version_id,status,error_code,created_at,finished_at FROM workflow_runs WHERE workflow_id=${w.id} ORDER BY created_at DESC LIMIT 50`;
  });
  app.get("/workflow-runs/:runId", async (r) => {
    const { run } = await ownedRun(r, "workflow:read");
    const nodes =
      await sql`SELECT * FROM workflow_node_runs WHERE run_id=${run.id} ORDER BY started_at,node_id`;
    const approvals =
      await sql`SELECT * FROM workflow_approvals WHERE run_id=${run.id} ORDER BY created_at`;
    const tools =
      await sql`SELECT id,tool_name,status,error_code,result,arguments,duration_ms,workflow_node_id FROM tool_executions WHERE workflow_run_id=${run.id} ORDER BY started_at`;
    const visible = { ...run };
    delete visible.lease_owner;
    delete visible.lease_expires_at;
    return { ...visible, nodes, approvals, tools };
  });
  app.post("/workflow-runs/:runId/cancel", async (r) => {
    const { u, run } = await ownedRun(r, "workflow:execute");
    await sql.begin(async (tx) => {
      const [changed] =
        await tx`UPDATE workflow_runs SET cancel_requested=true,status=CASE WHEN status IN ('queued','waiting') THEN 'cancelled' ELSE status END,finished_at=CASE WHEN status IN ('queued','waiting') THEN now() ELSE finished_at END WHERE id=${run.id} AND status IN ('queued','running','waiting') RETURNING id`;
      if (!changed) throw new HttpError(409, "Run is already finished");
      await audit(
        tx,
        r,
        u.id,
        "workflow.cancel_requested",
        run.id,
        run.organization_id,
        run.workspace_id,
      );
    });
    return { ok: true };
  });
  app.post(
    "/workflow-runs/:runId/approval",
    schema(workflowApprovalInput),
    async (r) => {
      const { u, run } = await ownedRun(r, "workflow:approve");
      const data = workflowApprovalInput.parse(r.body);
      if (
        data.editedInput !== undefined &&
        Buffer.byteLength(JSON.stringify(data.editedInput)) > 16000
      )
        throw new HttpError(400, "Edited input exceeds the limit");
      await sql.begin(async (tx) => {
        const [locked] =
          await tx`SELECT status FROM workflow_runs WHERE id=${run.id} FOR UPDATE`;
        if (locked?.status !== "waiting")
          throw new HttpError(409, "Run is not waiting for approval");
        const [approval] =
          await tx`UPDATE workflow_approvals SET decision=${data.decision},comment=${data.comment},edited_input=${data.editedInput === undefined ? null : tx.json(data.editedInput as never)},decided_by=${u.id},decided_at=now() WHERE run_id=${run.id} AND decision='pending' RETURNING id`;
        if (!approval)
          throw new HttpError(409, "Approval has already been decided");
        await tx`UPDATE workflow_runs SET status=${data.decision === "approved" ? "queued" : "rejected"},finished_at=${data.decision === "rejected" ? new Date() : null} WHERE id=${run.id}`;
        await audit(
          tx,
          r,
          u.id,
          "workflow.approval_" + data.decision,
          approval.id,
          run.organization_id,
          run.workspace_id,
        );
      });
      return { ok: true };
    },
  );
}
