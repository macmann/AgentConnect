import { metadataFilter } from "@agentconnect/schemas/knowledge-metadata";
import { expandKnowledgeNeighbors } from "./knowledge-neighbors.js";
import { lexicalSearchQuery } from "@agentconnect/rag/context-selection";
import {
  selectEvidence,
  DEFAULT_QA_MIN_SCORE,
  preferredQa,
} from "@agentconnect/rag/answer-source-policy";
import { observe, observationContent, startObservation } from "./ai-tracing.js";
import { HttpError } from "./http-error.js";
import { sql } from "./db.js";
import { config } from "./config.js";
import { decrypt } from "./security.js";
import {
  createEmbeddingProvider,
  validateVectors,
  type EmbeddingConnection,
  type EmbeddingFactory,
} from "@agentconnect/provider-sdk/embeddings";
import { safeTransport } from "@agentconnect/provider-sdk";
import { KnowledgeError } from "@agentconnect/rag/parsers";
import type {
  Citation,
  RagTool,
  RetrievalContext,
} from "@agentconnect/rag/tool";
export const hosts = (value: string) =>
  value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
export type KnowledgeBase = {
  id: string;
  organization_id: string;
  workspace_id: string;
  name: string;
  description: string;
  embedding_model_id: string;
  dimensions: number;
  chunk_size: number;
  chunk_overlap: number;
  chunk_strategy: string;
  public_access: boolean;
  approval_required: boolean;
  ocr_enabled: boolean;
  advanced_processing: import("@agentconnect/schemas/knowledge").AdvancedProcessing;
  parent_context: boolean;
  published_release_id: string | null;
  archived_at: Date | null;
  revision: number;
};
export const defaultEmbeddingFactory: EmbeddingFactory = (c) =>
  createEmbeddingProvider(
    c,
    safeTransport(
      hosts(config.MODEL_ALLOWED_HOSTS),
      hosts(config.MODEL_PRIVATE_HOSTS),
    ),
  );
