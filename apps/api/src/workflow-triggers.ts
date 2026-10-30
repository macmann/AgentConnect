import { storedWorkflowGraph } from "./workflow-v2.js";
import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  workflowGraph,
  normalizeWorkflowInput,
} from "@agentconnect/schemas/workflows";
import { sql } from "./db.js";
import { actor, workspaceAccess, audit, HttpError, id, params } from "./app.js";
import { digest } from "./security.js";
import { ProviderError } from "@agentconnect/provider-sdk";
import { KnowledgeError } from "@agentconnect/rag/parsers";
import { ToolError } from "./tool-runtime.js";
import { config } from "./config.js";
import {
  validateWorkflowDependencies,
  WorkflowError,
} from "./workflow-runtime.js";
import {
  platformKey,
  requirePlatformScope,
  platformRateLimit,
} from "./platform-auth.js";

export function nextWorkflowOccurrence(
  cron: string,
  timezone: string,
  after = new Date(),
) {
  try {
    if (cron.trim().split(/\s+/).length !== 5 || /[Hh]/.test(cron))
      throw new Error();
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(after);
    return CronExpressionParser.parse(cron, {
      tz: timezone,
      currentDate: after,
      endDate: new Date(after.getTime() + 366 * 86400000 * 5),
    })
      .next()
      .toDate();
  } catch {
    throw new HttpError(
      400,
      "Enter a valid five-field cron schedule and IANA timezone with an occurrence in the next five years",
    );
  }
}
export function workflowInputText(
  graph: ReturnType<typeof workflowGraph.parse>,
  input: unknown,
) {
  try {
    return normalizeWorkflowInput(graph, input);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
}
const scheduleInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
  versionId: z.uuid(),
  cron: z.string().trim().min(9).max(100),
  timezone: z.string().min(1).max(100),
  input: z.union([
    z.string().min(1).max(12000),
    z.record(z.string(), z.json()),
  ]),
  enabled: z.boolean().default(true),
  overlapPolicy: z.enum(["skip", "allow"]).default("skip"),
  missedPolicy: z.enum(["skip", "run_once"]).default("skip"),
});
export const workflowApiInvocation = z.strictObject({
  versionId: z.uuid().optional(),
  input: z.union([
    z.string().min(1).max(12000),
    z.record(z.string(), z.json()),
  ]),
});
async function owned(
  r: FastifyRequest,
  capability: "workflow:read" | "workflow:manage",
) {
  const u = await actor(r);
  const [w] =
    await sql`SELECT * FROM workflows WHERE id=${id(params(r).workflowId)} AND archived_at IS NULL`;
  if (!w) throw new HttpError(404, "Workflow unavailable");
  await workspaceAccess(u.id, w.workspace_id, capability);
  return { u, w };
}
export async function registerWorkflowTriggers(app: FastifyInstance) {
  app.get("/workflows/:workflowId/schedules", async (r) => {
    const { w } = await owned(r, "workflow:read");
    return sql`SELECT * FROM workflow_schedules WHERE workflow_id=${w.id} ORDER BY created_at DESC`;
  });
  app.post("/workflows/:workflowId/schedules/preview", async (r) => {
    await owned(r, "workflow:read");
    const data = z
      .object({ cron: z.string().max(100), timezone: z.string().max(100) })
      .parse(r.body);
    const times: string[] = [];
    let after = new Date();
    for (let n = 0; n < 5; n++) {
      after = nextWorkflowOccurrence(data.cron, data.timezone, after);
      times.push(after.toISOString());
    }
    return { times };
  });
  const save = async (r: FastifyRequest, updating: boolean) => {
    const { u, w } = await owned(r, "workflow:manage");
    await workspaceAccess(u.id, w.workspace_id, "workflow:execute");
    const data = (
      updating
        ? scheduleInput.extend({ revision: z.number().int().min(1) })
        : scheduleInput
    ).parse(r.body);
    const [v] =
      await sql`SELECT graph FROM workflow_versions WHERE id=${data.versionId} AND workflow_id=${w.id}`;
    if (!v)
      throw new HttpError(400, "Select a published version of this workflow");
    const graph = storedWorkflowGraph(v.graph),
      input = workflowInputText(graph, data.input);
    await validateWorkflowDependencies(
      graph,
      {
        workspaceId: w.workspace_id,
        organizationId: w.organization_id,
        userId: u.id,
      },
      true,
    );
    const next = nextWorkflowOccurrence(data.cron, data.timezone),
      scheduleId = updating ? id(params(r).scheduleId) : randomUUID();
    await sql.begin(async (tx) => {
      const [live] =
        await tx`SELECT id FROM workflows WHERE id=${w.id} AND archived_at IS NULL FOR UPDATE`;
      if (!live) throw new HttpError(404, "Workflow unavailable");
      if (updating) {
        const [saved] =
          await tx`UPDATE workflow_schedules SET name=${data.name},version_id=${data.versionId},cron=${data.cron},timezone=${data.timezone},input=${input},enabled=${data.enabled},overlap_policy=${data.overlapPolicy},missed_policy=${data.missedPolicy},next_run_at=${next},last_error=NULL,created_by=${u.id},revision=revision+1,updated_at=now() WHERE id=${scheduleId} AND workflow_id=${w.id} AND revision=${"revision" in data ? Number(data.revision) : 0} RETURNING id`;
        if (!saved)
          throw new HttpError(409, "Schedule changed; reload before saving");
      } else {
        const [count] =
          await tx`SELECT count(*) AS n FROM workflow_schedules WHERE workflow_id=${w.id}`;
        if (Number(count!.n) >= 20)
          throw new HttpError(400, "A workflow supports up to 20 schedules");
        await tx`INSERT INTO workflow_schedules(id,workflow_id,workspace_id,organization_id,version_id,name,cron,timezone,input,enabled,overlap_policy,missed_policy,created_by,next_run_at) VALUES (${scheduleId},${w.id},${w.workspace_id},${w.organization_id},${data.versionId},${data.name},${data.cron},${data.timezone},${input},${data.enabled},${data.overlapPolicy},${data.missedPolicy},${u.id},${next})`;
      }
      await audit(
        tx,
        r,
        u.id,
        updating ? "workflow.schedule_updated" : "workflow.schedule_created",
        scheduleId,
        w.organization_id,
        w.workspace_id,
      );
    });
    return { id: scheduleId, nextRunAt: next };
  };
  app.post("/workflows/:workflowId/schedules", async (r, reply) =>
    reply.code(201).send(await save(r, false)),
  );
  app.put("/workflows/:workflowId/schedules/:scheduleId", (r) => save(r, true));
  app.delete("/workflows/:workflowId/schedules/:scheduleId", async (r) => {
    const { u, w } = await owned(r, "workflow:manage");
    const data = z.object({ revision: z.number().int().min(1) }).parse(r.body);
    await sql.begin(async (tx) => {
      const [saved] =
        await tx`UPDATE workflow_schedules SET enabled=false,revision=revision+1,updated_at=now() WHERE id=${id(params(r).scheduleId)} AND workflow_id=${w.id} AND revision=${data.revision} RETURNING id`;
      if (!saved)
        throw new HttpError(409, "Schedule changed; reload before pausing");
      await audit(
        tx,
        r,
        u.id,
        "workflow.schedule_paused",
        saved.id,
        w.organization_id,
        w.workspace_id,
      );
    });
    return { ok: true };
  });
  const apiOptions = {
    config: { rateLimit: platformRateLimit },
    schema: { tags: ["Platform API"], security: [{ platformKey: [] }] },
  };
  app.post(
    "/api/v1/workflows/:workflowId/runs",
    {
      ...apiOptions,
      schema: {
        ...apiOptions.schema,
        body: z.toJSONSchema(workflowApiInvocation, {
          io: "input",
          target: "draft-7",
        }),
      },
    },
    async (r, reply) => {
      const key = await platformKey(r),
        workflowId = id(params(r).workflowId);
      requirePlatformScope(key, "workflow:execute", workflowId);
      const data = workflowApiInvocation.parse(r.body);
      const requestKey = z
        .string()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9._:-]+$/)
        .parse(r.headers["idempotency-key"]);
      const fingerprint = digest(
        JSON.stringify({
          versionId: data.versionId ?? null,
          input: canonical(data.input),
        }),
      );
      const [prior] =
        await sql`SELECT id,status,request_fingerprint FROM workflow_runs WHERE api_key_id=${key.id} AND idempotency_key=${requestKey}`;
      if (prior) {
        if (prior.request_fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "Idempotency key was already used with a different request",
          );
        reply
          .header("Cache-Control", "no-store")
          .header(
            "Location",
            `/api/v1/workflows/${workflowId}/runs/${prior.id}`,
          );
        return reply.code(202).send({ id: prior.id, status: prior.status });
      }
      const [v] = data.versionId
        ? await sql`SELECT * FROM workflow_versions WHERE workflow_id=${workflowId} AND id=${data.versionId}`
        : await sql`SELECT * FROM workflow_versions WHERE workflow_id=${workflowId} ORDER BY version DESC LIMIT 1`;
      if (!v)
        throw new HttpError(
          400,
          "Publish a workflow version before invoking it",
        );
      const graph = storedWorkflowGraph(v.graph),
        input = workflowInputText(graph, data.input);
      await validateWorkflowDependencies(
        graph,
        {
          workspaceId: key.workspace_id,
          organizationId: key.organization_id,
          userId: key.created_by,
        },
        true,
      );

      const result = await sql.begin(async (tx) => {
        const [live] =
          await tx`SELECT id FROM workflows WHERE id=${workflowId} AND archived_at IS NULL FOR SHARE`;
        if (!live) throw new HttpError(404, "Workflow unavailable");
        await tx`SELECT id FROM workspaces WHERE id=${key.workspace_id} FOR UPDATE`;
        const [existing] =
          await tx`SELECT id,status,request_fingerprint FROM workflow_runs WHERE api_key_id=${key.id} AND idempotency_key=${requestKey}`;
        if (existing) {
          if (existing.request_fingerprint !== fingerprint)
            throw new HttpError(
              409,
              "Idempotency key was already used with a different request",
            );
          return { id: existing.id, status: existing.status };
        }
        const [count] =
          await tx`SELECT count(*) AS n FROM workflow_runs WHERE workspace_id=${key.workspace_id} AND status IN ('queued','running','waiting')`;
        if (Number(count!.n) >= 20)
          throw new HttpError(
            429,
            "Workspace has too many active workflow runs",
          );
        const runId = randomUUID();
        await tx`INSERT INTO workflow_runs(id,workflow_id,version_id,workspace_id,organization_id,user_id,graph_snapshot,input,status,api_key_id,idempotency_key,request_fingerprint) VALUES (${runId},${workflowId},${v.id},${key.workspace_id},${key.organization_id},${key.created_by},${tx.json(graph)},${input},'queued',${key.id},${requestKey},${fingerprint})`;
        await audit(
          tx,
          r,
          key.created_by,
          "workflow.api_run_queued",
          runId,
          key.organization_id,
          key.workspace_id,
        );
        return { id: runId, status: "queued" };
      });
      reply
        .header("Cache-Control", "no-store")
        .header(
          "Location",
          `/api/v1/workflows/${workflowId}/runs/${result.id}`,
        );
      return reply.code(202).send(result);
    },
  );
  app.get(
    "/api/v1/workflows/:workflowId/runs/:runId",
    apiOptions,
    async (r, reply) => {
      const key = await platformKey(r);
      requirePlatformScope(key, "workflow:execute", id(params(r).workflowId));
      const details =
        z
          .enum(["true", "false"])
          .optional()
          .parse((r.query as Record<string, unknown>).includeDetails) ===
        "true";
      requirePlatformScope(key, "workflow:execute", key.workflow_id!, details);
      const [run] =
        await sql`SELECT id,workflow_id,version_id,status,output,error_code,created_at,started_at,finished_at FROM workflow_runs WHERE id=${id(params(r).runId)} AND api_key_id=${key.id} AND workflow_id=${key.workflow_id!}`;
      if (!run) throw new HttpError(404, "Run unavailable for this key");
      reply.header("Cache-Control", "no-store");
      if (!details) return run;
      const nodes =
        await sql`SELECT node_id,label,kind,status,input,output,error_code,duration_ms,input_tokens,output_tokens,citations,attempts,retry_history FROM workflow_node_runs WHERE run_id=${run.id} ORDER BY started_at,node_id`;
      const tools =
        await sql`SELECT tool_name,status,error_code,result,arguments,duration_ms,workflow_node_id FROM tool_executions WHERE workflow_run_id=${run.id} ORDER BY started_at`;
      return { ...run, nodes, tools };
    },
  );
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}

