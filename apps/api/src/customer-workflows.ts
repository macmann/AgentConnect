import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentConfig, type AgentConfig } from "@agentconnect/schemas/agents";
import { workflowGraph } from "@agentconnect/schemas/workflows";
import { conversationAccess } from "./channels.js";
import { actor, workspaceAccess, id, params } from "./app.js";
import { sql } from "./db.js";
import { workflowPresentation } from "@agentconnect/schemas/workflow-results";
import { HttpError } from "./http-error.js";
import { validateWorkflowDependencies } from "./workflow-runtime.js";

export async function validateCustomerActions(
  c: AgentConfig,
  wid: string,
  org: string,
  publicAccess = false,
) {
  for (const action of c.quickActions.filter(
    (a) => a.behavior === "workflow",
  )) {
    if (!action.workflowVersionId)
      throw new HttpError(
        400,
        "Choose a published workflow for " + action.label,
      );
    if (
      new Set(action.workflowFields?.map((f) => f.name)).size !==
      (action.workflowFields?.length ?? 0)
    )
      throw new HttpError(400, "Workflow input names must be unique");
    const [v] =
      await sql`SELECT v.graph FROM workflow_versions v JOIN workflows w ON w.id=v.workflow_id WHERE v.id=${action.workflowVersionId} AND v.workspace_id=${wid} AND v.organization_id=${org} AND w.archived_at IS NULL`;
    if (!v) throw new HttpError(400, "Published workflow is unavailable");
    await validateWorkflowDependencies(workflowGraph.parse(v.graph), {
      workspaceId: wid,
      organizationId: org,
      publicAccess,
    });
  }
}