export async function embeddingConnection(
  modelId: string,
  workspaceId: string,
  organizationId: string,
): Promise<EmbeddingConnection> {
  const [m] =
    await sql`SELECT * FROM embedding_models WHERE id=${modelId} AND workspace_id=${workspaceId} AND organization_id=${organizationId}`;
  if (!m) throw new KnowledgeError("EMBEDDING_MODEL_UNAVAILABLE");
  let apiKey: string | undefined;
  if (m.secret_id) {
    const [s] =
      await sql`SELECT name,ciphertext FROM secrets WHERE id=${m.secret_id} AND workspace_id=${workspaceId} AND organization_id=${organizationId}`;
    if (!s) throw new KnowledgeError("MISSING_CREDENTIAL");
    apiKey = decrypt(
      s.ciphertext,
      `${organizationId}:${workspaceId}:${s.name}`,
    );
  }
  if (m.provider !== "openai-compatible" && !apiKey)
    throw new KnowledgeError("MISSING_CREDENTIAL");
  return {
    provider: m.provider,
    modelId: m.model_id,
    baseUrl: m.base_url,
    dimensions: m.dimensions,
    apiKey,
  };
}
export async function validateKnowledgeIds(
  ids: string[],
  workspaceId: string,
  organizationId: string,
  publicAccess = false,
) {
  if (new Set(ids).size !== ids.length)
    throw new KnowledgeError("DUPLICATE_KNOWLEDGE_BASE");
  if (!ids.length) return;
  const rows =
    await sql`SELECT id,public_access FROM knowledge_bases WHERE id=ANY(${ids}) AND workspace_id=${workspaceId} AND organization_id=${organizationId} AND archived_at IS NULL`;
  if (rows.length !== ids.length)
    throw new KnowledgeError("KNOWLEDGE_BASE_UNAVAILABLE");
  if (publicAccess && rows.some((r) => !r.public_access))
    throw new KnowledgeError("KNOWLEDGE_NOT_PUBLIC");
}
function vectorLiteral(vector: number[], dimensions: number) {
  validateVectors([vector], 1, dimensions);
  return "[" + vector.join(",") + "]";
}
export class PostgresRagTool implements RagTool {
  expandNeighbors = expandKnowledgeNeighbors;
  constructor(private factory: EmbeddingFactory = defaultEmbeddingFactory) {}
  async execute(
    query: string,
    ids: string[],
    options: Parameters<RagTool["execute"]>[2],
    context: RetrievalContext,
    signal: AbortSignal,
  ): Promise<Citation[]> {
    return observe(
      "knowledge.retrieval",
      "retriever",
      {
        "workspace.id": context.workspaceId,
        "knowledge.base.ids": ids,
        "retrieval.mode": options.mode,
        "retrieval.top_k": options.topK,
        "retrieval.min_score": options.minScore,
        "retrieval.answer_source_policy":
          options.answerSourcePolicy ?? "balanced",
      },
      async (span) => {
        const metadata = options.metadataFilter
          ? metadataFilter.parse(options.metadataFilter)
          : { tagsAll: [], attributes: {} };
        observationContent(span, "input", query);
        const lexicalQuery = lexicalSearchQuery(query);
        await validateKnowledgeIds(
          ids,
          context.workspaceId,
          context.organizationId,
          context.publicAccess,
        );
        const bases = await sql<
          KnowledgeBase[]
        >`SELECT * FROM knowledge_bases WHERE id=ANY(${ids}) AND workspace_id=${context.workspaceId} AND organization_id=${context.organizationId} AND archived_at IS NULL`;
        const result: (Citation & { fusion: number })[] = [];
        const queries = new Map<string, number[]>();
        for (const kb of bases) {
          signal.throwIfAborted();
          let vector = queries.get(kb.embedding_model_id);
          if (!vector) {
            const connection = await embeddingConnection(
              kb.embedding_model_id,
              context.workspaceId,
              context.organizationId,
            );
            vector = await observe(
              "knowledge.embedding",
              "embedding",
              {
                "langfuse.observation.model.name": connection.modelId,
                "embedding.dimensions": kb.dimensions,
              },
              async (embeddingSpan) => {
                observationContent(embeddingSpan, "input", query);
                const vectors = await this.factory(connection).embed(
                  [query],
                  signal,
                  "query",
                );
                return validateVectors(vectors, 1, kb.dimensions)[0]!;
              },
            );
            queries.set(kb.embedding_model_id, vector);
          }
          const releaseId =
            options.releasePins?.[kb.id] ?? kb.published_release_id;
          const approved =
            !!options.releasePins?.[kb.id] ||
            options.contentMode === "approved" ||
            kb.approval_required;
          if (approved) {
            const [release] =
              await sql`SELECT id FROM knowledge_releases WHERE id=${releaseId ?? null} AND knowledge_base_id=${kb.id} AND workspace_id=${context.workspaceId} AND organization_id=${context.organizationId} AND (status='published' OR (${context.publicAccess} = false AND id=${context.candidateReleaseId ?? null} AND status='approved'))`;
            if (!release)
              throw new KnowledgeError("KNOWLEDGE_RELEASE_UNAVAILABLE");
          }
          const literal = vectorLiteral(vector, kb.dimensions);
          const dim = sql.unsafe(String(kb.dimensions));
          const filters = options.sourceIds ?? [];
          const preferQa = options.answerSourcePolicy === "prefer_approved_qa";
          const releaseSelect = sql`SELECT c.id,c.document_id,c.source_id,c.knowledge_base_id,c.ordinal,c.content,c.page,c.heading,${kb.parent_context ? sql`c.metadata->>'parentContent'` : sql`NULL::text`} AS parent_content,c.title,c.source_url,1-(c.embedding::vector(${dim}) <=> ${literal}::vector(${dim})) AS vector_score,ts_rank_cd(c.search_vector,websearch_to_tsquery('simple',${lexicalQuery})) AS lexical_score,c.metadata->'sourceTags' AS source_tags,c.metadata->'sourceAttributes' AS source_attributes,c.kind,true AS reviewed,c.release_id,c.source_revision FROM knowledge_release_chunks c JOIN knowledge_sources s ON s.id=c.source_id WHERE c.release_id=${releaseId ?? null} AND c.knowledge_base_id=${kb.id} AND c.workspace_id=${context.workspaceId} AND c.organization_id=${context.organizationId} AND s.status<>'deleted' AND (cardinality(${filters}::uuid[])=0 OR c.source_id=ANY(${filters}::uuid[])) AND COALESCE(c.metadata->'sourceTags','[]'::jsonb) @> ${sql.json(metadata.tagsAll)}::jsonb AND COALESCE(c.metadata->'sourceAttributes','{}'::jsonb) @> ${sql.json(metadata.attributes)}::jsonb`;
          const currentSelect = sql`SELECT c.id,c.document_id,c.source_id,c.knowledge_base_id,c.ordinal,c.content,c.page,c.heading,${kb.parent_context ? sql`c.metadata->>'parentContent'` : sql`NULL::text`} AS parent_content,d.title,d.source_url,1-(c.embedding::vector(${dim}) <=> ${literal}::vector(${dim})) AS vector_score,ts_rank_cd(c.search_vector,websearch_to_tsquery('simple',${lexicalQuery})) AS lexical_score,s.metadata->'tags' AS source_tags,s.metadata->'attributes' AS source_attributes,s.kind,false AS reviewed,NULL::uuid AS release_id,s.revision AS source_revision FROM knowledge_chunks c JOIN knowledge_sources s ON s.id=c.source_id JOIN knowledge_documents d ON d.id=c.document_id WHERE c.knowledge_base_id=${kb.id} AND c.workspace_id=${context.workspaceId} AND c.organization_id=${context.organizationId} AND s.status='ready' AND (cardinality(${filters}::uuid[])=0 OR c.source_id=ANY(${filters}::uuid[])) AND COALESCE(s.metadata->'tags','[]'::jsonb) @> ${sql.json(metadata.tagsAll)}::jsonb AND COALESCE(s.metadata->'attributes','{}'::jsonb) @> ${sql.json(metadata.attributes)}::jsonb`;
          const select = approved ? releaseSelect : currentSelect;
          let qaReleaseAvailable = approved;
          if (preferQa && !approved && releaseId) {
            const [release] =
              await sql`SELECT id FROM knowledge_releases WHERE id=${releaseId} AND knowledge_base_id=${kb.id} AND workspace_id=${context.workspaceId} AND organization_id=${context.organizationId} AND (status='published' OR (${context.publicAccess}=false AND id=${context.candidateReleaseId ?? null} AND status='approved'))`;
            qaReleaseAvailable = !!release;
          }
          // Separate bounded lanes keep matching approved Q&A from being crowded
          // out by documents, and never promote an edited current Q&A revision.
          const selections = preferQa
            ? [
                sql`${select} AND ${approved ? sql`c.kind` : sql`s.kind`}<>'qa'`,
                ...(qaReleaseAvailable
                  ? [sql`${releaseSelect} AND c.kind='qa'`]
                  : []),
              ]
            : [select];
          const semantic = await observe(
            "knowledge.vector_search",
            "chain",
            { "knowledge.base.id": kb.id },
            async (searchSpan) => {
              const rows = (
                await Promise.all(
                  selections.map(
                    (selection) =>
                      sql`${selection} ORDER BY c.embedding::vector(${dim}) <=> ${literal}::vector(${dim}) LIMIT 30`,
                  ),
                )
              ).flat();
              if (preferQa)
                rows.sort(
                  (a, b) =>
                    Number(b.vector_score) - Number(a.vector_score) ||
                    String(a.id).localeCompare(String(b.id)),
                );
              searchSpan.setAttribute("retrieval.results", rows.length);
              searchSpan.setAttribute(
                "retrieval.matches",
                JSON.stringify(
                  rows.map((row, i) => ({
                    chunkId: row.id,
                    sourceId: row.source_id,
                    rank: i + 1,
                    score: Number(row.vector_score),
                  })),
                ),
              );
              searchSpan.setAttribute(
                "langfuse.observation.metadata",
                JSON.stringify({
                  knowledgeBaseId: kb.id,
                  results: rows.map((row, i) => ({
                    chunkId: row.id,
                    sourceId: row.source_id,
                    rank: i + 1,
                    score: Number(row.vector_score),
                  })),
                }),
              );
              observationContent(searchSpan, "input", query);
              observationContent(
                searchSpan,
                "output",
                rows.map((row, i) => ({
                  chunkId: row.id,
                  rank: i + 1,
                  score: Number(row.vector_score),
                  content: row.content,
                })),
              );
              return rows;
            },
          );
          context.onStage?.({
            stage: "vector_search",
            knowledgeBaseId: kb.id,
            query,
            results: semantic.map((row, i) => ({
              chunkId: row.id,
              sourceId: row.source_id,
              rank: i + 1,
              score: Number(row.vector_score),
            })),
          });
          const lexical =
            options.mode === "hybrid"
              ? await observe(
                  "knowledge.lexical_search",
                  "chain",
                  { "knowledge.base.id": kb.id },
                  async (searchSpan) => {
                    const rows = (
                      await Promise.all(
                        selections.map(
                          (selection) =>
                            sql`${selection} AND c.search_vector @@ websearch_to_tsquery('simple',${lexicalQuery}) ORDER BY lexical_score DESC LIMIT 30`,
                        ),
                      )
                    ).flat();
                    if (preferQa)
                      rows.sort(
                        (a, b) =>
                          Number(b.lexical_score) - Number(a.lexical_score) ||
                          String(a.id).localeCompare(String(b.id)),
                      );
                    searchSpan.setAttribute("retrieval.results", rows.length);
                    searchSpan.setAttribute(
                      "retrieval.matches",
                      JSON.stringify(
                        rows.map((row, i) => ({
                          chunkId: row.id,
                          sourceId: row.source_id,
                          rank: i + 1,
                          score: Number(row.lexical_score),
                        })),
                      ),
                    );
                    searchSpan.setAttribute(
                      "langfuse.observation.metadata",
                      JSON.stringify({
                        knowledgeBaseId: kb.id,
                        results: rows.map((row, i) => ({
                          chunkId: row.id,
                          sourceId: row.source_id,
                          rank: i + 1,
                          score: Number(row.lexical_score),
                        })),
                      }),
                    );
                    observationContent(searchSpan, "input", query);
                    observationContent(
                      searchSpan,
                      "output",
                      rows.map((row, i) => ({
                        chunkId: row.id,
                        rank: i + 1,
                        score: Number(row.lexical_score),
                        content: row.content,
                      })),
                    );
                    return rows;
                  },
                )
              : [];
          if (options.mode === "hybrid")
            context.onStage?.({
              stage: "lexical_search",
              knowledgeBaseId: kb.id,
              query,
              results: lexical.map((row, i) => ({
                chunkId: row.id,
                sourceId: row.source_id,
                rank: i + 1,
                score: Number(row.lexical_score),
              })),
            });
          const fusionSpan = startObservation(
            "knowledge.ranking_fusion",
            "chain",
          );
          const pool = new Map<
            string,
            { row: Record<string, unknown>; fusion: number }
          >();
          semantic.forEach((row, index) =>
            pool.set(row.id, { row, fusion: 1 / (60 + index + 1) }),
          );
          lexical.forEach((row, index) => {
            const old = pool.get(row.id);
            pool.set(row.id, {
              row,
              fusion: (old?.fusion ?? 0) + 1 / (60 + index + 1),
            });
          });
          const fused = [...pool.values()]
            .map(({ row, fusion }) => ({
              chunkId: String(row.id),
              sourceId: String(row.source_id),
              vectorScore: Number(row.vector_score),
              lexicalScore: Number(row.lexical_score),
              vectorRank:
                semantic.findIndex((r) => r.id === row.id) + 1 || null,
              lexicalRank:
                lexical.findIndex((r) => r.id === row.id) + 1 || null,
              rrfScore: fusion,
              score:
                options.mode === "hybrid"
                  ? fusion + (row.kind === "qa" ? 0.0001 : 0)
                  : Math.max(0, Math.min(1, Number(row.vector_score))),
              eligible:
                Math.max(0, Math.min(1, Number(row.vector_score))) >=
                  options.minScore &&
                (!preferQa ||
                  row.kind !== "qa" ||
                  (!!row.reviewed &&
                    Number(row.vector_score) >=
                      (options.qaMinScore ?? DEFAULT_QA_MIN_SCORE))),
              ...(preferQa
                ? {
                    qaPreferred:
                      row.kind === "qa" &&
                      !!row.reviewed &&
                      Number(row.vector_score) >=
                        (options.qaMinScore ?? DEFAULT_QA_MIN_SCORE),
                  }
                : {}),
            }))
            .sort(
              (a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId),
            )
            .map((r, i) => ({ ...r, rank: i + 1 }));
          context.onStage?.({
            stage: "ranking_fusion",
            knowledgeBaseId: kb.id,
            query,
            results: fused,
          });
          fusionSpan.setAttribute("retrieval.mode", options.mode);
          fusionSpan.setAttribute("retrieval.rrf_constant", 60);
          fusionSpan.setAttribute("retrieval.matches", JSON.stringify(fused));
          fusionSpan.setAttribute(
            "langfuse.observation.metadata",
            JSON.stringify({
              knowledgeBaseId: kb.id,
              mode: options.mode,
              rrfConstant: 60,
              minimumScore: options.minScore,
              minimumScoreMetric: "semantic_similarity",
              results: fused,
            }),
          );
          observationContent(fusionSpan, "output", fused);
          fusionSpan.setAttribute("candidates", pool.size);
          fusionSpan.end();
          for (const { row, fusion } of pool.values()) {
            const vectorScore = Math.max(
              0,
              Math.min(1, Number(row.vector_score)),
            );
            if (vectorScore < options.minScore) continue;
            result.push({
              id: 0,
              tags: Array.isArray(row.source_tags)
                ? (row.source_tags as string[])
                : [],
              attributes:
                row.source_attributes &&
                typeof row.source_attributes === "object"
                  ? (row.source_attributes as Record<string, string>)
                  : {},
              sourceKind: row.kind as Citation["sourceKind"],
              reviewStatus: row.reviewed ? "approved" : "current",
              ...(row.release_id ? { releaseId: String(row.release_id) } : {}),
              sourceRevision: Number(row.source_revision),
              ...(row.ordinal === null
                ? {}
                : { chunkIndex: Number(row.ordinal) }),
              chunkId: String(row.id),
              documentId: String(row.document_id),
              sourceId: String(row.source_id),
              knowledgeBaseId: String(row.knowledge_base_id),
              content:
                typeof row.parent_content === "string" &&
                row.parent_content.includes(String(row.content))
                  ? row.parent_content
                  : String(row.content),
              ...(row.parent_content
                ? { contextExpanded: row.parent_content !== row.content }
                : {}),
              page: row.page as number | null,
              heading: row.heading as string | null,
              title: String(row.title),
              sourceUrl: row.source_url as string | null,
              score: vectorScore,
              rankingScore:
                options.mode === "hybrid"
                  ? fusion + (row.kind === "qa" ? 0.0001 : 0)
                  : vectorScore,
              ...(options.mode === "hybrid" ? { rrfScore: fusion } : {}),
              vectorScore,
              lexicalScore: Number(row.lexical_score),
              fusion:
                options.mode === "hybrid"
                  ? fusion + (row.kind === "qa" ? 0.0001 : 0)
                  : vectorScore,
            });
          }
        }
        result.sort(
          (a, b) => b.fusion - a.fusion || a.chunkId.localeCompare(b.chunkId),
        );
        const selected = selectEvidence(result, options, options.topK).map(
          ({ fusion, ...r }, i) => (void fusion, { ...r, id: i + 1 }),
        );
        span.setAttribute("retrieval.results", selected.length);
        span.setAttribute(
          "retrieval.preferred_qa_results",
          selected.filter((s) => preferredQa(s, options)).length,
        );
        span.setAttribute(
          "retrieval.matches",
          JSON.stringify(
            selected.map(
              ({
                chunkId,
                sourceId,
                knowledgeBaseId,
                score,
                vectorScore,
                lexicalScore,
              }) => ({
                chunkId,
                sourceId,
                knowledgeBaseId,
                score,
                vectorScore,
                lexicalScore,
              }),
            ),
          ),
        );
        observationContent(span, "output", selected);
        return selected;
      },
    );
  }
}

