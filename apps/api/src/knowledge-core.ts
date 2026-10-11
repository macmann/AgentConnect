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
  constructor(private factory: EmbeddingFactory = defaultEmbeddingFactory) {}
  async execute(
    query: string,
    ids: string[],
    options: {
      topK: number;
      minScore: number;
      mode: "vector" | "hybrid";
      sourceIds?: string[];
      contentMode?: "current" | "approved";
      releasePins?: Record<string, string>;
    },
    context: RetrievalContext,
    signal: AbortSignal,
  ): Promise<Citation[]> {
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
        const vectors = await this.factory(connection).embed(
          [query],
          signal,
          "query",
        );
        vector = validateVectors(vectors, 1, kb.dimensions)[0]!;
        queries.set(kb.embedding_model_id, vector);
      }
      const releaseId = options.releasePins?.[kb.id] ?? kb.published_release_id;
      const approved =
        !!options.releasePins?.[kb.id] ||
        options.contentMode === "approved" ||
        kb.approval_required;
      if (approved) {
        const [release] =
          await sql`SELECT id FROM knowledge_releases WHERE id=${releaseId ?? null} AND knowledge_base_id=${kb.id} AND workspace_id=${context.workspaceId} AND organization_id=${context.organizationId} AND status='published'`;
        if (!release) throw new KnowledgeError("KNOWLEDGE_RELEASE_UNAVAILABLE");
      }
      const literal = vectorLiteral(vector, kb.dimensions);
      const dim = sql.unsafe(String(kb.dimensions));
      const filters = options.sourceIds ?? [];
      const select = approved
        ? sql`SELECT c.id,c.document_id,c.source_id,c.knowledge_base_id,c.content,c.page,c.heading,c.title,c.source_url,1-(c.embedding::vector(${dim}) <=> ${literal}::vector(${dim})) AS vector_score,ts_rank_cd(c.search_vector,websearch_to_tsquery('simple',${query})) AS lexical_score,c.kind FROM knowledge_release_chunks c JOIN knowledge_sources s ON s.id=c.source_id WHERE c.release_id=${releaseId!} AND c.knowledge_base_id=${kb.id} AND c.workspace_id=${context.workspaceId} AND c.organization_id=${context.organizationId} AND s.status<>'deleted' AND (cardinality(${filters}::uuid[])=0 OR c.source_id=ANY(${filters}::uuid[]))`
        : sql`SELECT c.id,c.document_id,c.source_id,c.knowledge_base_id,c.content,c.page,c.heading,d.title,d.source_url,1-(c.embedding::vector(${dim}) <=> ${literal}::vector(${dim})) AS vector_score,ts_rank_cd(c.search_vector,websearch_to_tsquery('simple',${query})) AS lexical_score,s.kind FROM knowledge_chunks c JOIN knowledge_sources s ON s.id=c.source_id JOIN knowledge_documents d ON d.id=c.document_id WHERE c.knowledge_base_id=${kb.id} AND c.workspace_id=${context.workspaceId} AND c.organization_id=${context.organizationId} AND s.status='ready' AND (cardinality(${filters}::uuid[])=0 OR c.source_id=ANY(${filters}::uuid[]))`;
      const semantic =
        await sql`${select} ORDER BY c.embedding::vector(${dim}) <=> ${literal}::vector(${dim}) LIMIT 30`;
      const lexical =
        options.mode === "hybrid"
          ? await sql`${select} AND c.search_vector @@ websearch_to_tsquery('simple',${query}) ORDER BY lexical_score DESC LIMIT 30`
          : [];
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
      for (const { row, fusion } of pool.values()) {
        const vectorScore = Math.max(0, Math.min(1, Number(row.vector_score)));
        if (vectorScore < options.minScore) continue;
        result.push({
          id: 0,
          chunkId: String(row.id),
          documentId: String(row.document_id),
          sourceId: String(row.source_id),
          knowledgeBaseId: String(row.knowledge_base_id),
          content: String(row.content),
          page: row.page as number | null,
          heading: row.heading as string | null,
          title: String(row.title),
          sourceUrl: row.source_url as string | null,
          score: vectorScore,
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
    return result
      .slice(0, options.topK)
      .map(({ fusion, ...r }, i) => (void fusion, { ...r, id: i + 1 }));
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
      await sql`SELECT r.id FROM knowledge_releases r WHERE r.id=${pin ?? kb?.published_release_id ?? null} AND r.knowledge_base_id=${baseId} AND r.workspace_id=${workspaceId} AND r.organization_id=${organizationId} AND r.status='published' AND EXISTS(SELECT 1 FROM knowledge_release_chunks c JOIN knowledge_sources s ON s.id=c.source_id WHERE c.release_id=r.id AND s.status<>'deleted')`;
    if (!release)
      throw new HttpError(
        400,
        "Select a published knowledge release with available passages",
      );
  }
}
