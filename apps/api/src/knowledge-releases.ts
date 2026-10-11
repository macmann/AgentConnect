import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql } from "./db.js";
import { audit, workspaceAccess, params, id, HttpError } from "./app.js";
import type { KnowledgeBase } from "./knowledge-core.js";
type Owned = (
  r: FastifyRequest,
  cap?: "knowledge:read" | "knowledge:manage" | "knowledge:retrieve",
) => Promise<{ u: { id: string }; kb: KnowledgeBase }>;
export async function registerKnowledgeReleases(
  app: FastifyInstance,
  owned: Owned,
) {
  const base = "/knowledge-bases/:knowledgeBaseId/releases";
  app.get(base, async (r) => {
    const { kb } = await owned(r);
    return sql`SELECT r.*,count(c.id)::int AS chunk_count,count(DISTINCT c.source_id)::int AS source_count FROM knowledge_releases r LEFT JOIN knowledge_release_chunks c ON c.release_id=r.id WHERE r.knowledge_base_id=${kb.id} AND r.workspace_id=${kb.workspace_id} GROUP BY r.id ORDER BY r.version DESC LIMIT 100`;
  });
  app.get(base + "/:releaseId/chunks", async (r) => {
    const { kb } = await owned(r);
    const rows =
      await sql`SELECT c.id,c.source_id,c.source_revision,c.title,c.content,c.page FROM knowledge_release_chunks c JOIN knowledge_releases r ON r.id=c.release_id WHERE r.id=${id(params(r).releaseId)} AND r.knowledge_base_id=${kb.id} AND r.workspace_id=${kb.workspace_id} ORDER BY c.title,c.page,c.id LIMIT 100`;
    return rows;
  });
  app.post(base, async (r, reply) => {
    const { u, kb } = await owned(r, "knowledge:manage");
    const data = z
      .object({
        name: z.string().trim().min(1).max(100),
        notes: z.string().max(2000).default(""),
        sourceIds: z.array(z.uuid()).min(1).max(100),
      })
      .parse(r.body);
    if (new Set(data.sourceIds).size !== data.sourceIds.length)
      throw new HttpError(400, "Choose distinct sources");
    const release = await sql.begin(async (tx) => {
      await tx`SELECT id FROM knowledge_bases WHERE id=${kb.id} FOR UPDATE`;
      const sources =
        await tx`SELECT id FROM knowledge_sources WHERE id=ANY(${data.sourceIds}::uuid[]) AND knowledge_base_id=${kb.id} AND workspace_id=${kb.workspace_id} AND status='ready' FOR SHARE`;
      if (sources.length !== data.sourceIds.length)
        throw new HttpError(
          409,
          "All selected sources must be ready in this knowledge base",
        );
      const [v] =
        await tx`SELECT COALESCE(max(version),0)+1 AS next FROM knowledge_releases WHERE knowledge_base_id=${kb.id}`;
      const rid = randomUUID();
      const [row] =
        await tx`INSERT INTO knowledge_releases(id,knowledge_base_id,workspace_id,organization_id,version,name,notes,author_id) VALUES (${rid},${kb.id},${kb.workspace_id},${kb.organization_id},${v!.next},${data.name},${data.notes},${u.id}) RETURNING *`;
      await tx`INSERT INTO knowledge_release_chunks(release_id,id,document_id,source_id,knowledge_base_id,workspace_id,organization_id,source_revision,content,page,heading,title,source_url,kind,dimensions,embedding) SELECT ${rid},c.id,c.document_id,c.source_id,c.knowledge_base_id,c.workspace_id,c.organization_id,s.revision,c.content,c.page,c.heading,d.title,d.source_url,s.kind,c.dimensions,c.embedding FROM knowledge_chunks c JOIN knowledge_sources s ON s.id=c.source_id JOIN knowledge_documents d ON d.id=c.document_id WHERE c.knowledge_base_id=${kb.id} AND c.source_id=ANY(${data.sourceIds}::uuid[])`;
      const [counts] =
        await tx`SELECT count(*)::int AS chunks,count(DISTINCT source_id)::int AS sources FROM knowledge_release_chunks WHERE release_id=${rid}`;
      if (
        !counts?.chunks ||
        counts.sources !== data.sourceIds.length ||
        counts.chunks > 5000
      )
        throw new HttpError(
          400,
          "Every selected source must have indexed passages; releases support up to 5,000 passages",
        );
      await audit(
        tx,
        r,
        u.id,
        "knowledge.release_created",
        rid,
        kb.organization_id,
        kb.workspace_id,
      );
      return row;
    });
    return reply.code(201).send(release);
  });
  app.post(base + "/:releaseId/transition", async (r) => {
    const { u, kb } = await owned(r, "knowledge:manage");
    const data = z
      .object({
        action: z.enum(["submit", "approve", "reject", "publish"]),
        note: z.string().max(2000).default(""),
      })
      .parse(r.body);
    if (data.action !== "submit")
      await workspaceAccess(u.id, kb.workspace_id, "knowledge:approve");
    return sql.begin(async (tx) => {
      await tx`SELECT id FROM knowledge_bases WHERE id=${kb.id} FOR UPDATE`;
      const [release] =
        await tx`SELECT * FROM knowledge_releases WHERE id=${id(params(r).releaseId)} AND knowledge_base_id=${kb.id} AND workspace_id=${kb.workspace_id} FOR UPDATE`;
      if (!release) throw new HttpError(404, "Knowledge release not found");
      const valid =
        data.action === "submit"
          ? release.status === "draft"
          : data.action === "publish"
            ? ["approved", "published"].includes(release.status)
            : release.status === "review";
      if (!valid)
        throw new HttpError(
          409,
          "Release state changed; reload before continuing",
        );
      if (
        ["approve", "reject"].includes(data.action) &&
        release.author_id === u.id
      )
        throw new HttpError(
          403,
          "A different administrator must review this release",
        );
      if (data.action === "reject" && !data.note.trim())
        throw new HttpError(400, "Provide a reason for rejection");
      if (data.action === "publish") {
        const [missing] =
          await tx`SELECT 1 FROM knowledge_release_chunks c JOIN knowledge_sources s ON s.id=c.source_id WHERE c.release_id=${release.id} AND s.status='deleted' LIMIT 1`;
        if (missing)
          throw new HttpError(
            409,
            "A snapshotted source was removed; create a new release",
          );
        await tx`UPDATE knowledge_bases SET published_release_id=${release.id},revision=revision+1 WHERE id=${kb.id}`;
      }
      const state = {
        submit: "review",
        approve: "approved",
        reject: "rejected",
        publish: "published",
      }[data.action];
      const [updated] =
        await tx`UPDATE knowledge_releases SET status=${state},reviewer_id=${["approve", "reject"].includes(data.action) ? u.id : release.reviewer_id},review_note=${["approve", "reject"].includes(data.action) ? data.note : release.review_note},reviewed_at=${["approve", "reject"].includes(data.action) ? new Date() : release.reviewed_at},published_at=${data.action === "publish" ? new Date() : release.published_at} WHERE id=${release.id} RETURNING *`;
      await audit(
        tx,
        r,
        u.id,
        "knowledge.release_" + data.action,
        release.id,
        kb.organization_id,
        kb.workspace_id,
      );
      return updated;
    });
  });
}
