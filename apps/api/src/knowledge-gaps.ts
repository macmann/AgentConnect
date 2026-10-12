import {
  addCorrectionRegression,
  prepareCorrectionRegression,
  type CorrectionDraft,
} from "./knowledge-regressions.js";
import {
  defaultEmbeddingFactory,
  embeddingConnection,
} from "./knowledge-core.js";
import { semanticClusters } from "./semantic-gaps.js";
import { validateVectors } from "@agentconnect/provider-sdk/embeddings";
import type { EmbeddingFactory } from "@agentconnect/provider-sdk/embeddings";
import type { FastifyInstance } from "fastify";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { actor, workspaceAccess, id, params, audit } from "./app.js";
import { sql } from "./db.js";
import { HttpError } from "./http-error.js";
import { dateRange } from "./customer-reports.js";
import { addSource } from "./knowledge.js";
import type { KnowledgeBase } from "./knowledge-core.js";
export async function registerKnowledgeGaps(
  app: FastifyInstance,
  factory: EmbeddingFactory = defaultEmbeddingFactory,
) {
  app.get("/workspaces/:workspaceId/operations/knowledge-gaps", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "conversation:review",
      ),
      { from, to } = dateRange(r.query);
    const rows =
      await sql`SELECT ar.id AS run_id,ar.conversation_id,ar.answer_kind,ar.error_code,EXISTS(SELECT 1 FROM answer_issues ai JOIN messages am ON am.id=ai.message_id WHERE am.run_id=ar.id) AS answer_reported,q.content AS question,cr.id AS review_id,cr.rating,cr.corrected_response,cr.label,ar.started_at,cf.rating AS customer_rating,cf.resolved AS customer_resolved,EXISTS(SELECT 1 FROM support_cases sc WHERE sc.conversation_id=ar.conversation_id) AS handed_off FROM agent_runs ar JOIN LATERAL(SELECT content FROM messages WHERE run_id=ar.id AND role='user' ORDER BY created_at,id LIMIT 1) q ON true LEFT JOIN LATERAL(SELECT cr.* FROM conversation_reviews cr JOIN messages m ON m.id=cr.message_id WHERE m.run_id=ar.id ORDER BY cr.created_at DESC,cr.id DESC LIMIT 1) cr ON true LEFT JOIN customer_feedback cf ON cf.conversation_id=ar.conversation_id WHERE ar.workspace_id=${w.id} AND ar.organization_id=${w.organization_id} AND ar.started_at>=${from} AND ar.started_at<${to} AND (ar.answer_kind='no_answer' OR ar.error_code IN ('NO_RELEVANT_SOURCES','CITATION_REQUIRED','INVALID_CITATION','GROUNDED_RESPONSE_INVALID') OR cr.rating='dislike' OR cf.rating<=2 OR cf.resolved=false OR EXISTS(SELECT 1 FROM answer_issues ai JOIN messages am ON am.id=ai.message_id WHERE am.run_id=ar.id)) ORDER BY ar.started_at DESC,ar.id DESC LIMIT 1001`;
    const assignments =
      await sql`SELECT run_id,group_key,method FROM knowledge_gap_assignments WHERE workspace_id=${w.id} AND organization_id=${w.organization_id}`;
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
      const normalized = row.question
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
      const key =
        assignments.find((a) => a.run_id === row.run_id)?.group_key ??
        normalized;
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
        row.customer_rating <= 2 && row.customer_rating !== null
          ? "Customer dissatisfaction"
          : row.customer_resolved === false
            ? "Customer marked unresolved"
            : row.answer_reported
              ? "Customer reported this answer"
              : row.rating === "dislike"
                ? "Poor operator review"
                : (row.error_code ?? "No approved answer");
      if (!group.reasons.includes(reason)) group.reasons.push(reason);
      if (group.examples.length < 1000) group.examples.push(row);
      groups.set(key, group);
    }
    const drafts =
      await sql`SELECT i.*,kb.name AS knowledge_name,release.published_at,EXISTS(SELECT 1 FROM knowledge_release_chunks rc WHERE rc.release_id=kb.published_release_id AND rc.source_id=i.source_id) AS active_in_current_release FROM knowledge_improvements i JOIN knowledge_bases kb ON kb.id=i.knowledge_base_id LEFT JOIN LATERAL(SELECT min(kr.published_at) AS published_at FROM knowledge_releases kr WHERE kr.knowledge_base_id=i.knowledge_base_id AND kr.published_at IS NOT NULL AND EXISTS(SELECT 1 FROM knowledge_release_chunks rc WHERE rc.release_id=kr.id AND rc.source_id=i.source_id)) release ON true WHERE i.workspace_id=${w.id} AND i.organization_id=${w.organization_id} ORDER BY i.created_at DESC LIMIT 100`;
    return {
      range: { from, to },
      groups: [...groups.values()]
        .map((g) => ({
          ...g,
          priority:
            g.count +
            2 *
              g.examples.filter(
                (e) =>
                  (e.customer_rating !== null && e.customer_rating <= 2) ||
                  e.customer_resolved === false,
              ).length +
            g.examples.filter((e) => e.handed_off).length,
          correctedDrafts: drafts
            .filter((d) => g.examples.some((e) => e.review_id === d.review_id))
            .map((d) => ({
              id: d.id,
              status: d.status,
              created_at: d.created_at,
              published_at: d.published_at,
              active_in_current_release: d.active_in_current_release,
              before: g.examples.filter(
                (e) =>
                  d.published_at &&
                  new Date(e.started_at).getTime() <
                    new Date(d.published_at).getTime(),
              ).length,
              after: g.examples.filter(
                (e) =>
                  d.published_at &&
                  new Date(e.started_at).getTime() >=
                    new Date(d.published_at).getTime(),
              ).length,
            })),
          trend: {
            recent: g.examples.filter(
              (e) =>
                Date.parse(e.started_at) >=
                (Date.parse(from) + Date.parse(to)) / 2,
            ).length,
            earlier: g.examples.filter(
              (e) =>
                Date.parse(e.started_at) <
                (Date.parse(from) + Date.parse(to)) / 2,
            ).length,
          },
        }))
        .sort((a, b) => b.priority - a.priority),
      drafts,
      truncated: rows.length > 1000,
      method:
        "Embedding similarity where clustered, exact normalized questions otherwise. Reviewer assignments take precedence. Priority combines frequency, customer dissatisfaction and handoff. Trend compares equal halves of the selected period; corrections do not prove causation.",
    };
  });
  app.post(
    "/workspaces/:workspaceId/operations/knowledge-gaps/cluster",
    { config: { rateLimit: { max: 2, timeWindow: "1 minute" } } },
    async (r) => {
      const u = await actor(r),
        w = await workspaceAccess(
          u.id,
          id(params(r).workspaceId),
          "conversation:review",
        );
      const d = z
        .strictObject({
          modelId: z.uuid(),
          threshold: z.number().min(0.7).max(0.99).default(0.85),
          from: z.iso.datetime(),
          to: z.iso.datetime(),
        })
        .parse(r.body);
      const range = dateRange({ from: d.from, to: d.to });
      const rows =
        await sql`SELECT ar.id,q.content AS question FROM agent_runs ar JOIN LATERAL(SELECT content FROM messages WHERE run_id=ar.id AND role='user' ORDER BY created_at,id LIMIT 1) q ON true LEFT JOIN customer_feedback cf ON cf.conversation_id=ar.conversation_id WHERE ar.workspace_id=${w.id} AND ar.organization_id=${w.organization_id} AND ar.started_at>=${range.from} AND ar.started_at<${range.to} AND (ar.answer_kind='no_answer' OR ar.error_code IN ('NO_RELEVANT_SOURCES','CITATION_REQUIRED','INVALID_CITATION','GROUNDED_RESPONSE_INVALID') OR cf.rating<=2 OR cf.resolved=false OR EXISTS(SELECT 1 FROM conversation_reviews cr JOIN messages m ON m.id=cr.message_id WHERE m.run_id=ar.id AND cr.rating='dislike') OR EXISTS(SELECT 1 FROM answer_issues ai JOIN messages am ON am.id=ai.message_id WHERE am.run_id=ar.id)) ORDER BY ar.started_at DESC,ar.id DESC LIMIT 301`;
      const items = rows.slice(0, 300),
        conn = await embeddingConnection(d.modelId, w.id, w.organization_id),
        provider = factory(conn),
        vectors: number[][] = [],
        signal = AbortSignal.timeout(60000);
      for (let i = 0; i < items.length; i += 32) {
        const texts = items
            .slice(i, i + 32)
            .map((row) => row.question.slice(0, 2000)),
          batch = await provider.embed(texts, signal, "document");
        validateVectors(batch, texts.length, conn.dimensions);
        vectors.push(...batch);
      }
      const groups = semanticClusters(vectors, d.threshold);
      await sql.begin(async (tx) => {
        for (const group of groups) {
          const key =
            "semantic:" +
            createHash("sha256")
              .update(
                items[group[0]!]!.question.normalize("NFKC")
                  .trim()
                  .toLowerCase(),
              )
              .digest("hex");
          for (const index of group)
            await tx`INSERT INTO knowledge_gap_assignments(run_id,workspace_id,organization_id,group_key,updated_by,method) VALUES(${items[index]!.id},${w.id},${w.organization_id},${key},${u.id},'embedding') ON CONFLICT(run_id) DO UPDATE SET group_key=EXCLUDED.group_key,updated_by=EXCLUDED.updated_by,method='embedding',updated_at=now() WHERE knowledge_gap_assignments.method<>'reviewer'`;
        }
      });
      return {
        grouped: items.length,
        clusters: groups.length,
        truncated: rows.length > 300,
      };
    },
  );
  app.post(
    "/workspaces/:workspaceId/operations/knowledge-gaps/assign",
    async (r) => {
      const u = await actor(r),
        w = await workspaceAccess(
          u.id,
          id(params(r).workspaceId),
          "conversation:review",
        );
      const d = z
        .strictObject({
          runIds: z.array(z.uuid()).min(1).max(1000),
          targetRunId: z.uuid().nullable(),
          targetRunIds: z.array(z.uuid()).max(1000).default([]),
        })
        .parse(r.body);
      const result = await sql.begin(async (tx) => {
        const rows =
          await tx`SELECT id FROM agent_runs WHERE id=ANY(${[...d.runIds, ...d.targetRunIds, ...(d.targetRunId ? [d.targetRunId] : [])]}::uuid[]) AND workspace_id=${w.id} AND organization_id=${w.organization_id}`;
        if (
          rows.length !==
          new Set([
            ...d.runIds,
            ...d.targetRunIds,
            ...(d.targetRunId ? [d.targetRunId] : []),
          ]).size
        )
          throw new HttpError(404, "Question unavailable");
        const [target] = d.targetRunId
          ? await tx`SELECT group_key FROM knowledge_gap_assignments WHERE run_id=${d.targetRunId}`
          : [];
        const key = target?.group_key ?? "reviewed:" + randomUUID();
        const ids = [
          ...new Set([
            ...d.runIds,
            ...d.targetRunIds,
            ...(d.targetRunId ? [d.targetRunId] : []),
          ]),
        ];
        for (const runId of ids)
          await tx`INSERT INTO knowledge_gap_assignments(run_id,workspace_id,organization_id,group_key,updated_by) VALUES(${runId},${w.id},${w.organization_id},${key},${u.id}) ON CONFLICT(run_id) DO UPDATE SET group_key=EXCLUDED.group_key,updated_by=EXCLUDED.updated_by,method='reviewer',updated_at=now()`;
        return { key };
      });
      return result;
    },
  );
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
        if (draft.answer_issue_id && data.action !== "reject") {
          const [current] =
            await tx`SELECT status,review_id FROM answer_issues WHERE id=${draft.answer_issue_id}`;
          if (
            !current ||
            current.review_id !== draft.review_id ||
            current.status !== "fix_ready"
          )
            throw new HttpError(
              409,
              "The customer report changed. Review its latest details before approving or ingesting this correction.",
            );
        }
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
          if (data.action === "reject" && draft.answer_issue_id)
            await tx`UPDATE answer_issues SET status='reviewing',revision=revision+1,updated_at=clock_timestamp() WHERE id=${draft.answer_issue_id} AND review_id=${draft.review_id} AND status='fix_ready'`;
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
          await prepareCorrectionRegression(tx, draft as CorrectionDraft);
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
          await addCorrectionRegression(
            tx,
            draft as {
              id: string;
              knowledge_base_id: string;
              workspace_id: string;
              organization_id: string;
              question: string;
              answer: string;
            },
            source.id,
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
