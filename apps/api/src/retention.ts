import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { TransactionSql } from "postgres";
import {
  retentionInput,
  retentionRequest,
} from "@agentconnect/schemas/retention";
import { actor, audit, id, params, workspaceAccess } from "./app.js";
import { sql } from "./db.js";
import { HttpError } from "./http-error.js";

export type RetentionPolicy = {
  workspace_id: string;
  organization_id: string;
  revision: number;
  enabled: boolean;
  conversation_days: number | null;
  run_days: number | null;
  artifact_days: number | null;
  connector_days: number | null;
  updated_by: string;
  next_run_at: Date | null;
};
type Query = typeof sql | TransactionSql;
const cutoff = (days: number | null, now: Date) =>
  days === null ? null : new Date(now.getTime() - days * 86400000);
// One transaction handles at most this many roots in each category. Preview counts
// describe the next batch, not an unbounded scan of all historic content.
export const retentionBatchSize = 100;
export async function retentionCandidates(
  tx: Query,
  p: RetentionPolicy,
  now: Date,
) {
  const conversations = cutoff(p.conversation_days, now),
    runs = cutoff(p.run_days, now),
    artifacts = cutoff(p.artifact_days, now),
    connectors = cutoff(p.connector_days, now);
  const scope = tx`c.workspace_id=${p.workspace_id} AND c.organization_id=${p.organization_id} AND c.handoff_status NOT IN ('pending','active') AND NOT EXISTS(SELECT 1 FROM agent_runs r WHERE r.conversation_id=c.id AND r.status='running') AND NOT EXISTS(SELECT 1 FROM tool_executions t JOIN agent_runs r ON r.id=t.run_id WHERE r.conversation_id=c.id AND t.status='running')`;
  const cs = conversations
    ? await tx`SELECT c.id FROM conversations c WHERE ${scope} AND c.last_activity_at<${conversations} ORDER BY c.last_activity_at,c.id LIMIT ${retentionBatchSize}`
    : [];
  const rs = runs
    ? await tx`SELECT r.id,r.conversation_id FROM agent_runs r JOIN conversations c ON c.id=r.conversation_id WHERE ${scope} AND r.status IN ('completed','failed','cancelled') AND r.finished_at<${runs} ORDER BY r.finished_at,r.id LIMIT ${retentionBatchSize}`
    : [];
  const ws = runs
    ? await tx`SELECT id FROM workflow_runs WHERE workspace_id=${p.workspace_id} AND organization_id=${p.organization_id} AND status IN ('completed','failed','cancelled','rejected') AND finished_at<${runs} AND NOT EXISTS(SELECT 1 FROM tool_executions t WHERE t.workflow_run_id=workflow_runs.id AND t.status='running') ORDER BY finished_at,id LIMIT ${retentionBatchSize}`
    : [];
  // Referenced evaluation baselines remain available until their dependents expire.
  const es = runs
    ? await tx`SELECT id FROM evaluation_runs r WHERE workspace_id=${p.workspace_id} AND organization_id=${p.organization_id} AND status IN ('completed','failed','cancelled') AND finished_at<${runs} AND NOT EXISTS(SELECT 1 FROM evaluation_runs d WHERE d.baseline_run_id=r.id) ORDER BY finished_at,id LIMIT ${retentionBatchSize}`
    : [];
  const ss = connectors
    ? await tx`SELECT id FROM connector_syncs WHERE workspace_id=${p.workspace_id} AND organization_id=${p.organization_id} AND status IN ('completed','failed','cancelled') AND finished_at<${connectors} ORDER BY finished_at,id LIMIT ${retentionBatchSize}`
    : [];
  const conversationIds = cs.map((row) => row.id as string);
  const childRuns = conversationIds.length
    ? await tx`SELECT id,conversation_id FROM agent_runs WHERE workspace_id=${p.workspace_id} AND organization_id=${p.organization_id} AND conversation_id=ANY(${conversationIds}::uuid[])`
    : [];
  const runIds = [
    ...new Set([...rs, ...childRuns].map((row) => row.id as string)),
  ];
  const standalone = artifacts
    ? await tx`SELECT a.id,a.storage_key,a.workspace_id,a.organization_id,c.id AS conversation_id FROM generated_artifacts a JOIN messages m ON m.id=a.message_id JOIN conversations c ON c.id=m.conversation_id WHERE ${scope} AND a.created_at<${artifacts} ORDER BY a.created_at,a.id LIMIT ${retentionBatchSize}`
    : [];
  const children = runIds.length
    ? await tx`SELECT a.id,a.storage_key,a.workspace_id,a.organization_id,m.conversation_id FROM generated_artifacts a JOIN messages m ON m.id=a.message_id WHERE a.workspace_id=${p.workspace_id} AND a.organization_id=${p.organization_id} AND m.run_id=ANY(${runIds}::uuid[])`
    : [];
  const as = [
    ...new Map(
      [...standalone, ...children].map((row) => [row.id, row]),
    ).values(),
  ];
  return {
    conversations: conversationIds,
    agentRuns: runIds,
    workflowRuns: ws.map((row) => row.id as string),
    evaluationRuns: es.map((row) => row.id as string),
    connectorSyncs: ss.map((row) => row.id as string),
    artifacts: as,
    conversationLocks: [
      ...new Set([
        ...conversationIds,
        ...rs.map((row) => row.conversation_id as string),
        ...as.map((row) => row.conversation_id as string),
      ]),
    ],
  };
}
export function retentionCounts(
  c: Awaited<ReturnType<typeof retentionCandidates>>,
) {
  return {
    conversations: c.conversations.length,
    agentRuns: c.agentRuns.length,
    workflowRuns: c.workflowRuns.length,
    evaluationRuns: c.evaluationRuns.length,
    artifacts: c.artifacts.length,
    connectorSyncs: c.connectorSyncs.length,
  };
}
export async function registerRetentionRoutes(app: FastifyInstance) {
  async function access(r: Parameters<typeof actor>[0], manage = false) {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        manage ? "retention:manage" : "retention:read",
      );
    return { u, w };
  }
  app.get("/workspaces/:workspaceId/retention", async (r) => {
    const { w } = await access(r);
    const [policy] =
      await sql`SELECT * FROM workspace_retention WHERE workspace_id=${w.id}`;
    const [objects] =
      await sql`SELECT count(*) FILTER(WHERE status='pending')::int AS pending,count(*) FILTER(WHERE status='blocked')::int AS blocked FROM retention_object_deletions WHERE workspace_id=${w.id} AND organization_id=${w.organization_id}`;
    return {
      policy: policy ?? {
        enabled: false,
        revision: 0,
        conversation_days: null,
        run_days: null,
        artifact_days: null,
        connector_days: null,
        next_run_at: null,
      },
      objects,
      history:
        await sql`SELECT id,policy_revision,trigger_kind,status,counts,error_code,created_at,finished_at FROM retention_runs WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} ORDER BY created_at DESC,id DESC LIMIT 30`,
    };
  });
  app.put("/workspaces/:workspaceId/retention", async (r) => {
    const { u, w } = await access(r, true),
      body = retentionInput.parse(r.body);
    return sql.begin(async (tx) => {
      // Serialize initial policy creation as well as updates for this workspace.
      await tx`SELECT id FROM workspaces WHERE id=${w.id} FOR UPDATE`;
      const [current] =
        await tx`SELECT revision FROM workspace_retention WHERE workspace_id=${w.id} FOR UPDATE`;
      if ((current?.revision ?? 0) !== body.revision)
        throw new HttpError(
          409,
          "Retention settings changed; reload before saving",
        );
      const [saved] =
        await tx`INSERT INTO workspace_retention(workspace_id,organization_id,enabled,conversation_days,run_days,artifact_days,connector_days,updated_by,next_run_at) VALUES (${w.id},${w.organization_id},${body.enabled},${body.conversationDays},${body.runDays},${body.artifactDays},${body.connectorDays},${u.id},${body.enabled ? new Date(Date.now() + 86400000) : null}) ON CONFLICT(workspace_id) DO UPDATE SET enabled=EXCLUDED.enabled,conversation_days=EXCLUDED.conversation_days,run_days=EXCLUDED.run_days,artifact_days=EXCLUDED.artifact_days,connector_days=EXCLUDED.connector_days,updated_by=EXCLUDED.updated_by,next_run_at=EXCLUDED.next_run_at,updated_at=now(),revision=workspace_retention.revision+1 RETURNING *`;
      await tx`UPDATE retention_runs SET status='cancelled',finished_at=now(),error_code='POLICY_CHANGED' WHERE workspace_id=${w.id} AND status='queued'`;
      await audit(
        tx,
        r,
        u.id,
        "retention.policy_updated",
        w.id,
        w.organization_id,
        w.id,
        { ...body, revision: saved!.revision },
      );
      return saved;
    });
  });
  app.post("/workspaces/:workspaceId/retention/preview", async (r) => {
    const { w } = await access(r, true),
      body = retentionRequest.parse(r.body);
    return sql.begin(async (tx) => {
      const [policy] = await tx<
        RetentionPolicy[]
      >`SELECT * FROM workspace_retention WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} FOR SHARE`;
      if (!policy || policy.revision !== body.revision)
        throw new HttpError(
          409,
          "Save current retention settings before previewing",
        );
      const now = new Date();
      return {
        revision: policy.revision,
        asOf: now.toISOString(),
        batchLimit: retentionBatchSize,
        counts: retentionCounts(await retentionCandidates(tx, policy, now)),
      };
    });
  });
  app.post("/workspaces/:workspaceId/retention/run", async (r, reply) => {
    const { u, w } = await access(r, true),
      body = retentionRequest.parse(r.body),
      runId = randomUUID();
    await sql.begin(async (tx) => {
      const [policy] =
        await tx`SELECT * FROM workspace_retention WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} FOR UPDATE`;
      if (!policy || !policy.enabled || policy.revision !== body.revision)
        throw new HttpError(
          409,
          "Enable and save current retention settings before running cleanup",
        );
      const [pending] =
        await tx`SELECT id FROM retention_runs WHERE workspace_id=${w.id} AND status='queued'`;
      if (pending) throw new HttpError(409, "A cleanup is already queued");
      await tx`INSERT INTO retention_runs(id,workspace_id,organization_id,policy_revision,requested_by,trigger_kind) VALUES (${runId},${w.id},${w.organization_id},${policy.revision},${u.id},'manual')`;
      await audit(
        tx,
        r,
        u.id,
        "retention.cleanup_queued",
        runId,
        w.organization_id,
        w.id,
      );
    });
    return reply.code(202).send({ id: runId, status: "queued" });
  });
}
