import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import { gateInput } from "@agentconnect/schemas/quality";
import { sql } from "./db.js";
import { HttpError } from "./http-error.js";
export async function qualityFingerprint(
  config: unknown,
  model: unknown,
  workspaceId: string,
  db: typeof sql | TransactionSql = sql,
) {
  const dependencies =
    await db`SELECT 'knowledge' AS kind,id::text,revision::text AS revision FROM knowledge_bases WHERE workspace_id=${workspaceId} UNION ALL SELECT 'source',id::text,concat(revision,':',status,':',updated_at) FROM knowledge_sources WHERE workspace_id=${workspaceId} UNION ALL SELECT 'tool',id::text,concat(revision,':',enabled,':',archived_at) FROM tools WHERE workspace_id=${workspaceId} UNION ALL SELECT 'model',id::text,concat(revision,':',archived_at) FROM model_configurations WHERE workspace_id=${workspaceId} UNION ALL SELECT 'embedding',id::text,to_jsonb(embedding_models)::text FROM embedding_models WHERE workspace_id=${workspaceId} UNION ALL SELECT 'connector',id::text,concat(revision,':',enabled) FROM mcp_connectors WHERE workspace_id=${workspaceId} UNION ALL SELECT 'credential',id::text,ciphertext::text FROM secrets WHERE workspace_id=${workspaceId} ORDER BY kind,id`;
  return createHash("sha256")
    .update(JSON.stringify([config, model, dependencies]))
    .digest("hex");
}
export async function assertQualityGate(
  tx: TransactionSql,
  agent: { id: string; workspace_id: string; revision: number },
  config: unknown,
  model: unknown,
) {
  const [gate] =
    await tx`SELECT settings FROM agent_quality_gates WHERE agent_id=${agent.id} FOR SHARE`;
  if (!gate) return;
  const settings = gateInput.parse(gate.settings);
  if (!settings.enabled) return;
  const [dataset] =
    await tx`SELECT revision FROM evaluation_datasets WHERE id=${settings.datasetId} AND workspace_id=${agent.workspace_id} AND archived_at IS NULL FOR SHARE`;
  if (!dataset) throw new HttpError(409, "Quality gate dataset is unavailable");
  for (const table of [
    "model_configurations",
    "knowledge_bases",
    "knowledge_sources",
    "tools",
    "embedding_models",
    "mcp_connectors",
    "secrets",
  ])
    await tx`SELECT id FROM ${tx(table)} WHERE workspace_id=${agent.workspace_id} ORDER BY id FOR SHARE`;
  const fingerprint = await qualityFingerprint(
    config,
    model,
    agent.workspace_id,
    tx,
  );
  const [run] =
    await tx`SELECT summary FROM evaluation_runs WHERE agent_id=${agent.id} AND agent_revision=${agent.revision} AND dataset_id=${settings.datasetId} AND dataset_revision=${dataset.revision} AND evaluator=${tx.json(settings.evaluator)} AND fingerprint=${fingerprint} AND status='completed' ORDER BY finished_at DESC LIMIT 1`;
  if (
    !run ||
    run.summary.failedCases > 0 ||
    run.summary.passRate < settings.minPassRate
  )
    throw new HttpError(
      409,
      "Quality gate failed. Run a passing evaluation for this saved draft and current dataset before publishing.",
    );
}
