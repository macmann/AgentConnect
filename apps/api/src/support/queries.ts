import { sql } from "../db.js";
import type { z } from "zod";
import type { supportCaseQuery } from "@agentconnect/schemas/support";
// Projection is shared by list/detail so the console never invents customer or operator context.
const projection = sql`s.*,c.channel,c.conversation_mode,c.active_support_case_id,a.name AS agent_name,COALESCE(customer.name,'Guest visitor') AS customer_name,q.name AS queue_name,operator.name AS assigned_operator_name`;
const joins = sql`FROM support_cases s JOIN conversations c ON c.id=s.conversation_id JOIN agents a ON a.id=c.agent_id LEFT JOIN users customer ON customer.id=c.user_id LEFT JOIN users operator ON operator.id=s.assigned_operator_id LEFT JOIN support_queues q ON q.id=s.queue_id`;
export async function caseDetail(caseId: string, workspaceId: string) {
  const [row] =
    await sql`SELECT ${projection},NULL::text AS latest_message ${joins} WHERE s.id=${caseId} AND s.workspace_id=${workspaceId}`;
  return row;
}
export async function listCases(
  workspaceId: string,
  organizationId: string,
  userId: string,
  query: z.infer<typeof supportCaseQuery>,
) {
  const q = query,
    term = (q.search ?? "").toLowerCase();
  return sql`SELECT ${projection},latest.content AS latest_message ${joins}
 LEFT JOIN LATERAL (SELECT content FROM (
  SELECT m.content,m.created_at,m.id FROM messages m WHERE m.conversation_id=c.id
  UNION ALL SELECT e.payload->>'content',e.created_at,e.id FROM support_events e WHERE e.conversation_id=c.id AND (e.type='message.created')
 ) messages ORDER BY created_at DESC,id DESC LIMIT 1) latest ON true
 WHERE s.workspace_id=${workspaceId} AND s.organization_id=${organizationId}
 AND (${q.status ?? null}::text IS NULL OR s.status=${q.status ?? null})
 AND (${q.queueId ?? null}::uuid IS NULL OR s.queue_id=${q.queueId ?? null})
 AND (${q.assignedOperatorId ?? null}::uuid IS NULL OR s.assigned_operator_id=${q.assignedOperatorId ?? null})
 AND (${q.priority ?? null}::text IS NULL OR s.priority=${q.priority ?? null})
 AND (${q.channel ?? null}::text IS NULL OR c.channel=${q.channel ?? null})
 AND (${q.scope}='all' OR (s.status NOT IN ('resolved','closed','cancelled') AND
  (${q.scope}='open' OR (${q.scope}='waiting' AND s.status IN ('requested','triaging','queued','assigned')) OR (${q.scope}='active' AND s.status IN ('active','waiting_customer','waiting_external')) OR (${q.scope}='mine' AND s.assigned_operator_id=${userId}) OR (${q.scope}='unassigned' AND s.assigned_operator_id IS NULL))))
 AND (${term}='' OR strpos(lower(s.id::text),${term})>0 OR strpos(lower(c.id::text),${term})>0 OR strpos(lower(COALESCE(customer.name,'Guest visitor')),${term})>0 OR strpos(lower(s.reason_text),${term})>0)
 AND (s.created_at,s.id)<(${q.before ?? new Date().toISOString()},${q.beforeId ?? "ffffffff-ffff-ffff-ffff-ffffffffffff"})
 ORDER BY s.created_at DESC,s.id DESC LIMIT ${q.limit + 1}`;
}
export async function conversationTimeline(
  conversationId: string,
  workspaceId: string,
  before: string | undefined,
  beforeId: string | undefined,
  limit: number,
) {
  // Query persisted events for the whole conversation, including previous interventions.
  // Notes enter only this private projection; they are never copied to public handoff events or model messages.
  return sql`SELECT * FROM (
 SELECT m.id,CASE m.role WHEN 'user' THEN 'customer' ELSE 'ai' END AS kind,m.content,m.created_at,NULL::text AS actor_name,NULL::uuid AS case_id,NULL::text AS event_type,ar.status
 FROM messages m JOIN agent_runs ar ON ar.id=m.run_id WHERE m.conversation_id=${conversationId} AND m.workspace_id=${workspaceId}
 UNION ALL
 SELECT e.id,CASE WHEN e.type='note.created' THEN 'note' WHEN e.type='message.created' THEN CASE WHEN e.actor_type='customer' THEN 'customer' ELSE 'operator' END ELSE 'system' END,
 CASE WHEN e.type='note.created' THEN n.content ELSE COALESCE(e.payload->>'content','') END,e.created_at,u.name,e.support_case_id,e.type,NULL::text
 FROM support_events e LEFT JOIN users u ON u.id=e.actor_id
 LEFT JOIN support_notes n ON n.id::text=e.payload->>'noteId' AND n.support_case_id=e.support_case_id AND n.workspace_id=e.workspace_id AND n.organization_id=e.organization_id
 WHERE e.conversation_id=${conversationId} AND e.workspace_id=${workspaceId}
 ) timeline WHERE (created_at,id)<(${before ?? new Date().toISOString()},${beforeId ?? "ffffffff-ffff-ffff-ffff-ffffffffffff"})
 ORDER BY created_at DESC,id DESC LIMIT ${limit + 1}`;
}

// Private copilot input intentionally excludes internal notes and metadata events before pagination.
export async function copilotTranscript(
  conversationId: string,
  workspaceId: string,
) {
  return sql`SELECT * FROM (
    SELECT m.id,CASE m.role WHEN 'user' THEN 'customer' ELSE 'ai' END AS role,left(m.content,2000) AS content,ar.status,m.created_at
    FROM messages m JOIN agent_runs ar ON ar.id=m.run_id WHERE m.conversation_id=${conversationId} AND m.workspace_id=${workspaceId}
    UNION ALL
    SELECT e.id,CASE WHEN e.actor_type='customer' THEN 'customer' ELSE 'operator' END,left(COALESCE(e.payload->>'content',''),2000),NULL::text,e.created_at
    FROM support_events e WHERE e.conversation_id=${conversationId} AND e.workspace_id=${workspaceId} AND e.type='message.created'
  ) messages ORDER BY created_at DESC,id DESC LIMIT 30`;
}
