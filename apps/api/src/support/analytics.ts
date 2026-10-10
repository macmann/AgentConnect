import { sql } from "../db.js";
import { profileRows } from "./routing.js";
export async function supportAnalytics(
  wid: string,
  org: string,
  days: number,
  queueId?: string,
) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const [totals] =
    await sql`SELECT count(*)::int AS cases_created,count(*) FILTER(WHERE status IN ('resolved','closed'))::int AS cases_resolved,count(*) FILTER(WHERE status NOT IN ('resolved','closed','cancelled'))::int AS backlog,count(*) FILTER(WHERE sla_state='breached')::int AS breached_cases,count(*) FILTER(WHERE sla_snapshot->'sla'->>'assignmentSeconds' IS NOT NULL OR sla_snapshot->'sla'->>'firstResponseSeconds' IS NOT NULL OR sla_snapshot->'sla'->>'resolutionSeconds' IS NOT NULL)::int AS sla_eligible_cases,COALESCE(sum(transfer_count),0)::int AS transfers,COALESCE(sum(reopen_count),0)::int AS reopens,avg(extract(epoch FROM first_assigned_at-requested_at)) AS assignment_seconds,avg(extract(epoch FROM first_response_at-requested_at)) AS first_response_seconds,avg(extract(epoch FROM resolved_at-requested_at)-resolution_paused_seconds) AS resolution_seconds,percentile_cont(0.5) WITHIN GROUP(ORDER BY extract(epoch FROM first_accepted_at-requested_at)) FILTER(WHERE first_accepted_at IS NOT NULL) AS p50_wait_seconds,percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM first_accepted_at-requested_at)) FILTER(WHERE first_accepted_at IS NOT NULL) AS p95_wait_seconds FROM support_cases WHERE workspace_id=${wid} AND organization_id=${org} AND created_at>=${since} AND (${queueId ?? null}::uuid IS NULL OR queue_id=${queueId ?? null})`;
  // Eligibility is policy-enabled conversations, not fabricated business savings or resolution success.
  const [journeys] =
    await sql`SELECT count(*)::int AS eligible_conversations,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM support_cases s WHERE s.conversation_id=c.id))::int AS handed_off_conversations,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM support_events e WHERE e.conversation_id=c.id AND e.type='ai.resumed'))::int AS returned_to_ai_conversations FROM conversations c WHERE c.workspace_id=${wid} AND c.organization_id=${org} AND c.created_at>=${since} AND (${queueId ?? null}::uuid IS NULL OR EXISTS(SELECT 1 FROM support_cases s WHERE s.conversation_id=c.id AND s.queue_id=${queueId ?? null})) AND COALESCE((SELECT p.policy->>'humanEntryMode' FROM support_policies p WHERE p.workspace_id=c.workspace_id AND ((p.scope='workspace' AND p.target_id=c.workspace_id) OR (p.scope='agent' AND p.target_id=c.agent_id) OR (p.scope='deployment' AND p.target_id=c.deployment_id)) ORDER BY CASE p.scope WHEN 'deployment' THEN 3 WHEN 'agent' THEN 2 ELSE 1 END DESC LIMIT 1),'policy_controlled')<>'disabled'`;
  const reasons =
    await sql`SELECT reason_code,count(*)::int AS count FROM support_cases WHERE workspace_id=${wid} AND organization_id=${org} AND created_at>=${since} AND (${queueId ?? null}::uuid IS NULL OR queue_id=${queueId ?? null}) GROUP BY reason_code ORDER BY count DESC,reason_code LIMIT 30`;
  const queues =
    await sql`SELECT q.id,q.name,count(s.id)::int AS cases_created,count(s.id) FILTER(WHERE s.status IN ('resolved','closed'))::int AS cases_resolved,count(s.id) FILTER(WHERE s.status NOT IN ('resolved','closed','cancelled'))::int AS backlog,avg(extract(epoch FROM s.first_response_at-s.requested_at)) AS first_response_seconds,count(s.id) FILTER(WHERE s.sla_state='breached')::int AS breached FROM support_queues q LEFT JOIN support_cases s ON s.queue_id=q.id AND s.created_at>=${since} WHERE q.workspace_id=${wid} AND q.organization_id=${org} AND (${queueId ?? null}::uuid IS NULL OR q.id=${queueId ?? null}) GROUP BY q.id ORDER BY backlog DESC,q.name LIMIT 100`;
  const operators =
    await sql`SELECT u.id,u.name,count(s.id)::int AS cases_handled,count(s.id) FILTER(WHERE s.status IN ('resolved','closed'))::int AS cases_resolved,count(s.id) FILTER(WHERE s.status IN ('assigned','active','waiting_customer','waiting_external'))::int AS active_cases,avg(extract(epoch FROM s.resolved_at-s.first_accepted_at)) AS handling_seconds,COALESCE(sum(s.transfer_count),0)::int AS transfers,COALESCE(sum(s.reopen_count),0)::int AS reopens FROM support_cases s JOIN users u ON u.id=s.assigned_operator_id WHERE s.workspace_id=${wid} AND s.organization_id=${org} AND s.created_at>=${since} AND (${queueId ?? null}::uuid IS NULL OR s.queue_id=${queueId ?? null}) GROUP BY u.id,u.name ORDER BY u.name LIMIT 100`;
  const [copilot] =
    await sql`SELECT count(*)::int AS generations,count(*) FILTER(WHERE status='completed')::int AS completed,count(*) FILTER(WHERE status='failed')::int AS failed FROM support_copilot WHERE workspace_id=${wid} AND organization_id=${org} AND created_at>=${since} AND (${queueId ?? null}::uuid IS NULL OR EXISTS(SELECT 1 FROM support_cases s WHERE s.id=support_case_id AND s.queue_id=${queueId ?? null}))`;
  return {
    days,
    totals,
    journeys,
    reasons,
    queues,
    operators,
    copilot,
    deflection: null,
    containmentProxy: journeys!.eligible_conversations
      ? 1 -
        journeys!.handed_off_conversations / journeys!.eligible_conversations
      : null,
    handoffRate: journeys!.eligible_conversations
      ? journeys!.handed_off_conversations / journeys!.eligible_conversations
      : null,
    notes:
      "Containment is a no-handoff proxy, not proven resolution. Deflection requires a business baseline. Metrics describe retained records; queue/operator attribution is current or final ownership.",
  };
}
export async function supervisorOverview(wid: string, org: string) {
  const [counts] =
    await sql`SELECT count(*) FILTER(WHERE status NOT IN ('resolved','closed','cancelled'))::int AS backlog,count(*) FILTER(WHERE status NOT IN ('resolved','closed','cancelled') AND assigned_operator_id IS NULL)::int AS unassigned,count(*) FILTER(WHERE status NOT IN ('resolved','closed','cancelled') AND priority='urgent')::int AS urgent,count(*) FILTER(WHERE status NOT IN ('resolved','closed','cancelled') AND sla_state='warning')::int AS warning,count(*) FILTER(WHERE status NOT IN ('resolved','closed','cancelled') AND sla_state='breached')::int AS breached FROM support_cases WHERE workspace_id=${wid} AND organization_id=${org}`;
  const operators = await sql.begin((tx) =>
    profileRows(tx, wid, org, { limit: 100 }),
  );
  const queues =
    await sql`SELECT q.id,q.name,count(s.id)::int AS backlog,count(s.id) FILTER(WHERE s.sla_state='warning')::int AS warning,count(s.id) FILTER(WHERE s.sla_state='breached')::int AS breached FROM support_queues q LEFT JOIN support_cases s ON s.queue_id=q.id AND s.status NOT IN ('resolved','closed','cancelled') WHERE q.workspace_id=${wid} AND q.organization_id=${org} GROUP BY q.id ORDER BY backlog DESC,q.name LIMIT 100`;
  return { counts, operators, queues };
}
