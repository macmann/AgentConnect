import { createHash, randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import {
  validateVectors,
  type EmbeddingFactory,
} from "@agentconnect/provider-sdk/embeddings";
import { sql } from "./db.js";
import { embeddingConnection } from "./knowledge-core.js";
import { HttpError } from "./http-error.js";
import { semanticClusters, clusterSimilarity } from "./semantic-gaps.js";
import {
  gapCandidates,
  gapAssignmentLock,
  type GapCandidate,
} from "./gap-queries.js";
import { observe } from "./ai-tracing.js";
type StoredProposal = {
  key: string;
  members: { runId: string }[];
  similarity: { minimum: number | null; mean: number | null };
};
export type GapProposal = {
  key: string;
  question: string;
  members: { runId: string; question: string }[];
  similarity: { minimum: number | null; mean: number | null };
};
async function assignmentSnapshot(
  workspace: string,
  org: string,
  rows: GapCandidate[],
  tx: typeof sql | TransactionSql = sql,
) {
  const assignments =
    await tx`SELECT run_id,group_key,method,updated_at::text AS version FROM knowledge_gap_assignments WHERE workspace_id=${workspace} AND organization_id=${org} AND run_id=ANY(${rows.map((r) => r.run_id)}::uuid[]) ORDER BY run_id`;
  const snapshot = JSON.stringify({
    questions: rows
      .map((r) => [r.run_id, r.question])
      .sort((a, b) => a[0]!.localeCompare(b[0]!)),
    assignments: assignments.map((a) => [
      a.run_id,
      a.group_key,
      a.method,
      a.version,
    ]),
  });
  return {
    hash: createHash("sha256").update(snapshot).digest("hex"),
    assignments,
  };
}
export async function previewGapClusters(
  workspace: string,
  org: string,
  user: string,
  modelId: string,
  threshold: number,
  from: string,
  to: string,
  factory: EmbeddingFactory,
) {
  return observe(
    "knowledge.gaps.cluster",
    "chain",
    {
      "workspace.id": workspace,
      "embedding.model.id": modelId,
      "clustering.threshold": threshold,
    },
    async (span) => {
      const rows = await gapCandidates(workspace, org, from, to, 301);
      const all = rows.slice(0, 300),
        snapshot = await assignmentSnapshot(workspace, org, all);
      const items = all.filter(
        (row) =>
          !snapshot.assignments.some(
            (a) => a.run_id === row.run_id && a.method === "reviewer",
          ),
      );
      const conn = await embeddingConnection(modelId, workspace, org),
        provider = factory(conn),
        vectors: number[][] = [];
      const [model] =
        await sql`SELECT name FROM embedding_models WHERE id=${modelId} AND workspace_id=${workspace} AND organization_id=${org}`;
      const signal = AbortSignal.timeout(60000);
      for (let i = 0; i < items.length; i += 32) {
        const texts = items.slice(i, i + 32).map((row) => row.question);
        const batch = await provider.embed(texts, signal, "document");
        validateVectors(batch, texts.length, conn.dimensions);
        vectors.push(...batch);
      }
      const previewId = randomUUID();
      const proposals = semanticClusters(vectors, threshold).map((members) => ({
        key: "semantic:" + previewId + ":" + members[0],
        question: items[members[0]!]!.question,
        members: members.map((i) => ({
          runId: items[i]!.run_id,
          question: items[i]!.question,
        })),
        similarity: clusterSimilarity(vectors, members),
      }));
      await sql.begin(async (tx) => {
        await tx`DELETE FROM knowledge_gap_previews WHERE workspace_id=${workspace} AND expires_at<now()-interval '1 day'`;
        await tx`INSERT INTO knowledge_gap_previews(id,workspace_id,organization_id,created_by,model_id,model_name,threshold,range_from,range_to,proposals,snapshot_hash,run_ids,protected_count,truncated) VALUES (${previewId},${workspace},${org},${user},${modelId},${model?.name ?? "Embedding model"},${threshold},${from},${to},${tx.json(proposals.map((proposal) => ({ key: proposal.key, members: proposal.members.map((member) => ({ runId: member.runId })), similarity: proposal.similarity })))},${snapshot.hash},${tx.json(all.map((row) => row.run_id))},${all.length - items.length},${rows.length > 300})`;
      });
      span.setAttributes({
        "clustering.questions": items.length,
        "clustering.groups": proposals.length,
        "clustering.protected": all.length - items.length,
      });
      return {
        previewId,
        modelName: String(model?.name ?? "Embedding model"),
        threshold,
        proposals,
        grouped: items.length,
        clusters: proposals.length,
        protected: all.length - items.length,
        truncated: rows.length > 300,
        expiresInSeconds: 600,
      };
    },
  );
}
export async function applyGapPreview(
  workspace: string,
  org: string,
  user: string,
  previewId: string,
  groupKeys?: string[],
  onApplied?: (tx: TransactionSql) => Promise<void>,
) {
  return sql.begin(async (tx) => {
    await gapAssignmentLock(tx, workspace);
    const [preview] =
      await tx`SELECT * FROM knowledge_gap_previews WHERE id=${previewId} AND workspace_id=${workspace} AND organization_id=${org} AND created_by=${user} FOR UPDATE`;
    if (!preview) throw new HttpError(404, "Grouping preview unavailable");
    const proposals = preview.proposals as StoredProposal[];
    const selected = [
      ...new Set(groupKeys ?? proposals.map((p) => p.key)),
    ].sort();
    if (selected.some((key) => !proposals.some((p) => p.key === key)))
      throw new HttpError(400, "Unknown proposed topic");
    if (preview.status === "applied") {
      if (JSON.stringify(selected) !== JSON.stringify(preview.applied_groups))
        throw new HttpError(
          409,
          "This preview was already applied with a different selection",
        );
      return { ok: true, alreadyApplied: true };
    }
    if (new Date(preview.expires_at).getTime() <= Date.now())
      throw new HttpError(
        409,
        "This preview expired. Generate a new preview before applying.",
      );
    const ids = preview.run_ids as string[];
    // Lock runs before comparing eligibility and assignments; reviewer mutations share the workspace lock.
    await tx`SELECT id FROM agent_runs WHERE id=ANY(${ids}::uuid[]) AND workspace_id=${workspace} AND organization_id=${org} FOR SHARE`;
    const current = await gapCandidates(
      workspace,
      org,
      new Date(preview.range_from).toISOString(),
      new Date(preview.range_to).toISOString(),
      301,
      ids,
      tx,
    );
    const snapshot = await assignmentSnapshot(workspace, org, current, tx);
    if (
      current.length !== ids.length ||
      snapshot.hash !== preview.snapshot_hash
    )
      throw new HttpError(
        409,
        "Questions or reviewer assignments changed. Generate a new grouping preview.",
      );
    for (const proposal of proposals.filter((p) => selected.includes(p.key)))
      for (const member of proposal.members) {
        await tx`INSERT INTO knowledge_gap_assignments(run_id,workspace_id,organization_id,group_key,updated_by,method,clustering_metadata) VALUES(${member.runId},${workspace},${org},${proposal.key},${user},'embedding',${tx.json({ previewId, modelId: preview.model_id, modelName: preview.model_name, threshold: preview.threshold, minimumSimilarity: proposal.similarity.minimum, meanSimilarity: proposal.similarity.mean })}) ON CONFLICT(run_id) DO UPDATE SET group_key=EXCLUDED.group_key,updated_by=EXCLUDED.updated_by,method='embedding',clustering_metadata=EXCLUDED.clustering_metadata,updated_at=clock_timestamp() WHERE knowledge_gap_assignments.method<>'reviewer'`;
      }
    await tx`UPDATE knowledge_gap_previews SET status='applied',applied_groups=${tx.json(selected)} WHERE id=${previewId}`;
    if (onApplied) await onApplied(tx);
    return { ok: true, alreadyApplied: false };
  });
}
