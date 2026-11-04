import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { actor, workspaceAccess, id, params, audit } from "./app.js";
import { sql } from "./db.js";
import { HttpError } from "./http-error.js";
import { addSource } from "./knowledge.js";
import type { KnowledgeBase } from "./knowledge-core.js";
import { qaInput } from "@agentconnect/schemas/knowledge";
type Row = { id: string; created_at: Date; [key: string]: unknown };
const cursor = z.object({
  before: z.iso.datetime().optional(),
  beforeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
function check(q: z.infer<typeof cursor>) {
  if (!!q.before !== !!q.beforeId)
    throw new HttpError(400, "Cursor requires before and beforeId");
}
function page(rows: Row[], limit: number) {
  const items = rows.slice(0, limit),
    last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? { before: last.created_at.toISOString(), beforeId: last.id }
        : null,
  };
}
async function context(r: FastifyRequest) {
  const u = await actor(r);
  const w = await workspaceAccess(
    u.id,
    id(params(r).workspaceId),
    "conversation:view",
  );
  return { u, w };
}
async function conversation(r: FastifyRequest) {
  const ctx = await context(r);
  const [c] =
    await sql`SELECT c.id,c.agent_id,c.workspace_id,c.organization_id,c.created_at,c.channel,c.conversation_mode,c.customer_session_id,a.name AS agent_name,CASE WHEN c.channel='api' THEN 'API client' ELSE COALESCE(NULLIF(btrim(u.name),''),'Anonymous') END AS customer_name,CASE WHEN c.channel='api' THEN 'api_client' WHEN c.user_id IS NULL THEN 'anonymous' ELSE 'registered' END AS identity_type FROM conversations c JOIN agents a ON a.id=c.agent_id LEFT JOIN users u ON u.id=c.user_id WHERE c.id=${id(params(r).conversationId)} AND c.workspace_id=${ctx.w.id} AND c.organization_id=${ctx.w.organization_id}`;
  if (!c) throw new HttpError(404, "Conversation not found");
  return { ...ctx, c };
}
export async function registerConversationHistory(app: FastifyInstance) {
  const base = "/workspaces/:workspaceId/conversation-history";
  app.get(base, async (r) => {
    const { w } = await context(r);
    const q = cursor
      .extend({
        agentId: z.uuid().optional(),
        channel: z
          .enum([
            "playground",
            "hosted",
            "widget",
            "api",
            "messenger",
            "viber",
            "telegram",
            "teams",
          ])
          .optional(),
        identity: z.enum(["registered", "anonymous", "api_client"]).optional(),
        mode: z
          .enum(["ai", "waiting_human", "human", "returning_to_ai"])
          .optional(),
        status: z
          .enum(["running", "completed", "failed", "cancelled"])
          .optional(),
        rating: z.enum(["like", "dislike"]).optional(),
        search: z.string().trim().max(200).default(""),
        fromDate: z.iso.date().optional(),
        toDate: z.iso.date().optional(),
      })
      .parse(r.query);
    check(q);
    if (q.fromDate && q.toDate && q.fromDate > q.toDate)
      throw new HttpError(400, "Start date must precede end date");
    const term = q.search.toLowerCase();
    const rows = await sql<
      Row[]
    >`SELECT c.id,c.created_at,c.agent_id,c.channel,c.conversation_mode,c.customer_session_id,a.name AS agent_name,
 CASE WHEN c.channel='api' THEN 'API client' ELSE COALESCE(NULLIF(btrim(u.name),''),'Anonymous') END AS customer_name,
 CASE WHEN c.channel='api' THEN 'api_client' WHEN c.user_id IS NULL THEN 'anonymous' ELSE 'registered' END AS identity_type,
 latest.status,latest.error_code,preview.content AS latest_message
 FROM conversations c JOIN agents a ON a.id=c.agent_id LEFT JOIN users u ON u.id=c.user_id
 LEFT JOIN LATERAL(SELECT status,error_code FROM agent_runs WHERE conversation_id=c.id ORDER BY started_at DESC,id DESC LIMIT 1) latest ON true
 LEFT JOIN LATERAL(SELECT content FROM(SELECT content,created_at,id FROM messages WHERE conversation_id=c.id UNION ALL SELECT payload->>'content',created_at,id FROM support_events WHERE conversation_id=c.id AND type='message.created') m ORDER BY created_at DESC,id DESC LIMIT 1) preview ON true
 WHERE c.workspace_id=${w.id} AND c.organization_id=${w.organization_id}
 AND (${q.agentId ?? null}::uuid IS NULL OR c.agent_id=${q.agentId ?? null})
 AND (${q.channel ?? null}::text IS NULL OR c.channel=${q.channel ?? null})
 AND (${q.mode ?? null}::text IS NULL OR c.conversation_mode=${q.mode ?? null})
 AND (${q.status ?? null}::text IS NULL OR latest.status=${q.status ?? null})
 AND (${q.identity ?? null}::text IS NULL OR CASE WHEN c.channel='api' THEN 'api_client' WHEN c.user_id IS NULL THEN 'anonymous' ELSE 'registered' END=${q.identity ?? null})
 AND (${q.rating ?? null}::text IS NULL OR EXISTS(SELECT 1 FROM conversation_reviews cr JOIN messages m ON m.id=cr.message_id WHERE m.conversation_id=c.id AND cr.rating=${q.rating ?? null}))
 AND (${q.fromDate ?? null}::date IS NULL OR c.created_at>=${q.fromDate ? q.fromDate + "T00:00:00Z" : null}::timestamptz)
 AND (${q.toDate ?? null}::date IS NULL OR c.created_at<${q.toDate ? q.toDate + "T00:00:00Z" : null}::timestamptz+interval '1 day')
 AND (${term}='' OR strpos(c.id::text,${term})>0 OR strpos(lower(CASE WHEN c.channel='api' THEN 'API client' ELSE COALESCE(NULLIF(btrim(u.name),''),'Anonymous') END),${term})>0 OR EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND strpos(lower(m.content),${term})>0) OR EXISTS(SELECT 1 FROM support_events e WHERE e.conversation_id=c.id AND e.type='message.created' AND strpos(lower(e.payload->>'content'),${term})>0))
 AND (c.created_at,c.id)<(${q.before ?? new Date().toISOString()},${q.beforeId ?? "ffffffff-ffff-ffff-ffff-ffffffffffff"}) ORDER BY c.created_at DESC,c.id DESC LIMIT ${q.limit + 1}`;
    return page(rows, q.limit);
  });
  app.get(base + "/:conversationId", async (r) => {
    const { c, w } = await conversation(r);
    const goldenAnswers =
      await sql`SELECT id,knowledge_base_id,title,status,metadata->'provenance'->>'messageId' AS message_id FROM knowledge_sources WHERE workspace_id=${w.id} AND organization_id=${w.organization_id} AND kind='qa' AND status<>'deleted' AND metadata->'provenance'->>'conversationId'=${c.id}`;
    const [run] =
      await sql`SELECT status FROM agent_runs WHERE conversation_id=${c.id} AND workspace_id=${w.id} ORDER BY started_at DESC,id DESC LIMIT 1`;
    return { ...c, run_status: run?.status ?? null, goldenAnswers };
  });
  app.get(base + "/:conversationId/timeline", async (r) => {
    const { c, w } = await conversation(r);
    const q = cursor.parse(r.query);
    check(q);
    const rows = await sql<Row[]>`SELECT * FROM(
 SELECT m.id,m.created_at,m.role,m.content,m.attachments,m.citations,m.ui_blocks,ar.status,ar.error_code,NULL::text AS actor_name,'ai'::text AS origin FROM messages m JOIN agent_runs ar ON ar.id=m.run_id WHERE m.conversation_id=${c.id} AND m.workspace_id=${w.id} AND m.organization_id=${w.organization_id}
 UNION ALL SELECT e.id,e.created_at,CASE WHEN e.type='message.created' THEN CASE WHEN e.actor_type='customer' THEN 'user' ELSE 'human' END ELSE 'system' END,CASE WHEN e.type='message.created' THEN COALESCE(e.payload->>'content','') ELSE replace(e.type,'.',' ') END,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,NULL::text,NULL::text,CASE WHEN e.actor_type IN ('operator','supervisor') THEN u.name ELSE NULL END,'support' FROM support_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.conversation_id=${c.id} AND e.workspace_id=${w.id} AND e.organization_id=${w.organization_id} AND e.type<>'note.created'
 ) t WHERE (created_at,id)<(${q.before ?? new Date().toISOString()},${q.beforeId ?? "ffffffff-ffff-ffff-ffff-ffffffffffff"}) ORDER BY created_at DESC,id DESC LIMIT ${q.limit + 1}`;
    return page(rows, q.limit);
  });
  app.post(
    base + "/:conversationId/golden-answers",
    { bodyLimit: 100000 },
    async (r, reply) => {
      const { u, w, c } = await conversation(r);
      await workspaceAccess(u.id, w.id, "conversation:review");
      await workspaceAccess(u.id, w.id, "knowledge:manage");
      const data = qaInput
        .extend({ knowledgeBaseId: z.uuid(), messageId: z.uuid() })
        .parse(r.body);
      const [kb] = await sql<
        KnowledgeBase[]
      >`SELECT * FROM knowledge_bases WHERE id=${data.knowledgeBaseId} AND workspace_id=${w.id} AND organization_id=${w.organization_id} AND archived_at IS NULL`;
      if (!kb) throw new HttpError(404, "Knowledge base unavailable");
      const result = await sql.begin(async (tx) => {
        await tx`SELECT id FROM conversations WHERE id=${c.id} AND workspace_id=${w.id} FOR UPDATE`;
        const [answer] =
          await tx`SELECT id FROM messages WHERE id=${data.messageId} AND conversation_id=${c.id} AND workspace_id=${w.id} AND role='assistant' UNION ALL SELECT id FROM support_events WHERE id=${data.messageId} AND conversation_id=${c.id} AND workspace_id=${w.id} AND type='message.created' AND actor_type IN ('operator','supervisor')`;
        if (!answer) throw new HttpError(404, "AI or human answer not found");
        const [existing] =
          await tx`SELECT id FROM knowledge_sources WHERE knowledge_base_id=${kb.id} AND workspace_id=${w.id} AND kind='qa' AND status<>'deleted' AND metadata->'provenance'->>'messageId'=${data.messageId} AND metadata->'provenance'->>'conversationId'=${c.id}`;
        if (existing)
          throw new HttpError(
            409,
            "This answer already has a golden Q&A. Edit it in the Q&A view.",
          );
        const saved = await addSource(
          r,
          kb,
          u.id,
          "qa",
          data.question,
          Buffer.from(`Question: ${data.question}\nAnswer: ${data.answer}`),
          "qa.txt",
          {
            question: data.question,
            answer: data.answer,
            tags: [
              ...new Set([
                "golden-answer",
                "conversation-history",
                ...data.tags,
              ]),
            ].slice(0, 20),
            goldenAnswer: true,
            provenance: {
              kind: "conversation_history",
              conversationId: c.id,
              messageId: data.messageId,
              agentId: c.agent_id,
              reviewerId: u.id,
              reviewedAt: new Date().toISOString(),
            },
          },
          null,
          tx,
        );
        await audit(
          tx,
          r,
          u.id,
          "conversation.golden_answer_saved",
          saved.id,
          w.organization_id,
          w.id,
        );
        return saved;
      });
      return reply.code(202).send(result);
    },
  );
}
