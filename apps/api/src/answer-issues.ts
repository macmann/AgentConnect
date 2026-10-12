import { agentConfig } from "@agentconnect/schemas/agents";
import { requestReportedAnswerHandoff } from "./support/policy.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { TransactionSql } from "postgres";
import { z } from "zod";
import { actor, workspaceAccess, params, id, audit } from "./app.js";
import { sql } from "./db.js";
import { HttpError } from "./http-error.js";
import { conversationAccess } from "./channels.js";

const reportInput = z.strictObject({
  reason: z.enum(["incorrect", "not_helpful", "unresolved"]),
  comment: z.string().trim().max(2000).default(""),
  requestSupport: z.boolean().default(false),
});
export async function recordAnswerIssue(
  tx: TransactionSql,
  messageId: string,
  scope: { workspace_id: string; organization_id: string },
  data: Pick<z.infer<typeof reportInput>, "reason" | "comment">,
) {
  const [issue] =
    await tx`INSERT INTO answer_issues(id,message_id,workspace_id,organization_id,reason,comment) VALUES(${randomUUID()},${messageId},${scope.workspace_id},${scope.organization_id},${data.reason},${data.comment}) ON CONFLICT(message_id) DO NOTHING RETURNING id,status`;
  if (issue)
    await tx`INSERT INTO answer_issue_events(id,issue_id,workspace_id,organization_id,kind) VALUES(${randomUUID()},${issue.id},${scope.workspace_id},${scope.organization_id},'reported')`;
  if (!issue) {
    const [reopened] =
      await tx`UPDATE answer_issues SET status='reported',reason=${data.reason},comment=${data.comment},assigned_to=NULL,verification_release_id=NULL,resolution=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE message_id=${messageId} AND status='closed' RETURNING id,status`;
    if (reopened) {
      await tx`INSERT INTO answer_issue_events(id,issue_id,workspace_id,organization_id,kind) VALUES(${randomUUID()},${reopened.id},${scope.workspace_id},${scope.organization_id},'customer_reopened')`;
      return reopened;
    }
  }
  if (issue) return issue;
  const [existing] =
    await tx`SELECT id,status,reason,comment,assigned_to FROM answer_issues WHERE message_id=${messageId} FOR UPDATE`;
  if (
    existing &&
    (existing.reason !== data.reason ||
      (data.comment && existing.comment !== data.comment))
  ) {
    const status = ["verified", "fix_ready"].includes(existing.status)
      ? existing.assigned_to
        ? "reviewing"
        : "reported"
      : existing.status;
    const [updated] =
      await tx`UPDATE answer_issues SET reason=${data.reason},comment=${data.comment || existing.comment},status=${status},verification_release_id=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE id=${existing.id} RETURNING id,status`;
    await tx`INSERT INTO answer_issue_events(id,issue_id,workspace_id,organization_id,kind,note) VALUES(${randomUUID()},${existing.id},${scope.workspace_id},${scope.organization_id},'customer_updated',${data.comment})`;
    return updated!;
  }
  return { id: existing!.id, status: existing!.status };
}
export async function registerAnswerIssues(app: FastifyInstance) {
  for (const channel of ["deployments", "widgets"]) {
    const path = `/public/${channel}/:deploymentId/conversations/:conversationId/answer-reports/:messageId`;
    app.get(path, async (r) => {
      const { c } = await conversationAccess(r, true);
      const [issue] =
        await sql`SELECT i.id,i.status,i.reason FROM answer_issues i JOIN messages m ON m.id=i.message_id WHERE m.id=${id(params(r).messageId)} AND m.conversation_id=${c.id} AND m.role='assistant'`;
      return issue ?? null;
    });
    app.post(
      path,
      { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (r) => {
        const { c } = await conversationAccess(r, true);
        const data = reportInput.parse(r.body);
        const report = await sql.begin(async (tx) => {
          const [m] =
            await tx`SELECT id FROM messages WHERE id=${id(params(r).messageId)} AND conversation_id=${c.id} AND workspace_id=${c.workspace_id} AND organization_id=${c.organization_id} AND role='assistant' FOR SHARE`;
          if (!m)
            throw new HttpError(404, "Answer not found in this conversation");
          return recordAnswerIssue(
            tx,
            m.id,
            {
              workspace_id: c.workspace_id,
              organization_id: c.organization_id,
            },
            data,
          );
        });
        if (data.requestSupport) {
          try {
            await requestReportedAnswerHandoff(c.id);
            return { ...report, supportRequested: true };
          } catch (e) {
            return {
              ...report,
              supportRequested: false,
              supportError:
                e instanceof HttpError
                  ? e.message
                  : "Human support could not be requested. Your report remains saved.",
            };
          }
        }
        return report;
      },
    );
  }
  const base = "/workspaces/:workspaceId/operations/answer-issues";
  app.get(base, async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "conversation:review",
      );
    const q = z
      .object({
        status: z
          .enum([
            "all",
            "reported",
            "reviewing",
            "fix_ready",
            "verified",
            "closed",
          ])
          .default("reported"),
        before: z.iso.datetime().optional(),
        beforeId: z.uuid().optional(),
      })
      .parse(r.query);
    const rows =
      await sql`SELECT i.*,a.name AS agent_name,c.agent_id,c.id AS conversation_id,m.content AS answer,q.content AS question,u.name AS assignee_name,k.id AS improvement_id,k.status AS improvement_status,k.knowledge_base_id,k.source_id FROM answer_issues i JOIN messages m ON m.id=i.message_id JOIN conversations c ON c.id=m.conversation_id JOIN agents a ON a.id=c.agent_id LEFT JOIN users u ON u.id=i.assigned_to LEFT JOIN LATERAL(SELECT content FROM messages WHERE run_id=m.run_id AND role='user' ORDER BY created_at,id LIMIT 1) q ON true LEFT JOIN LATERAL(SELECT * FROM knowledge_improvements WHERE answer_issue_id=i.id ORDER BY created_at DESC LIMIT 1) k ON true WHERE i.workspace_id=${w.id} AND i.organization_id=${w.organization_id} AND (${q.status}='all' OR i.status=${q.status}) AND (i.updated_at,i.id)<(${q.before ?? new Date().toISOString()},${q.beforeId ?? "ffffffff-ffff-ffff-ffff-ffffffffffff"}) ORDER BY i.updated_at DESC,i.id DESC LIMIT 51`;
    return { issues: rows.slice(0, 50), hasMore: rows.length > 50 };
  });
  app.get(base + "/:issueId", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "conversation:review",
      );
    const [issue] =
      await sql`SELECT i.*,m.content AS answer,m.citations FROM answer_issues i JOIN messages m ON m.id=i.message_id WHERE i.id=${id(params(r).issueId)} AND i.workspace_id=${w.id} AND i.organization_id=${w.organization_id}`;
    if (!issue) throw new HttpError(404, "Report not found");
    return {
      ...issue,
      events:
        await sql`SELECT e.kind,e.note,e.created_at,u.name AS actor FROM answer_issue_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.issue_id=${issue.id} ORDER BY e.created_at,e.id LIMIT 100`,
    };
  });
  app.post(base + "/:issueId", async (r) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "conversation:review",
      );
    const d = z
      .strictObject({
        revision: z.number().int().positive(),
        action: z.enum(["claim", "release", "close", "dismiss", "reopen"]),
        note: z.string().trim().max(2000).default(""),
      })
      .parse(r.body);
    return sql.begin(async (tx) => {
      const [i] =
        await tx`SELECT * FROM answer_issues WHERE id=${id(params(r).issueId)} AND workspace_id=${w.id} AND organization_id=${w.organization_id} FOR UPDATE`;
      if (!i) throw new HttpError(404, "Report not found");
      if (i.revision !== d.revision)
        throw new HttpError(409, "Report changed; reload before continuing");
      if (
        d.action === "claim" &&
        ((i.assigned_to && i.assigned_to !== u.id) || i.status === "closed")
      )
        throw new HttpError(409, "This report is already assigned or closed");
      if (!["claim", "reopen"].includes(d.action) && i.assigned_to !== u.id)
        throw new HttpError(409, "Claim the report before changing it");
      if (
        d.action === "close" &&
        (i.status !== "verified" || !i.verification_release_id)
      )
        throw new HttpError(
          409,
          "Publish a regression-verified correction before closing this report",
        );
      if (d.action === "close") {
        const [live] =
          await tx`SELECT k.id AS kb_id,k.published_release_id,a.draft_config,v.config AS live_config,d.enabled AS deployment_enabled,c.deployment_id FROM knowledge_improvements correction JOIN knowledge_bases k ON k.id=correction.knowledge_base_id JOIN messages m ON m.id=${i.message_id} JOIN conversations c ON c.id=m.conversation_id JOIN agents a ON a.id=c.agent_id LEFT JOIN deployments d ON d.id=c.deployment_id LEFT JOIN agent_versions v ON v.id=d.version_id WHERE correction.answer_issue_id=${i.id} AND correction.review_id=${i.review_id} AND correction.status='materialized' AND k.published_release_id=${i.verification_release_id} AND a.archived_at IS NULL AND EXISTS(SELECT 1 FROM knowledge_release_chunks rc JOIN knowledge_sources s ON s.id=rc.source_id WHERE rc.release_id=k.published_release_id AND rc.source_id=correction.source_id AND s.status<>'deleted')`;
        if (!live || (live.deployment_id && !live.deployment_enabled))
          throw new HttpError(
            409,
            "The verified correction is no longer live for this customer",
          );
        const c = agentConfig.parse(live.live_config ?? live.draft_config);
        if (
          !c.rag.knowledgeBaseIds.includes(live.kb_id) ||
          c.rag.usageMode === "disabled" ||
          (c.rag.releasePins[live.kb_id] ?? live.published_release_id) !==
            i.verification_release_id
        )
          throw new HttpError(
            409,
            "Update the customer's agent deployment to use the verified knowledge release before closing",
          );
      }
      if (["close", "dismiss", "reopen"].includes(d.action) && !d.note)
        throw new HttpError(400, "Add a review note");
      if (d.action === "reopen" && i.status !== "closed")
        throw new HttpError(409, "Only closed reports can be reopened");
      if (d.action === "release" && i.status === "closed")
        throw new HttpError(
          409,
          "Reopen the closed report before releasing assignment",
        );
      const status =
        d.action === "claim"
          ? i.status === "reported"
            ? "reviewing"
            : i.status
          : d.action === "reopen"
            ? "reviewing"
            : ["close", "dismiss"].includes(d.action)
              ? "closed"
              : i.status;
      const [updated] =
        await tx`UPDATE answer_issues SET status=${status},assigned_to=${d.action === "release" ? null : u.id},resolution=${d.action === "dismiss" ? "dismissed" : d.action === "close" ? "corrected" : null},revision=revision+1,updated_at=clock_timestamp() WHERE id=${i.id} RETURNING *`;
      await tx`INSERT INTO answer_issue_events(id,issue_id,workspace_id,organization_id,actor_id,kind,note) VALUES(${randomUUID()},${i.id},${w.id},${w.organization_id},${u.id},${d.action},${d.note})`;
      await audit(
        tx,
        r,
        u.id,
        "answer_issue." + d.action,
        i.id,
        w.organization_id,
        w.id,
      );
      return updated;
    });
  });
  app.post(base + "/:issueId/correction", async (r, reply) => {
    const u = await actor(r),
      w = await workspaceAccess(
        u.id,
        id(params(r).workspaceId),
        "conversation:review",
      );
    await workspaceAccess(u.id, w.id, "knowledge:manage");
    const d = z
      .strictObject({
        revision: z.number().int().positive(),
        knowledgeBaseId: z.uuid(),
        question: z.string().trim().min(1).max(2000),
        answer: z.string().trim().min(1).max(12000),
        reason: z.string().trim().min(1).max(2000),
      })
      .parse(r.body);
    const result = await sql.begin(async (tx) => {
      const [i] =
        await tx`SELECT * FROM answer_issues WHERE id=${id(params(r).issueId)} AND workspace_id=${w.id} AND organization_id=${w.organization_id} FOR UPDATE`;
      if (!i) throw new HttpError(404, "Report not found");
      if (
        i.revision !== d.revision ||
        i.assigned_to !== u.id ||
        !["reviewing", "reported"].includes(i.status)
      )
        throw new HttpError(
          409,
          "Claim the current report before proposing a correction",
        );
      const [kb] =
        await tx`SELECT id FROM knowledge_bases WHERE id=${d.knowledgeBaseId} AND workspace_id=${w.id} AND organization_id=${w.organization_id} AND approval_required AND archived_at IS NULL FOR SHARE`;
      if (!kb)
        throw new HttpError(
          400,
          "Select an active approval-required knowledge base",
        );
      const reviewId = randomUUID(),
        improvementId = randomUUID();
      await tx`INSERT INTO conversation_reviews(id,workspace_id,organization_id,message_id,reviewer_id,rating,label,comment,corrected_response,reason) VALUES(${reviewId},${w.id},${w.organization_id},${i.message_id},${u.id},'dislike','incorrect',${i.comment},${d.answer},${d.reason})`;
      await tx`INSERT INTO knowledge_improvements(id,workspace_id,organization_id,review_id,knowledge_base_id,question,answer,author_id,answer_issue_id) VALUES(${improvementId},${w.id},${w.organization_id},${reviewId},${kb.id},${d.question},${d.answer},${u.id},${i.id})`;
      await tx`UPDATE answer_issues SET status='fix_ready',review_id=${reviewId},verification_release_id=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE id=${i.id}`;
      await tx`INSERT INTO answer_issue_events(id,issue_id,workspace_id,organization_id,actor_id,kind,note) VALUES(${randomUUID()},${i.id},${w.id},${w.organization_id},${u.id},'correction_proposed',${d.reason})`;
      await audit(
        tx,
        r,
        u.id,
        "answer_issue.correction_proposed",
        i.id,
        w.organization_id,
        w.id,
      );
      return { id: improvementId };
    });
    return reply.code(201).send(result);
  });
}
