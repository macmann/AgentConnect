import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "./app.js";
import { HttpError } from "./http-error.js";
import { sql } from "./db.js";
import {
  readParsedArtifact,
  saveParsedArtifact,
  ownedArtifact,
} from "./knowledge-artifacts.js";
import { readKnowledge } from "./knowledge-storage.js";
import {
  extractedPage,
  extractionSections,
  validateExtraction,
} from "./vision-extraction.js";

export async function registerExtractionReview(
  app: FastifyInstance,
  own: typeof import("./knowledge.js").ownedKnowledge,
  sourceFor: typeof import("./knowledge.js").sourceFor,
) {
  const path = "/knowledge-bases/:knowledgeBaseId/sources/:sourceId/extraction";
  app.get(path + "/usage", async (r) => {
    const { kb } = await own(r);
    const source = await sourceFor(r, kb);
    const rows =
      await sql`SELECT id,source_revision,attempt,stage,page,model_name,provider,status,input_tokens,output_tokens,input_usd_per_million::float8,output_usd_per_million::float8,estimated_cost_usd::float8,duration_ms,error_code,trace_id,started_at,finished_at FROM knowledge_processing_usage WHERE source_id=${source.id} AND knowledge_base_id=${kb.id} AND workspace_id=${kb.workspace_id} AND organization_id=${kb.organization_id} ORDER BY started_at DESC,id DESC LIMIT 1001`;
    const [summary] =
      await sql`SELECT count(*)::int AS events,count(*) FILTER (WHERE status='cached')::int AS cache_hits,count(*) FILTER (WHERE status='failed')::int AS failures,count(*) FILTER (WHERE status='running')::int AS running,count(*) FILTER (WHERE stage<>'correction' AND status IN ('completed','failed','running'))::int AS model_attempts,sum(input_tokens)::float8 AS reported_input_tokens,sum(output_tokens)::float8 AS reported_output_tokens,sum(estimated_cost_usd)::float8 AS known_estimated_cost_usd,count(*) FILTER (WHERE estimated_cost_usd IS NULL)::int AS unknown_cost_events FROM knowledge_processing_usage WHERE source_id=${source.id} AND knowledge_base_id=${kb.id} AND workspace_id=${kb.workspace_id} AND organization_id=${kb.organization_id}`;
    return {
      rows: rows.slice(0, 1000),
      truncated: rows.length > 1000,
      summary,
    };
  });
  app.get(path + "/page-image", async (r, reply) => {
    const { kb } = await own(r);
    const source = await sourceFor(r, kb);
    const { revision, page } = z
      .object({
        revision: z.coerce.number().int().positive(),
        page: z.coerce.number().int().min(1).max(200),
      })
      .parse(r.query);
    if (revision !== source.revision)
      throw new HttpError(409, "Source changed; reload extraction review");

    const [document] =
      await sql`SELECT metadata FROM knowledge_documents WHERE source_id=${source.id} AND revision=${revision} AND workspace_id=${kb.workspace_id} AND organization_id=${kb.organization_id}`;
    const report = document?.metadata.aiExtraction?.pages?.find(
      (p: { page: number }) => p.page === page,
    );
    if (!report?.imageKey)
      throw new HttpError(
        409,
        "Original preview is not prepared. Reingest this source once to prepare it; cached extraction is reused.",
      );
    const prefix = `${kb.organization_id}/${kb.workspace_id}/${kb.id}/${source.id}/images/`;
    const mime = z
      .enum(["image/png", "image/jpeg", "image/webp"])
      .parse(report.mimeType);
    const image = await readKnowledge(
      ownedArtifact(report.imageKey, prefix),
      AbortSignal.timeout(30000),
    );
    return reply
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff")
      .type(mime)
      .send(image);
  });
  app.put(path + "/corrections", { bodyLimit: 2200000 }, async (r, reply) => {
    const { u, kb } = await own(r, "knowledge:manage");
    const source = await sourceFor(r, kb);
    const body = z
      .object({
        revision: z.number().int().positive(),
        documentId: z.uuid(),
        pages: z
          .array(
            z.object({
              page: z.number().int().min(1).max(200),
              extraction: extractedPage,
            }),
          )
          .min(1)
          .max(200),
      })
      .strict()
      .parse(r.body);
    if (new Set(body.pages.map((p) => p.page)).size !== body.pages.length)
      throw new HttpError(400, "Choose each page only once");
    const pages = body.pages.map((p) => {
      try {
        return { ...p, extraction: validateExtraction(p.extraction) };
      } catch {
        throw new HttpError(
          400,
          "Invalid extraction: check text, table cells and header rows",
        );
      }
    });
    const prefix = `${kb.organization_id}/${kb.workspace_id}/${kb.id}/${source.id}/`;
    const result = await sql.begin(async (tx) => {
      // Match publication/archive lock order: knowledge base, then source.
      const [activeBase] =
        await tx`SELECT id FROM knowledge_bases WHERE id=${kb.id} AND archived_at IS NULL FOR SHARE`;
      if (!activeBase)
        throw new HttpError(409, "Knowledge base changed or is archived");
      const [locked] =
        await tx`SELECT * FROM knowledge_sources WHERE id=${source.id} AND revision=${body.revision} AND status='ready' FOR UPDATE`;
      if (!locked)
        throw new HttpError(
          409,
          "Source changed or is processing. Reload extraction before saving.",
        );
      const [document] =
        await tx`SELECT metadata FROM knowledge_documents WHERE id=${body.documentId} AND source_id=${source.id} AND revision=${body.revision} AND workspace_id=${kb.workspace_id} AND organization_id=${kb.organization_id}`;
      if (!document?.metadata.parsedArtifactKey)
        throw new HttpError(
          409,
          "Reingest this source once to prepare editable extraction; cached extraction is reused.",
        );
      const artifact = await readParsedArtifact(
        document.metadata.parsedArtifactKey,
        prefix,
        AbortSignal.timeout(30000),
      );
      const reports = artifact.document.metadata.aiExtraction as
        | {
            modelId: string;
            pages: ({
              page: number;
              imageKey?: string;
              mimeType?: string;
              corrected?: boolean;
            } & z.infer<typeof extractedPage>)[];
          }
        | undefined;
      if (!reports?.pages?.length)
        throw new HttpError(
          400,
          "This document has no AI-extracted pages to correct",
        );
      for (const changed of pages) {
        const report = reports.pages.find((p) => p.page === changed.page);
        if (!report)
          throw new HttpError(400, "Page is not part of this extraction");
        const index = artifact.document.sections.findIndex(
          (s) => s.page === changed.page,
        );
        const sections = artifact.document.sections.filter(
          (s) => s.page !== changed.page,
        );
        sections.splice(
          index < 0 ? sections.length : index,
          0,
          ...extractionSections(changed.extraction, changed.page),
        );
        artifact.document.sections = sections;
        Object.assign(report, changed.extraction, { corrected: true });
      }
      const editId = randomUUID();
      artifact.document.metadata.humanCorrection = {
        id: editId,
        revision: body.revision + 1,
      };
      const artifactKey = await saveParsedArtifact(
        prefix,
        artifact.inputHash,
        artifact.document,
      );
      const override = { artifactKey, inputHash: artifact.inputHash, editId };
      await tx`INSERT INTO knowledge_extraction_edits(id,source_id,knowledge_base_id,workspace_id,organization_id,source_revision,artifact_key,input_hash,created_by) VALUES (${editId},${source.id},${kb.id},${kb.workspace_id},${kb.organization_id},${body.revision + 1},${artifactKey},${artifact.inputHash},${u.id})`;
      const [saved] =
        await tx`UPDATE knowledge_sources SET revision=revision+1,status='queued',error_code=NULL,metadata=metadata || ${tx.json({ extractionOverride: override })}::jsonb,updated_at=now() WHERE id=${source.id} RETURNING revision`;
      await tx`INSERT INTO knowledge_jobs(id,source_id,knowledge_base_id,workspace_id,organization_id,source_revision,payload,status) VALUES (${randomUUID()},${source.id},${kb.id},${kb.workspace_id},${kb.organization_id},${saved!.revision},${tx.json({ objectKey: source.object_key, filename: source.filename })},'queued')`;
      await audit(
        tx,
        r,
        u.id,
        "knowledge.extraction_corrected",
        source.id,
        kb.organization_id,
        kb.workspace_id,
      );
      return { status: "queued", revision: saved!.revision, editId };
    });
    return reply.code(202).send(result);
  });
  app.delete(path + "/corrections", async (r, reply) => {
    const { u, kb } = await own(r, "knowledge:manage"),
      source = await sourceFor(r, kb);
    const { revision } = z
      .object({ revision: z.number().int().positive() })
      .strict()
      .parse(r.body);
    const saved = await sql.begin(async (tx) => {
      const [activeBase] =
        await tx`SELECT id FROM knowledge_bases WHERE id=${kb.id} AND archived_at IS NULL FOR SHARE`;
      if (!activeBase)
        throw new HttpError(409, "Knowledge base changed or is archived");
      const [changed] =
        await tx`UPDATE knowledge_sources s SET revision=s.revision+1,status='queued',error_code=NULL,metadata=s.metadata-'extractionOverride',updated_at=now() FROM knowledge_bases k WHERE s.id=${source.id} AND s.revision=${revision} AND s.status='ready' AND k.id=s.knowledge_base_id AND k.archived_at IS NULL RETURNING s.revision`;
      if (!changed)
        throw new HttpError(
          409,
          "Source changed or is processing; reload before resetting",
        );
      await tx`INSERT INTO knowledge_jobs(id,source_id,knowledge_base_id,workspace_id,organization_id,source_revision,payload,status) VALUES (${randomUUID()},${source.id},${kb.id},${kb.workspace_id},${kb.organization_id},${changed.revision},${tx.json({ objectKey: source.object_key, filename: source.filename })},'queued')`;
      await audit(
        tx,
        r,
        u.id,
        "knowledge.extraction_reset",
        source.id,
        kb.organization_id,
        kb.workspace_id,
      );
      return { status: "queued", revision: changed.revision };
    });
    return reply.code(202).send(saved);
  });
  app.get(path + "/edits", async (r) => {
    const { kb } = await own(r),
      source = await sourceFor(r, kb);
    return sql`SELECT e.id,e.source_revision,e.created_at,u.name AS reviewer FROM knowledge_extraction_edits e LEFT JOIN users u ON u.id=e.created_by WHERE e.source_id=${source.id} AND e.workspace_id=${kb.workspace_id} AND e.organization_id=${kb.organization_id} ORDER BY e.source_revision DESC LIMIT 50`;
  });
}