export async function registerCustomerWorkflows(app: FastifyInstance) {
  app.get("/workspaces/:workspaceId/customer-workflows", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(u.id, id(params(r).workspaceId));
    return sql`SELECT v.id,v.name,v.version FROM workflow_versions v JOIN workflows w ON w.id=v.workflow_id WHERE v.workspace_id=${w.id} AND v.organization_id=${w.organization_id} AND w.archived_at IS NULL ORDER BY v.name,v.version DESC LIMIT 200`;
  });
  for (const channel of ["deployments", "widgets"]) {
    const base = `/public/${channel}/:deploymentId/conversations/:conversationId/workflows`;
    app.get(base, async (r) => {
      const { c } = await conversationAccess(r, true);
      return sql`SELECT id,customer_action_id,status,created_at,finished_at FROM workflow_runs WHERE conversation_id=${c.id} ORDER BY (status IN ('queued','running','waiting')) DESC,created_at DESC LIMIT 30`;
    });
    app.get(base + "/:runId", async (r) => {
      const { c } = await conversationAccess(r, true);
      const [run] =
        await sql`SELECT id,status,output,error_code,graph_snapshot,customer_action_id FROM workflow_runs WHERE id=${id(params(r).runId)} AND conversation_id=${c.id}`;
      if (!run) throw new HttpError(404, "Workflow unavailable");
      const steps =
        await sql`SELECT node_id,label,status,attempts,retry_at FROM workflow_node_runs WHERE run_id=${run.id} ORDER BY started_at,node_id`;
      const graph = workflowGraph.parse(run.graph_snapshot),
        output = graph.nodes.find((n) => n.type === "output")!;
      const name =
        agentConfig
          .parse(c.config_snapshot)
          .quickActions.find((a) => a.id === run.customer_action_id)?.label ??
        "Workflow";
      return {
        id: run.id,
        status: run.status,
        output: run.output,
        error_code: run.error_code,
        name,
        steps,
        resultTitle: output.data.resultTitle || "Result",
        resultSummary: output.data.resultSummary,
        resultFormat: output.data.resultFormat,
        presentation:
          run.status === "completed"
            ? workflowPresentation(run.output, output.data.resultFormat)
            : undefined,
        progress: {
          completed: steps.filter((s) => s.status === "completed").length,
          active: steps
            .filter((s) => s.status === "running")
            .map((s) => s.label),
        },
      };
    });
    app.post(
      base,
      { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
      async (r, reply) => {
        const { c } = await conversationAccess(r, true);
        const data = z
          .strictObject({
            actionId: z.string().max(64),
            values: z
              .record(
                z.string(),
                z.union([
                  z.string().max(4000),
                  z.number().finite(),
                  z.boolean(),
                ]),
              )
              .default({}),
            requestId: z.uuid(),
          })
          .parse(r.body);
        const config = agentConfig.parse(c.config_snapshot),
          action = config.quickActions.find(
            (a) => a.id === data.actionId && a.behavior === "workflow",
          );
        if (!action?.workflowVersionId)
          throw new HttpError(404, "Workflow action unavailable");
        const fields = action.workflowFields ?? [],
          names = new Set(fields.map((f) => f.name));
        if (Object.keys(data.values).some((k) => !names.has(k)))
          throw new HttpError(400, "Unknown workflow input");
        for (const f of fields) {
          const value = data.values[f.name];
          if (value === undefined || value === "") {
            if (f.required) throw new HttpError(400, f.label + " is required");
            continue;
          }
          const valid =
            f.type === "number"
              ? typeof value === "number" &&
                (f.min === undefined || value >= f.min) &&
                (f.max === undefined || value <= f.max)
              : f.type === "checkbox"
                ? typeof value === "boolean" && (!f.required || value)
                : typeof value === "string" &&
                  (f.type !== "select" || !!f.options?.includes(value)) &&
                  (f.type !== "email" || z.email().safeParse(value).success) &&
                  (f.type !== "date" || z.iso.date().safeParse(value).success);
          if (!valid) throw new HttpError(400, f.label + " is invalid");
        }
        await validateCustomerActions(
          { ...config, quickActions: [action] },
          c.workspace_id,
          c.organization_id,
          true,
        );
        const [v] =
          await sql`SELECT * FROM workflow_versions WHERE id=${action.workflowVersionId} AND workspace_id=${c.workspace_id} AND organization_id=${c.organization_id}`;
        const input = JSON.stringify({
          request: action.message,
          ...Object.fromEntries(
            Object.entries(data.values).sort(([a], [b]) => a.localeCompare(b)),
          ),
        });
        const runStatus = await sql.begin(async (tx) => {
          const [locked] =
            await tx`SELECT conversation_mode FROM conversations WHERE id=${c.id} FOR UPDATE`;
          if (locked?.conversation_mode !== "ai")
            throw new HttpError(
              409,
              "Wait until human support returns this conversation to AI",
            );
          const [existing] =
            await tx`SELECT id,conversation_id,customer_action_id,input,status FROM workflow_runs WHERE id=${data.requestId}`;
          if (existing) {
            if (
              existing.conversation_id !== c.id ||
              existing.customer_action_id !== action.id ||
              existing.input !== input
            )
              throw new HttpError(
                409,
                "Use a new request ID for changed workflow inputs",
              );
            return existing.status;
          }
          await tx`SELECT id FROM workspaces WHERE id=${c.workspace_id} FOR UPDATE`;
          const [available] =
            await tx`SELECT id FROM workflows WHERE id=${v!.workflow_id} AND archived_at IS NULL FOR SHARE`;
          if (!available) throw new HttpError(404, "Workflow unavailable");
          const [active] =
            await tx`SELECT count(*)::int AS n FROM workflow_runs WHERE workspace_id=${c.workspace_id} AND status IN ('queued','running','waiting')`;
          if (active!.n >= 20)
            throw new HttpError(
              429,
              "Too many active workflow runs; retry later",
            );
          await tx`INSERT INTO workflow_runs(id,workflow_id,version_id,workspace_id,organization_id,user_id,graph_snapshot,input,status,conversation_id,customer_action_id) VALUES(${data.requestId},${v!.workflow_id},${v!.id},${c.workspace_id},${c.organization_id},NULL,${tx.json(v!.graph)},${input},'queued',${c.id},${action.id})`;
          return "queued";
        });
        return reply.code(201).send({ id: data.requestId, status: runStatus });
      },
    );
  }
}
