import { metadataFilter } from "@agentconnect/schemas/knowledge-metadata";
import type {
  Citation,
  RagTool,
  RetrievalContext,
} from "@agentconnect/rag/tool";
import { KnowledgeError } from "@agentconnect/rag/parsers";
import { sql } from "./db.js";

/** Expand only an authorized seed's exact document/version, never UUID order. */
export async function expandKnowledgeNeighbors(
  seeds: Citation[],
  options: Parameters<RagTool["execute"]>[2] & {
    previous: number;
    next: number;
  },
  context: RetrievalContext,
  signal: AbortSignal,
) {
  const result: Citation[] = [];
  const metadata = metadataFilter.parse(options.metadataFilter ?? {});
  const previous = Math.max(0, Math.min(3, options.previous));
  const next = Math.max(0, Math.min(3, options.next));
  for (const seed of seeds.slice(0, 10)) {
    signal.throwIfAborted();
    if (seed.chunkIndex === undefined || seed.sourceKind === "qa") continue;
    if (
      options.releasePins?.[seed.knowledgeBaseId] &&
      options.releasePins[seed.knowledgeBaseId] !== seed.releaseId
    )
      continue;
    if (options.sourceIds?.length && !options.sourceIds.includes(seed.sourceId))
      continue;
    const [base] =
      await sql`SELECT id,public_access,approval_required FROM knowledge_bases WHERE id=${seed.knowledgeBaseId} AND workspace_id=${context.workspaceId} AND organization_id=${context.organizationId} AND archived_at IS NULL`;
    if (!base || (context.publicAccess && !base.public_access))
      throw new KnowledgeError("KNOWLEDGE_BASE_UNAVAILABLE");
    if (
      !seed.releaseId &&
      (base.approval_required ||
        options.contentMode === "approved" ||
        options.releasePins?.[seed.knowledgeBaseId])
    )
      continue;
    const rows = seed.releaseId
      ? await sql`SELECT c.id,c.ordinal,c.content,c.page,c.heading FROM knowledge_release_chunks c
          JOIN knowledge_release_chunks a ON a.release_id=c.release_id AND a.document_id=c.document_id AND a.source_id=c.source_id
          JOIN knowledge_releases r ON r.id=c.release_id AND r.knowledge_base_id=c.knowledge_base_id AND r.workspace_id=c.workspace_id AND r.organization_id=c.organization_id
          JOIN knowledge_sources s ON s.id=c.source_id AND s.knowledge_base_id=c.knowledge_base_id AND s.workspace_id=c.workspace_id AND s.organization_id=c.organization_id
          WHERE a.id=${seed.chunkId} AND c.release_id=${seed.releaseId} AND c.document_id=${seed.documentId} AND c.source_id=${seed.sourceId} AND c.source_revision=${seed.sourceRevision ?? null} AND a.source_revision=c.source_revision
          AND c.knowledge_base_id=${seed.knowledgeBaseId} AND c.workspace_id=${context.workspaceId} AND c.organization_id=${context.organizationId}
          AND (r.status='published' OR (${context.publicAccess}=false AND r.id=${context.candidateReleaseId ?? null} AND r.status='approved'))
          AND s.status<>'deleted' AND c.id<>a.id AND c.ordinal BETWEEN a.ordinal-${previous} AND a.ordinal+${next}
          AND COALESCE(c.metadata->'sourceTags','[]'::jsonb) @> ${sql.json(metadata.tagsAll)}::jsonb
          AND COALESCE(c.metadata->'sourceAttributes','{}'::jsonb) @> ${sql.json(metadata.attributes)}::jsonb
          ORDER BY c.ordinal LIMIT ${previous + next}`
      : await sql`SELECT c.id,c.ordinal,c.content,c.page,c.heading FROM knowledge_chunks c
          JOIN knowledge_chunks a ON a.document_id=c.document_id AND a.source_id=c.source_id
          JOIN knowledge_sources s ON s.id=c.source_id AND s.knowledge_base_id=c.knowledge_base_id AND s.workspace_id=c.workspace_id AND s.organization_id=c.organization_id
          WHERE a.id=${seed.chunkId} AND c.document_id=${seed.documentId} AND c.source_id=${seed.sourceId}
          AND c.knowledge_base_id=${seed.knowledgeBaseId} AND c.workspace_id=${context.workspaceId} AND c.organization_id=${context.organizationId}
          AND s.revision=${seed.sourceRevision ?? null} AND s.status='ready' AND c.id<>a.id AND c.ordinal BETWEEN a.ordinal-${previous} AND a.ordinal+${next}
          AND COALESCE(s.metadata->'tags','[]'::jsonb) @> ${sql.json(metadata.tagsAll)}::jsonb
          AND COALESCE(s.metadata->'attributes','{}'::jsonb) @> ${sql.json(metadata.attributes)}::jsonb
          ORDER BY c.ordinal LIMIT ${previous + next}`;
    signal.throwIfAborted();
    result.push(
      ...rows.map((row) => ({
        ...seed,
        id: 0,
        chunkId: String(row.id),
        chunkIndex: Number(row.ordinal),
        content: String(row.content),
        page: row.page as number | null,
        heading: row.heading as string | null,
        neighborOf: seed.chunkId,
        contextExpanded: true,
        score: 0,
        vectorScore: 0,
        lexicalScore: 0,
        rrfScore: undefined,
        rerankScore: undefined,
      })),
    );
  }
  return result;
}
