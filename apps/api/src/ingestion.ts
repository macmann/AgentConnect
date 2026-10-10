import { randomUUID, createHash } from "node:crypto";
import { sql } from "./db.js";
import {
  parseDocument,
  KnowledgeError,
  type ParsedDocument,
} from "@agentconnect/rag/parsers";
import { chunkDocument } from "@agentconnect/rag/chunking";
import {
  validateVectors,
  type EmbeddingFactory,
} from "@agentconnect/provider-sdk/embeddings";
import { ProviderError } from "@agentconnect/provider-sdk";
import {
  defaultEmbeddingFactory,
  embeddingConnection,
  type KnowledgeBase,
} from "./knowledge-core.js";
import {
  readKnowledge,
  storeKnowledge,
  purgeKnowledgePrefix,
} from "./knowledge-storage.js";
import { crawlWebsite, type CrawlConfig } from "./knowledge-websites.js";
interface Job {
  id: string;
  source_id: string;
  knowledge_base_id: string;
  organization_id: string;
  workspace_id: string;
  source_revision: number;
  attempts: number;
  lease_token: string;
  payload: { objectKey?: string; filename?: string; website?: CrawlConfig };
}
export async function claimKnowledgeJob(): Promise<Job | undefined> {
  return sql.begin(async (tx) => {
    await tx`UPDATE knowledge_jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,error_code='WORKER_INTERRUPTED',locked_until=NULL,lease_token=NULL,finished_at=CASE WHEN attempts>=3 THEN now() ELSE NULL END WHERE status='running' AND locked_until<now()`;
    await tx`UPDATE knowledge_sources s SET status='failed',error_code='WORKER_INTERRUPTED',updated_at=now() FROM knowledge_jobs j WHERE j.source_id=s.id AND j.source_revision=s.revision AND j.status='failed' AND j.error_code='WORKER_INTERRUPTED' AND s.status='processing'`;
    await tx`UPDATE knowledge_jobs j SET status='cancelled',finished_at=now() FROM knowledge_sources s,knowledge_bases k WHERE j.source_id=s.id AND k.id=s.knowledge_base_id AND j.status IN ('queued','running') AND (s.status='deleted' OR k.archived_at IS NOT NULL OR s.revision<>j.source_revision)`;
    const [job] = await tx<
      Job[]
    >`SELECT j.* FROM knowledge_jobs j JOIN knowledge_sources s ON s.id=j.source_id JOIN knowledge_bases k ON k.id=j.knowledge_base_id WHERE j.status='queued' AND j.available_at<=now() AND j.attempts<3 AND s.status<>'deleted' AND s.revision=j.source_revision AND k.archived_at IS NULL ORDER BY j.available_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`;
    if (!job) return;
    const token = randomUUID();
    await tx`UPDATE knowledge_jobs SET status='running',attempts=attempts+1,lease_token=${token},locked_until=now()+interval '120 seconds' WHERE id=${job.id}`;
    await tx`UPDATE knowledge_sources SET status='processing',error_code=NULL,updated_at=now() WHERE id=${job.source_id} AND revision=${job.source_revision}`;
    return { ...job, attempts: job.attempts + 1, lease_token: token };
  });
}
export async function processKnowledgeJob(
  factory: EmbeddingFactory = defaultEmbeddingFactory,
): Promise<boolean> {
  const job = await claimKnowledgeJob();
  if (!job) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);
  timeout.unref();
  const heartbeat = setInterval(() => {
    void (async () => {
      const changed =
        await sql`UPDATE knowledge_jobs j SET locked_until=now()+interval '120 seconds' FROM knowledge_sources s,knowledge_bases k WHERE j.id=${job.id} AND j.status='running' AND j.lease_token=${job.lease_token} AND j.locked_until>now() AND s.id=j.source_id AND k.id=j.knowledge_base_id AND s.revision=j.source_revision AND s.status<>'deleted' AND k.archived_at IS NULL RETURNING j.id`;
      if (!changed.length) controller.abort();
    })().catch(() => controller.abort());
  }, 30000);
  heartbeat.unref();
  try {
    const [kb] = await sql<
      KnowledgeBase[]
    >`SELECT * FROM knowledge_bases WHERE id=${job.knowledge_base_id} AND workspace_id=${job.workspace_id} AND organization_id=${job.organization_id} AND archived_at IS NULL`;
    if (!kb) throw new KnowledgeError("KNOWLEDGE_BASE_UNAVAILABLE");
    const [source] =
      await sql`SELECT title,kind,metadata,source_url FROM knowledge_sources WHERE id=${job.source_id} AND revision=${job.source_revision} AND status<>'deleted'`;
    if (!source) throw new KnowledgeError("LEASE_LOST");
    const pages: {
      document: ParsedDocument;
      url: string | null;
      objectKey: string | null;
    }[] = [];
    if (job.payload.website) {
      const crawled = await crawlWebsite(
        job.payload.website,
        controller.signal,
      );
      for (let i = 0; i < crawled.length; i++) {
        const page = crawled[i]!;
        const key = `${job.organization_id}/${job.workspace_id}/${kb.id}/${job.source_id}/${job.source_revision}/page-${i}.html`;
        await storeKnowledge(key, page.bytes);
        pages.push({ document: page.document, url: page.url, objectKey: key });
      }
    } else {
      if (!job.payload.objectKey || !job.payload.filename)
        throw new KnowledgeError("SOURCE_MISSING");
      const bytes = await readKnowledge(
        job.payload.objectKey,
        controller.signal,
      );
      const document = await parseDocument(
        bytes,
        job.payload.filename,
        controller.signal,
      );
      document.title = source.title;
      document.metadata = {
        ...document.metadata,
        kind: source.kind,
        tags: source.metadata.tags ?? [],
        filename: job.payload.filename,
        ...(source.metadata.connectorId
          ? {
              connectorId: source.metadata.connectorId,
              externalKey: source.metadata.externalKey,
            }
          : {}),
      };
      pages.push({
        document,
        url: source.source_url,
        objectKey: job.payload.objectKey,
      });
    }
    const embedding = factory(
      await embeddingConnection(
        kb.embedding_model_id,
        job.workspace_id,
        job.organization_id,
      ),
    );
    const prepared: {
      id: string;
      title: string;
      url: string | null;
      metadata: Record<string, unknown>;
      pageCount: number;
      hash: string;
      chunks: {
        content: string;
        page: number | null;
        heading: string | null;
        metadata: Record<string, unknown>;
        vector: number[];
      }[];
    }[] = [];
    let total = 0;
    for (const page of pages) {
      const chunks = chunkDocument(page.document, {
        chunkSize: kb.chunk_size,
        chunkOverlap: kb.chunk_overlap,
        chunkStrategy: kb.chunk_strategy,
      });
      total += chunks.length;
      if (total > 500) throw new KnowledgeError("CHUNK_LIMIT");
      if (!chunks.length) throw new KnowledgeError("NO_EXTRACTABLE_TEXT");
      const vectors: number[][] = [];
      for (let i = 0; i < chunks.length; i += 32) {
        controller.signal.throwIfAborted();
        const batch = chunks.slice(i, i + 32);
        vectors.push(
          ...validateVectors(
            await embedding.embed(
              batch.map((c) => c.content),
              controller.signal,
              "document",
            ),
            batch.length,
            kb.dimensions,
          ),
        );
      }
      prepared.push({
        id: randomUUID(),
        title: page.document.title,
        url: page.url,
        metadata: { ...page.document.metadata, objectKey: page.objectKey },
        pageCount: Math.max(
          1,
          ...page.document.sections.map((s) => s.page ?? 1),
        ),
        hash: createHash("sha256")
          .update(page.document.sections.map((s) => s.text).join("\n"))
          .digest("hex"),
        chunks: chunks.map((c, i) => ({ ...c, vector: vectors[i]! })),
      });
    }
    controller.signal.throwIfAborted();
    await sql.begin(async (tx) => {
      const [locked] =
        await tx`SELECT j.id FROM knowledge_jobs j JOIN knowledge_sources s ON s.id=j.source_id JOIN knowledge_bases k ON k.id=j.knowledge_base_id WHERE j.id=${job.id} AND j.status='running' AND j.lease_token=${job.lease_token} AND j.locked_until>now() AND s.revision=${job.source_revision} AND s.status<>'deleted' AND k.archived_at IS NULL FOR UPDATE OF j,s,k`;
      if (!locked) throw new KnowledgeError("LEASE_LOST");
      await tx`DELETE FROM knowledge_documents WHERE source_id=${job.source_id}`;
      for (const d of prepared) {
        await tx`INSERT INTO knowledge_documents(id,source_id,knowledge_base_id,workspace_id,organization_id,title,source_url,metadata,page_count,content_hash,revision) VALUES (${d.id},${job.source_id},${kb.id},${job.workspace_id},${job.organization_id},${d.title},${d.url},${tx.json(JSON.parse(JSON.stringify(d.metadata)))},${d.pageCount},${d.hash},${job.source_revision})`;
        for (let i = 0; i < d.chunks.length; i++) {
          const c = d.chunks[i]!;
          await tx`INSERT INTO knowledge_chunks(id,document_id,source_id,knowledge_base_id,workspace_id,organization_id,embedding_model_id,dimensions,ordinal,content,page,heading,metadata,embedding) VALUES (${randomUUID()},${d.id},${job.source_id},${kb.id},${job.workspace_id},${job.organization_id},${kb.embedding_model_id},${kb.dimensions},${i},${c.content},${c.page},${c.heading},${tx.json(JSON.parse(JSON.stringify(c.metadata)))},${"[" + c.vector.join(",") + "]"}::vector)`;
        }
      }
      await tx`UPDATE knowledge_jobs SET status='completed',finished_at=now(),locked_until=NULL,lease_token=NULL,error_code=NULL WHERE id=${job.id}`;
      await tx`UPDATE knowledge_sources SET status='ready',error_code=NULL,updated_at=now() WHERE id=${job.source_id} AND revision=${job.source_revision}`;
    });
  } catch (error) {
    const code = controller.signal.aborted
      ? "INGESTION_CANCELLED"
      : error instanceof KnowledgeError || error instanceof ProviderError
        ? error.code
        : "INGESTION_ERROR";
    const retryable =
      error instanceof KnowledgeError || error instanceof ProviderError
        ? error.retryable
        : false;
    const retry = retryable && job.attempts < 3;
    await sql.begin(async (tx) => {
      const changed =
        await tx`UPDATE knowledge_jobs SET status=${retry ? "queued" : "failed"},error_code=${code},available_at=now()+${Math.min(60, 2 ** job.attempts)}*interval '1 second',locked_until=NULL,lease_token=NULL,finished_at=${retry ? null : new Date()} WHERE id=${job.id} AND status='running' AND lease_token=${job.lease_token} RETURNING id`;
      if (changed.length)
        await tx`UPDATE knowledge_sources SET status=${retry ? "queued" : "failed"},error_code=${code},updated_at=now() WHERE id=${job.source_id} AND revision=${job.source_revision} AND status<>'deleted'`;
    });
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
  }
  return true;
}

export async function purgeDeletedKnowledge(): Promise<boolean> {
  // Give in-flight jobs longer than their five-minute deadline before deleting
  // raw objects. Tombstones retain purge state so failures retry durably.
  const [source] =
    await sql`SELECT id,organization_id,workspace_id,knowledge_base_id FROM knowledge_sources WHERE status='deleted' AND updated_at<now()-interval '10 minutes' AND COALESCE(metadata->>'objectsPurged','false')<>'true' ORDER BY updated_at LIMIT 1`;
  if (!source) return false;
  await purgeKnowledgePrefix(
    `${source.organization_id}/${source.workspace_id}/${source.knowledge_base_id}/${source.id}/`,
  );
  await sql`UPDATE knowledge_sources SET object_key=NULL,metadata='{"objectsPurged":true}'::jsonb WHERE id=${source.id} AND status='deleted'`;
  return true;
}
