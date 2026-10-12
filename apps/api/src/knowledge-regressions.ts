import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { agentConfig } from "@agentconnect/schemas/agents";
import { datasetInput, example } from "@agentconnect/schemas/quality";
import { sql } from "./db.js";
import { HttpError } from "./http-error.js";
import { qualityFingerprint } from "./quality-gate.js";
import { modelSnapshot } from "./agents.js";
import { modelSnapshotSchema } from "./agent-models.js";

export type CorrectionDraft = {
  id: string;
  knowledge_base_id: string;
  organization_id: string;
  workspace_id: string;
  question: string;
  answer: string;
};
const regressionExample = (draft: CorrectionDraft, sourceId: string) =>
  example.parse({
    id: draft.id,
    input: draft.question,
    expectedBehavior: "Use the approved correction and cite its evidence.",
    expectedAnswer: draft.answer,
    expectedSourceIds: [sourceId],
    tags: ["correction"],
    metadata: { improvementId: draft.id },
  });
export async function prepareCorrectionRegression(
  tx: TransactionSql,
  draft: CorrectionDraft,
) {
  const [kb] =
    await tx`SELECT id,name FROM knowledge_bases WHERE id=${draft.knowledge_base_id} FOR UPDATE`;
  let [mapping] =
    await tx`SELECT dataset_id FROM knowledge_regression_datasets WHERE knowledge_base_id=${draft.knowledge_base_id}`;
  if (!mapping) {
    const older =
      await tx`SELECT i.* FROM knowledge_improvements i JOIN knowledge_sources s ON s.id=i.source_id WHERE i.knowledge_base_id=${draft.knowledge_base_id} AND i.status='materialized' AND s.status<>'deleted' ORDER BY i.created_at LIMIT 101`;
    if (older.length >= 100)
      throw new HttpError(
        409,
        "Review the active correction sources before exceeding the 100-example regression limit",
      );
    const cases = older.map((i) =>
      regressionExample(i as CorrectionDraft, i.source_id),
    );
    const datasetId = randomUUID(),
      name = ("Corrections: " + kb!.name).slice(0, 100);
    await tx`INSERT INTO evaluation_datasets(id,organization_id,workspace_id,name,description,examples) VALUES(${datasetId},${draft.organization_id},${draft.workspace_id},${name},'Reviewed corrections. Exact answers are conservative defaults; review required/forbidden terms in Quality before verification.',${tx.json(cases)})`;
    [mapping] =
      await tx`INSERT INTO knowledge_regression_datasets(knowledge_base_id,dataset_id,workspace_id,organization_id) VALUES(${draft.knowledge_base_id},${datasetId},${draft.workspace_id},${draft.organization_id}) RETURNING dataset_id`;
  }
  const [d] =
    await tx`SELECT * FROM evaluation_datasets WHERE id=${mapping!.dataset_id} FOR UPDATE`;
  if (d!.archived_at)
    throw new HttpError(
      409,
      "Restore the correction regression dataset before adding knowledge",
    );
  const cases = datasetInput.parse({
    name: d!.name,
    description: d!.description,
    examples: d!.examples,
  }).examples;
  if (cases.length >= 100)
    throw new HttpError(
      409,
      "Correction regression datasets support 100 examples; review the knowledge base scope before adding more",
    );
  return { id: d!.id, cases };
}
export async function addCorrectionRegression(
  tx: TransactionSql,
  draft: CorrectionDraft,
  sourceId: string,
) {
  const { id, cases } = await prepareCorrectionRegression(tx, draft);
  cases.push(regressionExample(draft, sourceId));
  await tx`UPDATE evaluation_datasets SET examples=${tx.json(cases)},revision=revision+1 WHERE id=${id}`;
}