// The schedule row, workspace quota and occurrence insert commit together. SKIP
// LOCKED allows multiple schedulers without double-enqueuing an occurrence.
export async function processWorkflowSchedules(now = new Date()) {
  return sql.begin(async (tx) => {
    const [candidate] =
      await tx`SELECT s.id,s.workflow_id FROM workflow_schedules s JOIN workflows w ON w.id=s.workflow_id WHERE s.enabled AND s.next_run_at<=${now} AND w.archived_at IS NULL ORDER BY s.next_run_at LIMIT 1`;
    if (!candidate) return false;
    // Match editor/archive lock order: workflow before schedule. Holding this
    // shared lock makes archive wait until enqueue commits, then cancel the run.
    const [live] =
      await tx`SELECT id FROM workflows WHERE id=${candidate.workflow_id} AND archived_at IS NULL FOR SHARE`;
    if (!live) return false;
    const [s] =
      await tx`SELECT * FROM workflow_schedules WHERE id=${candidate.id} AND enabled AND next_run_at<=${now} FOR UPDATE SKIP LOCKED`;
    if (!s) return false;
    const next = nextWorkflowOccurrence(s.cron, s.timezone, now),
      occurrence = new Date(s.next_run_at);
    let error: string | null = null,
      disable = false;
    // A delay beyond one minute is a missed occurrence. Never replay a backlog.
    if (
      s.missed_policy === "skip" &&
      now.getTime() - occurrence.getTime() > 60000
    )
      error = "MISSED_OCCURRENCE_SKIPPED";
    if (!error) {
      try {
        await workspaceAccess(s.created_by, s.workspace_id, "workflow:execute");
        const [user] =
          await tx`SELECT verified_at FROM users WHERE id=${s.created_by}`;
        if (!user || (config.REQUIRE_EMAIL_VERIFICATION && !user.verified_at))
          throw new HttpError(403, "Creator unavailable");
        const [v] =
          await tx`SELECT graph FROM workflow_versions WHERE id=${s.version_id} AND workflow_id=${s.workflow_id}`;
        if (!v) throw new HttpError(400, "Version unavailable");
        const graph = storedWorkflowGraph(v.graph),
          input = workflowInputText(graph, s.input);
        await validateWorkflowDependencies(
          graph,
          {
            workspaceId: s.workspace_id,
            organizationId: s.organization_id,
            userId: s.created_by,
          },
          true,
        );
        await tx`SELECT id FROM workspaces WHERE id=${s.workspace_id} FOR UPDATE`;
        const [counts] =
          await tx`SELECT count(*) AS total,count(*) FILTER(WHERE schedule_id=${s.id}) AS own FROM workflow_runs WHERE workspace_id=${s.workspace_id} AND status IN ('queued','running','waiting')`;
        if (s.overlap_policy === "skip" && Number(counts!.own) > 0)
          error = "OVERLAP_SKIPPED";
        else if (Number(counts!.total) >= 20) error = "WORKSPACE_QUOTA_SKIPPED";
        else
          await tx`INSERT INTO workflow_runs(id,workflow_id,version_id,workspace_id,organization_id,user_id,graph_snapshot,input,status,schedule_id,scheduled_for) VALUES (${randomUUID()},${s.workflow_id},${s.version_id},${s.workspace_id},${s.organization_id},${s.created_by},${tx.json(graph)},${input},'queued',${s.id},${occurrence}) ON CONFLICT DO NOTHING`;
      } catch (e) {
        // Database failures roll back the occurrence, so the next worker can retry.
        if (!(
          e instanceof HttpError ||
          e instanceof WorkflowError ||
          e instanceof ProviderError ||
          e instanceof KnowledgeError ||
          e instanceof ToolError
        ))
          throw e;
        error =
          e instanceof HttpError &&
          (e.statusCode === 403 || e.statusCode === 404)
            ? "SCHEDULE_ACCESS_REVOKED"
            : "SCHEDULE_CONFIGURATION_INVALID";
        disable = true;
      }
    }
    await tx`UPDATE workflow_schedules SET next_run_at=${next},last_run_at=${occurrence},last_error=${error},enabled=CASE WHEN ${disable} THEN false ELSE enabled END,updated_at=now() WHERE id=${s.id}`;
    return true;
  });
}
