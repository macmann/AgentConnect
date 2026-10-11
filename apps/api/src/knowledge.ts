import { registerKnowledgeReleases } from "./knowledge-releases.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { stringify } from "csv-stringify/sync";
import { parse as parseCSV } from "csv-parse/sync";
import {
  embeddingInput,
  knowledgeInput,
  knowledgeUpdate,
  textSource,
  qaInput,
  websiteInput,
  retrievalInput,
} from "@agentconnect/schemas/knowledge";
import { supportedExtensions } from "@agentconnect/rag/parsers";
import { validateEndpoint, defaultBaseUrls } from "@agentconnect/provider-sdk";
import type { EmbeddingFactory } from "@agentconnect/provider-sdk/embeddings";
import { actor, workspaceAccess, audit, HttpError, id, params } from "./app.js";
import { sql } from "./db.js";
import { config } from "./config.js";
import { storeKnowledge, deleteKnowledge } from "./knowledge-storage.js";
import {
  hosts,
  embeddingConnection,
  defaultEmbeddingFactory,
  PostgresRagTool,
  type KnowledgeBase,
} from "./knowledge-core.js";
import { validateWebsite } from "./knowledge-websites.js";
export async function ownedKnowledge(
  r: FastifyRequest,
  cap:
    | "knowledge:read"
    | "knowledge:manage"
    | "knowledge:retrieve" = "knowledge:read",
) {
  const u = await actor(r);
  const [kb] = await sql<
    KnowledgeBase[]
  >`SELECT * FROM knowledge_bases WHERE id=${id(params(r).knowledgeBaseId)} AND archived_at IS NULL`;
  if (!kb) throw new HttpError(404, "Knowledge base unavailable");
  const w = await workspaceAccess(u.id, kb.workspace_id, cap);
  return { u, w, kb };
}
async function sourceFor(r: FastifyRequest, kb: KnowledgeBase) {
  const [source] =
    await sql`SELECT * FROM knowledge_sources WHERE id=${id(params(r).sourceId)} AND knowledge_base_id=${kb.id} AND workspace_id=${kb.workspace_id} AND organization_id=${kb.organization_id} AND status<>'deleted'`;
  if (!source) throw new HttpError(404, "Source not found");
  return source;
}
async function addSource(
  r: FastifyRequest,
  kb: KnowledgeBase,
  userId: string,
  kind: "upload" | "text" | "qa" | "website",
  title: string,
  bytes: Uint8Array | null,
  filename: string | null,
  metadata: Record<string, unknown>,
  sourceUrl: string | null = null,
) {
  const sourceId = randomUUID();
  const key = bytes
    ? `${kb.organization_id}/${kb.workspace_id}/${kb.id}/${sourceId}/1/input`
    : null;
  if (key && bytes) await storeKnowledge(key, bytes);
  try {
    await sql.begin(async (tx) => {
      const [active] =
        await tx`SELECT id FROM knowledge_bases WHERE id=${kb.id} AND archived_at IS NULL FOR SHARE`;
      if (!active) throw new HttpError(404, "Knowledge base unavailable");
      await tx`INSERT INTO knowledge_sources(id,knowledge_base_id,workspace_id,organization_id,kind,title,filename,object_key,source_url,byte_size,metadata,status) VALUES (${sourceId},${kb.id},${kb.workspace_id},${kb.organization_id},${kind},${title},${filename},${key},${sourceUrl},${bytes?.byteLength ?? 0},${tx.json(JSON.parse(JSON.stringify(metadata)))},'queued')`;
      await tx`INSERT INTO knowledge_jobs(id,source_id,knowledge_base_id,workspace_id,organization_id,source_revision,payload,status) VALUES (${randomUUID()},${sourceId},${kb.id},${kb.workspace_id},${kb.organization_id},1,${tx.json(kind === "website" ? { website: JSON.parse(JSON.stringify(metadata)) } : { objectKey: key, filename })},'queued')`;
      await audit(
        tx,
        r,
        userId,
        "knowledge.source_added",
        sourceId,
        kb.organization_id,
        kb.workspace_id,
      );
    });
  } catch (e) {
    if (key) await deleteKnowledge(key).catch(() => {});
    throw e;
  }
  return { id: sourceId, status: "queued" };
}
export async function registerKnowledgeRoutes(
  app: FastifyInstance,
  override?: EmbeddingFactory,
) {
  await app.register(multipart, {
    limits: { fileSize: 10000000, files: 1, fields: 3, parts: 4 },
  });
  await registerKnowledgeReleases(app, ownedKnowledge);
  const factory = override ?? defaultEmbeddingFactory;
  const rag = new PostgresRagTool(factory);
  const schema = (body: z.ZodType) => ({
    schema: { body: z.toJSONSchema(body, { io: "input", target: "draft-7" }) },
  });
  app.get("/workspaces/:workspaceId/embedding-models", async (r) => {
    const u = await actor(r);
    const w = await workspaceAccess(
      u.id,
      id(params(r).workspaceId),
      "knowledge:read",
    );
    return sql`SELECT id,name,provider,model_id,base_url,secret_id,dimensions FROM embedding_models WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} ORDER BY name`;
  });
  app.post(
    "/workspaces/:workspaceId/embedding-models",
    schema(embeddingInput),
    async (r, reply) => {
      const u = await actor(r);
      const w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "model:manage",
      );
      const data = embeddingInput.parse(r.body);
      const baseUrl = data.baseUrl ?? defaultBaseUrls[data.provider];
      validateEndpoint(
        baseUrl,
        hosts(config.MODEL_ALLOWED_HOSTS),
        hosts(config.MODEL_PRIVATE_HOSTS),
      );
      if (data.provider !== "openai-compatible" && !data.secretId)
        throw new HttpError(400, "Select an encrypted workspace credential");
      if (data.secretId) {
        const [s] =
          await sql`SELECT id FROM secrets WHERE id=${data.secretId} AND workspace_id=${w.id} AND organization_id=${w.organization_id}`;
        if (!s)
          throw new HttpError(400, "Credential must belong to this workspace");
      }
      const modelId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`INSERT INTO embedding_models(id,workspace_id,organization_id,name,provider,model_id,base_url,secret_id,dimensions) VALUES (${modelId},${w.id},${w.organization_id},${data.name},${data.provider},${data.modelId},${baseUrl},${data.secretId},${data.dimensions})`;
        await audit(
          tx,
          r,
          u.id,
          "embedding_model.created",
          modelId,
          w.organization_id,
          w.id,
        );
      });
      return reply.code(201).send({ id: modelId });
    },
  );
  app.post(
    "/workspaces/:workspaceId/embedding-models/:modelId/test",
    async (r) => {
      const u = await actor(r);
      const w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "model:manage",
      );
      const c = await embeddingConnection(
        id(params(r).modelId),
        w.id,
        w.organization_id,
      );
      const vectors = await factory(c).embed(
        ["Connection test"],
        AbortSignal.timeout(30000),
        "query",
      );
      return { ok: true, dimensions: vectors[0]?.length };
    },
  );
  app.get("/workspaces/:workspaceId/knowledge-bases", async (r) => {
    const u = await actor(r);
    const w = await workspaceAccess(
      u.id,
      id(params(r).workspaceId),
      "knowledge:read",
    );
    return sql`SELECT k.id,k.name,k.description,k.public_access,k.approval_required,k.published_release_id,k.revision,k.embedding_model_id,k.dimensions,k.chunk_size,k.chunk_overlap,k.chunk_strategy,count(s.id) FILTER(WHERE s.status<>'deleted')::int AS source_count,count(s.id) FILTER(WHERE s.status='ready')::int AS ready_count,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'available_sources',(SELECT count(DISTINCT rc.source_id)::int FROM knowledge_release_chunks rc JOIN knowledge_sources rs ON rs.id=rc.source_id WHERE rc.release_id=r.id AND rs.status<>'deleted'))) FROM knowledge_releases r WHERE r.knowledge_base_id=k.id AND r.status='published'),'[]'::jsonb) AS published_releases FROM knowledge_bases k LEFT JOIN knowledge_sources s ON s.knowledge_base_id=k.id WHERE k.workspace_id=${w.id} AND k.organization_id=${w.organization_id} AND k.archived_at IS NULL GROUP BY k.id ORDER BY k.created_at DESC`;
  });
  app.post(
    "/workspaces/:workspaceId/knowledge-bases",
    schema(knowledgeInput),
    async (r, reply) => {
      const u = await actor(r);
      const w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "knowledge:manage",
      );
      const data = knowledgeInput.parse(r.body);
      const [model] =
        await sql`SELECT dimensions FROM embedding_models WHERE id=${data.embeddingModelId} AND workspace_id=${w.id} AND organization_id=${w.organization_id}`;
      if (!model)
        throw new HttpError(
          400,
          "Embedding model must belong to this workspace",
        );
      await embeddingConnection(data.embeddingModelId, w.id, w.organization_id);
      const kbId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`INSERT INTO knowledge_bases(id,workspace_id,organization_id,name,description,embedding_model_id,dimensions,chunk_size,chunk_overlap,chunk_strategy,public_access,approval_required) VALUES (${kbId},${w.id},${w.organization_id},${data.name},${data.description},${data.embeddingModelId},${model.dimensions},${data.chunkSize},${data.chunkOverlap},${data.chunkStrategy},${data.publicAccess},${data.approvalRequired})`;
        // UUID is generated here; dimensions is constrained by embedding_models.
        await tx.unsafe(
          `CREATE INDEX kb_${kbId.replaceAll("-", "")} ON knowledge_chunks USING hnsw ((embedding::vector(${Number(model.dimensions)})) vector_cosine_ops) WHERE knowledge_base_id='${kbId}'`,
        );
        await audit(
          tx,
          r,
          u.id,
          "knowledge.created",
          kbId,
          w.organization_id,
          w.id,
        );
      });
      return reply.code(201).send({ id: kbId });
    },
  );
  app.get("/knowledge-bases/:knowledgeBaseId", async (r) => {
    const { kb } = await ownedKnowledge(r);
    return kb;
  });
  app.put(
    "/knowledge-bases/:knowledgeBaseId",
    schema(knowledgeUpdate),
    async (r) => {
      const { u, kb } = await ownedKnowledge(r, "knowledge:manage");
      const data = knowledgeUpdate.parse(r.body);
      if (
        data.approvalRequired !== undefined &&
        data.approvalRequired !== kb.approval_required
      )
        await workspaceAccess(u.id, kb.workspace_id, "knowledge:approve");
      return sql.begin(async (tx) => {
        const [saved] =
          await tx`UPDATE knowledge_bases SET name=${data.name},description=${data.description},public_access=${data.publicAccess},approval_required=${data.approvalRequired ?? kb.approval_required},revision=revision+1 WHERE id=${kb.id} AND revision=${data.revision} RETURNING revision`;
        if (!saved)
          throw new HttpError(409, "Knowledge base changed; reload first");
        await audit(
          tx,
          r,
          u.id,
          "knowledge.updated",
          kb.id,
          kb.organization_id,
          kb.workspace_id,
        );
        return saved;
      });
    },
  );
  app.delete("/knowledge-bases/:knowledgeBaseId", async (r) => {
    const { u, kb } = await ownedKnowledge(r, "knowledge:manage");
    await sql.begin(async (tx) => {
      await tx`UPDATE knowledge_bases SET archived_at=now(),public_access=false WHERE id=${kb.id}`;
      await tx`UPDATE knowledge_sources SET status='deleted',updated_at=now() WHERE knowledge_base_id=${kb.id}`;
      await tx`UPDATE knowledge_jobs SET status='cancelled',finished_at=now() WHERE knowledge_base_id=${kb.id} AND status IN ('queued','running')`;
      await tx`DELETE FROM knowledge_documents WHERE knowledge_base_id=${kb.id}`;
      await tx.unsafe(`DROP INDEX IF EXISTS kb_${kb.id.replaceAll("-", "")}`);
      await audit(
        tx,
        r,
        u.id,
        "knowledge.archived",
        kb.id,
        kb.organization_id,
        kb.workspace_id,
      );
    });
    return { ok: true };
  });
  app.get("/knowledge-bases/:knowledgeBaseId/sources", async (r) => {
    const { kb } = await ownedKnowledge(r);
    return sql`SELECT s.id,s.kind,s.title,s.filename,s.source_url,s.byte_size,s.metadata,s.status,s.error_code,s.revision,s.created_at,count(DISTINCT d.id)::int AS document_count,count(c.id)::int AS chunk_count FROM knowledge_sources s LEFT JOIN knowledge_documents d ON d.source_id=s.id LEFT JOIN knowledge_chunks c ON c.document_id=d.id WHERE s.knowledge_base_id=${kb.id} AND s.status<>'deleted' GROUP BY s.id ORDER BY s.created_at DESC`;
  });
  app.post(
    "/knowledge-bases/:knowledgeBaseId/upload",
    { bodyLimit: 11000000 },
    async (r, reply) => {
      const { u, kb } = await ownedKnowledge(r, "knowledge:manage");
      const file = await r.file();
      if (!file) throw new HttpError(400, "Select a document");
      const filename = file.filename.split(/[\\/]/).at(-1)!.slice(0, 200);
      const ext = filename.split(".").at(-1)?.toLowerCase() ?? "";
      if (!supportedExtensions.includes(ext))
        throw new HttpError(400, "Unsupported file type");
      const bytes = await file.toBuffer();
      if (file.file.truncated || !bytes.length)
        throw new HttpError(400, "Document is empty or exceeds 10 MB");
      return reply
        .code(202)
        .send(
          await addSource(r, kb, u.id, "upload", filename, bytes, filename, {}),
        );
    },
  );
  app.post(
    "/knowledge-bases/:knowledgeBaseId/text",
    { ...schema(textSource), bodyLimit: 1000000 },
    async (r, reply) => {
      const { u, kb } = await ownedKnowledge(r, "knowledge:manage");
      const data = textSource.parse(r.body);
      return reply
        .code(202)
        .send(
          await addSource(
            r,
            kb,
            u.id,
            "text",
            data.title,
            Buffer.from(data.text),
            data.title + ".txt",
            {},
          ),
        );
    },
  );
  app.post(
    "/knowledge-bases/:knowledgeBaseId/qa",
    { ...schema(qaInput), bodyLimit: 100000 },
    async (r, reply) => {
      const { u, kb } = await ownedKnowledge(r, "knowledge:manage");
      const data = qaInput.parse(r.body);
      return reply
        .code(202)
        .send(
          await addSource(
            r,
            kb,
            u.id,
            "qa",
            data.question,
            Buffer.from(
              "Question: " + data.question + "\nAnswer: " + data.answer,
            ),
            "qa.txt",
            data,
          ),
        );
    },
  );
  app.put(
    "/knowledge-bases/:knowledgeBaseId/sources/:sourceId/qa",
    { ...schema(qaInput), bodyLimit: 100000 },
    async (r) => {
      const { u, kb } = await ownedKnowledge(r, "knowledge:manage");
      const source = await sourceFor(r, kb);
      if (source.kind !== "qa") throw new HttpError(400, "Source is not Q&A");
      const data = qaInput.parse(r.body);
      const bytes = Buffer.from(
        "Question: " + data.question + "\nAnswer: " + data.answer,
      );
      const key = `${kb.organization_id}/${kb.workspace_id}/${kb.id}/${source.id}/${randomUUID()}/input`;
      await storeKnowledge(key, bytes);
      try {
        return await sql.begin(async (tx) => {
          const [saved] =
            await tx`UPDATE knowledge_sources SET title=${data.question},metadata=${tx.json(data)},object_key=${key},byte_size=${bytes.length},revision=revision+1,status='queued',error_code=NULL,updated_at=now() WHERE id=${source.id} AND revision=${source.revision} RETURNING revision`;
          if (!saved) throw new HttpError(409, "Q&A changed; reload first");
          await tx`INSERT INTO knowledge_jobs(id,source_id,knowledge_base_id,workspace_id,organization_id,source_revision,payload,status) VALUES (${randomUUID()},${source.id},${kb.id},${kb.workspace_id},${kb.organization_id},${saved.revision},${tx.json({ objectKey: key, filename: "qa.txt" })},'queued')`;
          await audit(
            tx,
            r,
            u.id,
            "knowledge.qa_updated",
            source.id,
            kb.organization_id,
            kb.workspace_id,
          );
          return saved;
        });
      } catch (error) {
        await deleteKnowledge(key).catch(() => {});
        throw error;
      }
    },
  );
  app.get("/knowledge-bases/:knowledgeBaseId/qa/export", async (r, reply) => {
    const { kb } = await ownedKnowledge(r);
    const rows =
      await sql`SELECT metadata FROM knowledge_sources WHERE knowledge_base_id=${kb.id} AND kind='qa' AND status<>'deleted' ORDER BY created_at`;
    const csv = stringify(
      rows.map((row) => ({
        question: row.metadata.question,
        answer: row.metadata.answer,
        tags: (row.metadata.tags ?? []).join("|"),
      })),
      {
        header: true,
        columns: ["question", "answer", "tags"],
        escape_formulas: true,
      },
    );
    return reply
      .type("text/csv")
      .header("Content-Disposition", 'attachment; filename="knowledge-qa.csv"')
      .send(csv);
  });
  app.post(
    "/knowledge-bases/:knowledgeBaseId/qa/import",
    {
      ...schema(z.object({ csv: z.string().min(1).max(200000) })),
      bodyLimit: 1000000,
    },
    async (r, reply) => {
      const { u, kb } = await ownedKnowledge(r, "knowledge:manage");
      const data = z
        .object({ csv: z.string().min(1).max(200000) })
        .parse(r.body);
      let rows: unknown[];
      try {
        rows = parseCSV(data.csv, {
          columns: true,
          bom: true,
          skip_empty_lines: true,
          max_record_size: 22000,
        });
      } catch {
        throw new HttpError(400, "Invalid Q&A CSV");
      }
      if (rows.length > 100)
        throw new HttpError(400, "Import at most 100 Q&A rows");
      const entries = rows.map((v) => {
        const row = v as Record<string, string>;
        return qaInput.parse({
          question: row.question,
          answer: row.answer,
          tags: (row.tags ?? "").split("|").filter(Boolean),
        });
      });
      const created = [];
      for (const item of entries)
        created.push(
          await addSource(
            r,
            kb,
            u.id,
            "qa",
            item.question,
            Buffer.from(
              "Question: " + item.question + "\nAnswer: " + item.answer,
            ),
            "qa.txt",
            item,
          ),
        );
      return reply.code(202).send({ sources: created });
    },
  );
  app.post(
    "/knowledge-bases/:knowledgeBaseId/website",
    schema(websiteInput),
    async (r, reply) => {
      const { u, kb } = await ownedKnowledge(r, "knowledge:manage");
      const data = websiteInput.parse(r.body);
      validateWebsite(data.url);
      return reply
        .code(202)
        .send(
          await addSource(
            r,
            kb,
            u.id,
            "website",
            data.url,
            null,
            null,
            data,
            data.url,
          ),
        );
    },
  );
  app.post(
    "/knowledge-bases/:knowledgeBaseId/sources/:sourceId/reingest",
    async (r) => {
      const { u, kb } = await ownedKnowledge(r, "knowledge:manage");
      const s = await sourceFor(r, kb);
      return sql.begin(async (tx) => {
        const [saved] =
          await tx`UPDATE knowledge_sources SET revision=revision+1,status='queued',error_code=NULL,updated_at=now() WHERE id=${s.id} AND revision=${s.revision} RETURNING revision`;
        if (!saved) throw new HttpError(409, "Source changed");
        await tx`INSERT INTO knowledge_jobs(id,source_id,knowledge_base_id,workspace_id,organization_id,source_revision,payload,status) VALUES (${randomUUID()},${s.id},${kb.id},${kb.workspace_id},${kb.organization_id},${saved.revision},${tx.json(s.kind === "website" ? { website: s.metadata } : { objectKey: s.object_key, filename: s.filename })},'queued')`;
        await audit(
          tx,
          r,
          u.id,
          "knowledge.reingest",
          s.id,
          kb.organization_id,
          kb.workspace_id,
        );
        return { status: "queued", revision: saved.revision };
      });
    },
  );
  app.delete(
    "/knowledge-bases/:knowledgeBaseId/sources/:sourceId",
    async (r) => {
      const { u, kb } = await ownedKnowledge(r, "knowledge:manage");
      const source = await sourceFor(r, kb);
      await sql.begin(async (tx) => {
        await tx`UPDATE knowledge_sources SET status='deleted',updated_at=now(),revision=revision+1 WHERE id=${source.id}`;
        await tx`UPDATE knowledge_jobs SET status='cancelled',finished_at=now() WHERE source_id=${source.id} AND status IN ('queued','running')`;
        await tx`DELETE FROM knowledge_documents WHERE source_id=${source.id}`;
        await audit(
          tx,
          r,
          u.id,
          "knowledge.source_deleted",
          source.id,
          kb.organization_id,
          kb.workspace_id,
        );
      });
      return { ok: true };
    },
  );
  app.get(
    "/knowledge-bases/:knowledgeBaseId/sources/:sourceId/chunks",
    async (r) => {
      const { kb } = await ownedKnowledge(r);
      const source = await sourceFor(r, kb);
      return sql`SELECT c.id,c.content,c.page,c.heading,d.title,d.source_url,d.metadata FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id WHERE c.source_id=${source.id} AND c.workspace_id=${kb.workspace_id} ORDER BY d.created_at,c.ordinal LIMIT 100`;
    },
  );
  app.post(
    "/knowledge-bases/:knowledgeBaseId/search",
    schema(retrievalInput),
    async (r) => {
      const { kb } = await ownedKnowledge(r, "knowledge:retrieve");
      const data = retrievalInput.parse(r.body);
      const started = performance.now();
      const results = await rag.execute(
        data.query,
        [kb.id],
        data,
        {
          workspaceId: kb.workspace_id,
          organizationId: kb.organization_id,
          publicAccess: false,
        },
        AbortSignal.timeout(30000),
      );
      return {
        query: data.query,
        rewrittenQuery: null,
        mode: data.mode,
        latencyMs: Math.round(performance.now() - started),
        estimatedTokens: Math.ceil(
          results.reduce((n, s) => n + s.content.length, 0) / 4,
        ),
        results,
      };
    },
  );
}