export async function regressionDataset(
  kbId: string,
  db: typeof sql | TransactionSql = sql,
) {
  const [d] =
    await db`SELECT d.* FROM knowledge_regression_datasets k JOIN evaluation_datasets d ON d.id=k.dataset_id WHERE k.knowledge_base_id=${kbId} AND d.archived_at IS NULL`;
  return d;
}
export async function candidateRelease(
  releaseId: string,
  workspaceId: string,
  db: typeof sql | TransactionSql = sql,
) {
  const [r] =
    await db`SELECT r.* FROM knowledge_releases r JOIN knowledge_bases k ON k.id=r.knowledge_base_id WHERE r.id=${releaseId} AND r.workspace_id=${workspaceId} AND k.archived_at IS NULL AND r.status IN ('approved','published') FOR SHARE OF r,k`;
  if (!r)
    throw new HttpError(
      409,
      "Approve the candidate knowledge release before testing it",
    );
  return r;
}
export async function releaseTargets(
  kbId: string,
  workspaceId: string,
  db: typeof sql | TransactionSql = sql,
) {
  const rows =
    await db`SELECT a.id AS agent_id,a.name,a.revision,NULL::uuid AS version_id,a.draft_config AS config,NULL::jsonb AS model FROM agents a WHERE a.workspace_id=${workspaceId} AND a.archived_at IS NULL UNION ALL SELECT a.id,a.name,a.revision,v.id,v.config,v.model_snapshot FROM agents a JOIN agent_versions v ON v.agent_id=a.id WHERE a.workspace_id=${workspaceId} AND a.archived_at IS NULL AND EXISTS(SELECT 1 FROM deployments d WHERE d.version_id=v.id AND d.enabled)`;
  return rows.filter((row) => {
    const c = agentConfig.parse(row.config);
    return (
      c.rag.knowledgeBaseIds.includes(kbId) &&
      c.rag.usageMode !== "disabled" &&
      !c.rag.releasePins[kbId]
    );
  });
}
export function previewConfig(value: unknown, kbId: string, releaseId: string) {
  const c = agentConfig.parse(value);
  if (!c.rag.knowledgeBaseIds.includes(kbId) || c.rag.usageMode === "disabled")
    throw new HttpError(400, "Agent must use the selected knowledge base");
  c.rag.releasePins = { ...c.rag.releasePins, [kbId]: releaseId };
  return c;
}
export async function assertCorrectionCoverage(
  releaseId: string,
  kbId: string,
  dataset: Record<string, unknown>,
  db: typeof sql | TransactionSql = sql,
) {
  const cases = datasetInput.parse({
    name: dataset.name,
    description: dataset.description,
    examples: dataset.examples,
  }).examples;
  const corrections =
    await db`SELECT i.id,i.question,i.source_id FROM knowledge_improvements i JOIN knowledge_sources s ON s.id=i.source_id WHERE i.knowledge_base_id=${kbId} AND i.status='materialized' AND s.status<>'deleted'`;
  for (const i of corrections) {
    const [chunk] =
      await db`SELECT id FROM knowledge_release_chunks WHERE release_id=${releaseId} AND source_id=${i.source_id} LIMIT 1`;
    const e = cases.find(
      (e) =>
        e.id === i.id &&
        e.input === i.question &&
        e.expectedSourceIds.includes(i.source_id),
    );
    if (!chunk || !e || (!e.expectedAnswer && !e.contains.length))
      throw new HttpError(
        409,
        "Include every active correction and its answer checks in the release and regression dataset",
      );
  }
  if (!cases.length)
    throw new HttpError(
      409,
      "Add regression examples before testing this release",
    );
}
export async function assertKnowledgeRegressionGate(
  tx: TransactionSql,
  kbId: string,
  releaseId: string,
  workspaceId: string,
) {
  const [mapping] =
    await tx`SELECT dataset_id FROM knowledge_regression_datasets WHERE knowledge_base_id=${kbId} FOR SHARE`;
  if (!mapping) return; // Existing KBs without reviewed corrections keep their prior publication contract.
  const d = await regressionDataset(kbId, tx);
  if (!d)
    throw new HttpError(
      409,
      "The correction regression dataset is unavailable",
    );
  await tx`SELECT id FROM evaluation_datasets WHERE id=${d.id} FOR SHARE`;
  await assertCorrectionCoverage(releaseId, kbId, d, tx);
  for (const table of [
    "agents",
    "agent_versions",
    "deployments",
    "model_configurations",
    "knowledge_bases",
    "knowledge_sources",
    "tools",
    "rerankers",
    "embedding_models",
    "mcp_connectors",
    "secrets",
  ])
    await tx`SELECT id FROM ${tx(table)} WHERE workspace_id=${workspaceId} ORDER BY id FOR SHARE`;
  const targets = await releaseTargets(kbId, workspaceId, tx);
  if (!targets.length)
    throw new HttpError(
      409,
      "Attach this knowledge base to an agent and verify the correction before publishing",
    );
  for (const target of targets) {
    const c = previewConfig(target.config, kbId, releaseId),
      model = target.model
        ? modelSnapshotSchema.parse(target.model)
        : await modelSnapshot(c.modelId, workspaceId, c);
    const fingerprint = await qualityFingerprint(c, model, workspaceId, tx);
    const [run] =
      await tx`SELECT id FROM evaluation_runs WHERE candidate_release_id=${releaseId} AND agent_id=${target.agent_id} AND candidate_version_id IS NOT DISTINCT FROM ${target.version_id} AND dataset_id=${d.id} AND dataset_revision=${d.revision} AND config_snapshot=${tx.json(c)} AND model_snapshot=${tx.json(model)} AND fingerprint=${fingerprint} AND status='completed' AND summary->>'passRate'='1' AND (summary->>'failedCases')::int=0 ORDER BY finished_at DESC LIMIT 1`;
    if (!run)
      throw new HttpError(
        409,
        "Knowledge regression gate failed. Run passing candidate-release tests for every affected draft and active published agent before publishing.",
      );
  }
}
