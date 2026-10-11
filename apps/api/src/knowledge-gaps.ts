import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { actor, workspaceAccess, id, params, audit } from "./app.js";
import { sql } from "./db.js";
import { HttpError } from "./http-error.js";
import { dateRange } from "./customer-reports.js";
import { addSource } from "./knowledge.js";
import type { KnowledgeBase } from "./knowledge-core.js";
export async function registerKnowledgeGaps(app: FastifyInstance) {
  app.get("/workspaces/:workspaceId/operations/knowledge-gaps", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "conversation:review",
      ),
      { from, to } = dateRange(r.query);
    const rows =
      await sql`SELECT ar.id AS run_id,ar.conversation_id,ar.answer_kind,ar.error_code,q.content AS question,cr.id AS review_id,cr.rating,cr.corrected_response,cr.label,ar.started_at FROM agent_runs ar JOIN LATERAL(SELECT content FROM messages WHERE run_id=ar.id AND role='user' ORDER BY created_at,id LIMIT 1) q ON true LEFT JOIN LATERAL(SELECT cr.* FROM conversation_reviews cr JOIN messages m ON m.id=cr.message_id WHERE m.run_id=ar.id ORDER BY cr.created_at DESC,cr.id DESC LIMIT 1) cr ON true WHERE ar.workspace_id=${w.id} AND ar.organization_id=${w.organization_id} AND ar.started_at>=${from} AND ar.started_at<${to} AND (ar.answer_kind='no_answer' OR ar.error_code IN ('NO_RELEVANT_SOURCES','CITATION_REQUIRED','INVALID_CITATION','GROUNDED_RESPONSE_INVALID') OR cr.rating='dislike') ORDER BY ar.started_at DESC,ar.id DESC LIMIT 1001`;
    const groups = new Map<
      string,
      {
        key: string;
        question: string;
        count: number;
        reasons: string[];
        suggestion: string;
        examples: (typeof rows)[number][];
      }
    >();
    for (const row of rows.slice(0, 1000)) {
      const key = row.question
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
      const group: {
        key: string;
        question: string;
        count: number;
        reasons: string[];
        suggestion: string;
        examples: (typeof rows)[number][];
      } = groups.get(key) ?? {
        key,
        question: row.question,
        count: 0,
        reasons: [],
        suggestion: `Review the approved procedure or FAQ for: ${row.question.slice(0, 160)}`,
        examples: [],
      };
      group.count++;
      const reason =
        row.rating === "dislike"
          ? "Poor operator review"
          : (row.error_code ?? "No approved answer");
      if (!group.reasons.includes(reason)) group.reasons.push(reason);
      if (group.examples.length < 10) group.examples.push(row);
      groups.set(key, group);
    }
    const drafts =
      await sql`SELECT i.*,kb.name AS knowledge_name FROM knowledge_improvements i JOIN knowledge_bases kb ON kb.id=i.knowledge_base_id WHERE i.workspace_id=${w.id} AND i.organization_id=${w.organization_id} ORDER BY i.created_at DESC LIMIT 100`;
    return {
      range: { from, to },
      groups: [...groups.values()].sort((a, b) => b.count - a.count),
      drafts,
      truncated: rows.length > 1000,
      method:
        "Exact normalized question grouping; suggestions are review prompts, not generated factual corrections.",
    };
  });
  app.post(
    "/workspaces/:workspaceId/operations/knowledge-improvements",
    async (r, reply) => {
      const u = await actor(r),
        w = await workspaceAccess(
          u.id,
          id(params(r).workspaceId),
          "conversation:review",
        );
      await workspaceAccess(u.id, w.id, "knowledge:manage");
      const data = z
        .object({
          reviewId: z.uuid(),
          knowledgeBaseId: z.uuid(),
          question: z.string().trim().min(1).max(2000),
          answer: z.string().trim().min(1).max(12000),
        })
        .strict()
        .parse(r.body);
      const result = await sql.begin(async (tx) => {
        const [review] =
          await tx`SELECT id FROM conversation_reviews WHERE id=${data.reviewId} AND workspace_id=${w.id} AND organization_id=${w.organization_id} AND corrected_response IS NOT NULL`;
        const [kb] =
          await tx`SELECT id FROM knowledge_bases WHERE id=${data.knowledgeBaseId} AND workspace_id=${w.id} AND organization_id=${w.organization_id} AND approval_required AND archived_at IS NULL FOR SHARE`;
        if (!review || !kb)
          throw new HttpError(
            400,
            "Select a corrected review and an active approval-required knowledge base",
          );
        const [draft] =
          await tx`INSERT INTO knowledge_improvements(id,workspace_id,organization_id,review_id,knowledge_base_id,question,answer,author_id) VALUES(${randomUUID()},${w.id},${w.organization_id},${review.id},${kb.id},${data.question},${data.answer},${u.id}) ON CONFLICT(review_id,knowledge_base_id) DO NOTHING RETURNING *`;
        if (!draft)
          throw new HttpError(
            409,
            "This correction already has a knowledge draft",
          );
        await audit(
          tx,
          r,
          u.id,
          "knowledge.improvement_drafted",
          draft.id,
          w.organization_id,
          w.id,
        );
        return draft;
      });
      return reply.code(201).send(result);
    },
  );
  app.post(
    "/workspaces/:workspaceId/operations/knowledge-improvements/:improvementId",
    async (r) => {
      const u = await actor(r),
        w = await workspaceAccess(
          u.id,
          id(params(r).workspaceId),
          "knowledge:approve",
        );
      const data = z
        .object({
          action: z.enum(["approve", "reject", "materialize"]),
          note: z.string().trim().max(2000).default(""),
        })
        .strict()
        .parse(r.body);
      return sql.begin(async (tx) => {
        const [draft] =
          await tx`SELECT * FROM knowledge_improvements WHERE id=${id(params(r).improvementId)} AND workspace_id=${w.id} AND organization_id=${w.organization_id} FOR UPDATE`;
        if (!draft) throw new HttpError(404, "Knowledge draft not found");
        if (data.action !== "materialize") {
          if (draft.status !== "draft")
            throw new HttpError(409, "This correction was already reviewed");
          if (draft.author_id === u.id)
            throw new HttpError(
              409,
              "A different administrator must review this correction",
            );
          if (data.action === "reject" && !data.note)
            throw new HttpError(400, "Add a rejection note");
          await tx`UPDATE knowledge_improvements SET status=${data.action === "approve" ? "approved" : "rejected"},reviewer_id=${u.id},review_note=${data.note},updated_at=now() WHERE id=${draft.id}`;
        } else {
          if (draft.status !== "approved")
            throw new HttpError(
              409,
              "Approve this correction before adding it to knowledge",
            );
          const [kb] = await tx<
            KnowledgeBase[]
          >`SELECT * FROM knowledge_bases WHERE id=${draft.knowledge_base_id} AND workspace_id=${w.id} AND organization_id=${w.organization_id} AND approval_required AND archived_at IS NULL FOR SHARE`;
          if (!kb)
            throw new HttpError(
              409,
              "Knowledge base must remain active and require approved releases",
            );
          const source = await addSource(
            r,
            kb,
            u.id,
            "qa",
            draft.question,
            Buffer.from(
              "Question: " + draft.question + "\nAnswer: " + draft.answer,
            ),
            "qa.txt",
            {
              question: draft.question,
              answer: draft.answer,
              reviewId: draft.review_id,
            },
            null,
            tx,
          );
          await tx`UPDATE knowledge_improvements SET status='materialized',source_id=${source.id},updated_at=now() WHERE id=${draft.id}`;
        }
        await audit(
          tx,
          r,
          u.id,
          "knowledge.improvement_" + data.action,
          draft.id,
          w.organization_id,
          w.id,
        );
        return { ok: true };
      });
    },
  );
}
