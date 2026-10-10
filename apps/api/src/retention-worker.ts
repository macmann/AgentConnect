import { randomUUID } from "node:crypto";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { sql } from "./db.js";
import { config } from "./config.js";
import {
  retentionCandidates,
  retentionCounts,
  type RetentionPolicy,
} from "./retention.js";

export function validRetentionKey(key: string, org: string, workspace: string) {
  return new RegExp(`^generated/${org}/${workspace}/[a-f0-9-]{36}$`).test(key);
}
// Atomic database-only batches: a crash rolls back the claim and all deletions.
// Object deletion is a separate durable outbox, never an S3 call inside this batch.
export async function processRetentionCleanup() {
  await sql.begin(async (tx) => {
    const due = await tx<
      RetentionPolicy[]
    >`SELECT * FROM workspace_retention WHERE enabled AND next_run_at<=now() ORDER BY next_run_at LIMIT 10 FOR UPDATE SKIP LOCKED`;
    for (const p of due) {
      await tx`INSERT INTO retention_runs(id,workspace_id,organization_id,policy_revision,requested_by,trigger_kind) VALUES (${randomUUID()},${p.workspace_id},${p.organization_id},${p.revision},${p.updated_by},'scheduled') ON CONFLICT(workspace_id) WHERE status='queued' DO NOTHING`;
      await tx`UPDATE workspace_retention SET next_run_at=now()+interval '1 day' WHERE workspace_id=${p.workspace_id}`;
    }
  });
  let jobId: string | undefined;
  try {
    return await sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout='15s'`;
      await tx`SET LOCAL lock_timeout='2s'`;
      // Policy then job matches API lock order and serializes policy revisions.
      const [p] = await tx<
        RetentionPolicy[]
      >`SELECT p.* FROM workspace_retention p WHERE EXISTS(SELECT 1 FROM retention_runs r WHERE r.workspace_id=p.workspace_id AND r.status='queued') ORDER BY p.workspace_id LIMIT 1 FOR UPDATE SKIP LOCKED`;
      if (!p) return false;
      const [job] =
        await tx`SELECT * FROM retention_runs WHERE workspace_id=${p.workspace_id} AND status='queued' FOR UPDATE`;
      if (!job) return false;
      jobId = job.id;
      if (!p.enabled || p.revision !== job.policy_revision) {
        await tx`UPDATE retention_runs SET status='cancelled',error_code='POLICY_CHANGED',finished_at=now() WHERE id=${job.id}`;
        return true;
      }
      const grants =
        await tx`SELECT id FROM memberships WHERE user_id=${job.requested_by} AND organization_id=${p.organization_id} AND ((workspace_id=${p.workspace_id} AND role='workspace_admin') OR (workspace_id IS NULL AND role IN ('owner','org_admin'))) FOR SHARE`;
      if (!grants.length) {
        await tx`UPDATE retention_runs SET status='cancelled',error_code='ACCESS_REVOKED',finished_at=now() WHERE id=${job.id}`;
        return true;
      }
      const now = new Date();
      const initial = await retentionCandidates(tx, p, now);
      // Wait for in-flight writers, then re-evaluate with a fresh statement snapshot.
      // Agent chat acquires this same conversation lock before creating a run.
      const conversationIds = [...new Set(initial.conversationLocks)].sort();
      if (conversationIds.length)
        await tx`SELECT id FROM conversations WHERE id=ANY(${conversationIds}::uuid[]) ORDER BY id FOR UPDATE`;
      if (initial.workflowRuns.length)
        await tx`SELECT id FROM workflow_runs WHERE id=ANY(${initial.workflowRuns}::uuid[]) ORDER BY id FOR UPDATE`;
      if (initial.evaluationRuns.length)
        await tx`SELECT id FROM evaluation_runs WHERE id=ANY(${initial.evaluationRuns}::uuid[]) ORDER BY id FOR UPDATE`;
      if (initial.connectorSyncs.length)
        await tx`SELECT id FROM connector_syncs WHERE id=ANY(${initial.connectorSyncs}::uuid[]) ORDER BY id FOR UPDATE`;
      const c = await retentionCandidates(tx, p, now);
      // A newly eligible root wasn't locked above; leave it for another batch.
      c.conversations = c.conversations.filter((v) =>
        initial.conversations.includes(v),
      );
      c.agentRuns = c.agentRuns.filter((v) => initial.agentRuns.includes(v));
      c.workflowRuns = c.workflowRuns.filter((v) =>
        initial.workflowRuns.includes(v),
      );
      c.evaluationRuns = c.evaluationRuns.filter((v) =>
        initial.evaluationRuns.includes(v),
      );
      c.connectorSyncs = c.connectorSyncs.filter((v) =>
        initial.connectorSyncs.includes(v),
      );
      c.artifacts = c.artifacts.filter((v) =>
        initial.artifacts.some((a) => a.id === v.id),
      );
      for (const a of c.artifacts) {
        if (
          a.storage_key !==
          `generated/${p.organization_id}/${p.workspace_id}/${a.id}`
        )
          throw new Error("INVALID_RETENTION_OBJECT_KEY");
        await tx`INSERT INTO retention_object_deletions(id,workspace_id,organization_id,storage_key) VALUES (${a.id},${p.workspace_id},${p.organization_id},${a.storage_key}) ON CONFLICT(storage_key) DO NOTHING`;
      }
      if (c.artifacts.length) {
        const artifactIds = c.artifacts.map((a) => a.id as string);
        await tx`UPDATE messages SET ui_blocks=COALESCE((SELECT jsonb_agg(CASE WHEN block->>'artifactId'=ANY(${artifactIds}::text[]) THEN block-'artifactId' ELSE block END) FROM jsonb_array_elements(ui_blocks) block),'[]'::jsonb) WHERE workspace_id=${p.workspace_id} AND organization_id=${p.organization_id} AND EXISTS(SELECT 1 FROM jsonb_array_elements(ui_blocks) block WHERE block->>'artifactId'=ANY(${artifactIds}::text[]))`;
        await tx`DELETE FROM generated_artifacts WHERE id=ANY(${c.artifacts.map((a) => a.id)}::uuid[]) AND workspace_id=${p.workspace_id} AND organization_id=${p.organization_id}`;
      }
      // Parent deletion includes all related run/message data, regardless of a
      // different child retention period. Preserve the raw audit trail.
      const runRows =
        await tx`SELECT id FROM agent_runs WHERE workspace_id=${p.workspace_id} AND organization_id=${p.organization_id} AND (id=ANY(${c.agentRuns}::uuid[]) OR conversation_id=ANY(${c.conversations}::uuid[]))`;
      const runIds = runRows.map((row) => row.id as string);
      const messages =
        await tx`SELECT id FROM messages WHERE workspace_id=${p.workspace_id} AND organization_id=${p.organization_id} AND run_id=ANY(${runIds}::uuid[])`;
      const messageIds = messages.map((row) => row.id as string);
      await tx`DELETE FROM collected_submissions WHERE workspace_id=${p.workspace_id} AND message_id=ANY(${messageIds}::uuid[])`;
      await tx`DELETE FROM conversation_reviews WHERE workspace_id=${p.workspace_id} AND message_id=ANY(${messageIds}::uuid[])`;
      await tx`DELETE FROM messages WHERE workspace_id=${p.workspace_id} AND id=ANY(${messageIds}::uuid[])`;
      await tx`DELETE FROM tool_executions WHERE workspace_id=${p.workspace_id} AND (run_id=ANY(${runIds}::uuid[]) OR workflow_run_id=ANY(${c.workflowRuns}::uuid[]))`;
      await tx`DELETE FROM agent_runs WHERE workspace_id=${p.workspace_id} AND id=ANY(${runIds}::uuid[])`;
      await tx`DELETE FROM handoff_events WHERE workspace_id=${p.workspace_id} AND conversation_id=ANY(${c.conversations}::uuid[])`;
      await tx`DELETE FROM conversations WHERE workspace_id=${p.workspace_id} AND id=ANY(${c.conversations}::uuid[])`;
      await tx`DELETE FROM workflow_approvals WHERE workspace_id=${p.workspace_id} AND run_id=ANY(${c.workflowRuns}::uuid[])`;
      await tx`DELETE FROM workflow_node_runs WHERE workspace_id=${p.workspace_id} AND run_id=ANY(${c.workflowRuns}::uuid[])`;
      // LangGraph thread_id is the workflow run UUID. Delete all payload tables
      // inside this transaction; setup may not exist before the first workflow.
      for (const table of [
        "checkpoint_writes",
        "checkpoint_blobs",
        "checkpoints",
      ]) {
        const [exists] =
          await tx`SELECT to_regclass(${`workflow_checkpoints.${table}`}) AS name`;
        if (exists?.name && c.workflowRuns.length)
          await tx.unsafe(
            `DELETE FROM workflow_checkpoints.${table} WHERE thread_id=ANY($1::text[])`,
            [c.workflowRuns],
          );
      }
      await tx`DELETE FROM workflow_runs WHERE workspace_id=${p.workspace_id} AND id=ANY(${c.workflowRuns}::uuid[])`;
      await tx`DELETE FROM evaluation_results WHERE workspace_id=${p.workspace_id} AND run_id=ANY(${c.evaluationRuns}::uuid[])`;
      await tx`DELETE FROM evaluation_runs WHERE workspace_id=${p.workspace_id} AND id=ANY(${c.evaluationRuns}::uuid[])`;
      await tx`DELETE FROM connector_syncs WHERE workspace_id=${p.workspace_id} AND id=ANY(${c.connectorSyncs}::uuid[])`;
      const counts = {
        ...retentionCounts(c),
        agentRuns: runIds.length,
        messages: messageIds.length,
      };
      await tx`UPDATE retention_runs SET status='completed',counts=${tx.json(counts)},finished_at=now() WHERE id=${job.id}`;
      if (Object.values(counts).some((count) => count >= 100))
        await tx`UPDATE workspace_retention SET next_run_at=LEAST(next_run_at,now()+interval '5 minutes') WHERE workspace_id=${p.workspace_id}`;
      await tx`INSERT INTO audit_events(id,organization_id,workspace_id,actor_id,action,entity_id,metadata,ip,user_agent) VALUES (${randomUUID()},${p.organization_id},${p.workspace_id},${job.requested_by},'retention.cleanup_completed',${job.id},${tx.json({ revision: p.revision, counts })},'worker','retention-worker')`;
      return true;
    });
  } catch {
    console.error(
      JSON.stringify({
        msg: "Retention cleanup failed",
        code: "CLEANUP_FAILED",
        runId: jobId,
      }),
    );
    if (jobId)
      await sql`UPDATE retention_runs SET status='failed',error_code='CLEANUP_FAILED',finished_at=now() WHERE id=${jobId} AND status='queued'`;
    return false;
  }
}

const storage = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  },
  maxAttempts: 1,
  requestHandler: { requestTimeout: 5000, connectionTimeout: 2000 },
});
export type RetentionDeleter = (
  key: string,
  signal: AbortSignal,
) => Promise<unknown>;
export async function processRetentionObjectDeletion(
  remove: RetentionDeleter = (key, signal) =>
    storage.send(
      new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key }),
      { abortSignal: signal },
    ),
) {
  return sql.begin(async (tx) => {
    const [object] =
      await tx`SELECT * FROM retention_object_deletions WHERE status='pending' AND next_attempt_at<=now() ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!object) return false;
    if (
      !validRetentionKey(
        object.storage_key,
        object.organization_id,
        object.workspace_id,
      ) ||
      object.storage_key !==
        `generated/${object.organization_id}/${object.workspace_id}/${object.id}`
    ) {
      await tx`UPDATE retention_object_deletions SET status='blocked',error_code='INVALID_STORAGE_KEY' WHERE id=${object.id}`;
      return true;
    }
    try {
      await remove(object.storage_key, AbortSignal.timeout(5000));
      await tx`DELETE FROM retention_object_deletions WHERE id=${object.id}`;
    } catch {
      await tx`UPDATE retention_object_deletions SET attempts=attempts+1,error_code='OBJECT_DELETE_FAILED',next_attempt_at=now()+${Math.min(3600, 30 * 2 ** Math.min(object.attempts, 7))}*interval '1 second' WHERE id=${object.id}`;
    }
    return true;
  });
}