/** Pins are always validated; publishing also requires an available approved release. */
export async function validateKnowledgeSelection(
  rag: {
    knowledgeBaseIds: string[];
    contentMode?: string;
    releasePins?: Record<string, string>;
  },
  workspaceId: string,
  organizationId: string,
  publicAccess = false,
  requireReady = false,
  candidateReleaseId?: string,
) {
  await validateKnowledgeIds(
    rag.knowledgeBaseIds,
    workspaceId,
    organizationId,
    publicAccess,
  );
  for (const baseId of rag.knowledgeBaseIds) {
    const [kb] =
      await sql`SELECT approval_required,published_release_id FROM knowledge_bases WHERE id=${baseId} AND workspace_id=${workspaceId} AND organization_id=${organizationId} AND archived_at IS NULL`;
    const pin = rag.releasePins?.[baseId];
    if (
      !pin &&
      !(
        requireReady &&
        (rag.contentMode === "approved" || kb?.approval_required)
      )
    )
      continue;
    const [release] =
      await sql`SELECT r.id FROM knowledge_releases r WHERE r.id=${pin ?? kb?.published_release_id ?? null} AND r.knowledge_base_id=${baseId} AND r.workspace_id=${workspaceId} AND r.organization_id=${organizationId} AND (r.status='published' OR (${publicAccess}=false AND r.id=${candidateReleaseId ?? null} AND r.status='approved')) AND EXISTS(SELECT 1 FROM knowledge_release_chunks c JOIN knowledge_sources s ON s.id=c.source_id WHERE c.release_id=r.id AND s.status<>'deleted')`;
    if (!release)
      throw new HttpError(
        400,
        "Select a published knowledge release with available passages",
      );
  }
}
