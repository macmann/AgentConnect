import type { FastifyInstance } from "fastify";
import { actor, workspaceAccess, id, params } from "./app.js";
import { sql } from "./db.js";
import { reportRange } from "@agentconnect/schemas/customer-experience";
import { excelReport } from "./excel-report.js";
export function dateRange(query: unknown) {
  const q = reportRange.parse(query);
  return {
    from: q.from ?? new Date(Date.now() - q.days * 86400000).toISOString(),
    to: q.to ?? new Date().toISOString(),
  };
}
export async function customerReport(
  wid: string,
  org: string,
  range: ReturnType<typeof dateRange>,
) {
  const { from, to } = range;
  const [summary] =
    await sql`WITH active AS (SELECT c.* FROM conversations c WHERE c.workspace_id=${wid} AND c.organization_id=${org} AND (EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.created_at>=${from} AND m.created_at<${to}) OR EXISTS(SELECT 1 FROM handoff_events e WHERE e.conversation_id=c.id AND e.created_at>=${from} AND e.created_at<${to} AND e.kind IN ('user_message','operator_message')))) SELECT count(*)::int AS active_conversations,count(*) FILTER(WHERE channel<>'playground')::int AS customer_conversations,count(DISTINCT CASE WHEN channel<>'playground' THEN COALESCE(customer_session_id::text,'legacy:'||id::text) END)::int AS active_customer_sessions,count(DISTINCT user_id)::int AS active_workspace_users,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM support_cases s WHERE s.conversation_id=active.id))::int AS escalated_conversations FROM active`;
  const [searches] =
    await sql`SELECT count(*) FILTER(WHERE error_code IN ('NO_RELEVANT_SOURCES','CITATION_REQUIRED','INVALID_CITATION','GROUNDED_RESPONSE_INVALID') OR answer_kind='no_answer')::int AS failed_searches,count(*)::int AS total_runs,count(*) FILTER(WHERE status='failed')::int AS failed_runs,count(*) FILTER(WHERE answer_kind='clarify')::int AS clarifications FROM agent_runs WHERE workspace_id=${wid} AND organization_id=${org} AND started_at>=${from} AND started_at<${to}`;
  const [feedback] =
    await sql`SELECT count(*)::int AS responses,count(f.rating)::int AS rated_responses,avg(f.rating)::float8 AS average_csat,count(*) FILTER(WHERE f.resolved IS NOT NULL)::int AS resolution_responses,count(*) FILTER(WHERE f.resolved=true)::int AS confirmed_resolved,count(*) FILTER(WHERE f.resolved=true AND NOT EXISTS(SELECT 1 FROM support_cases sc WHERE sc.conversation_id=f.conversation_id))::int AS confirmed_ai_resolved,count(*) FILTER(WHERE f.resolved=false)::int AS unresolved FROM customer_feedback f WHERE f.workspace_id=${wid} AND f.organization_id=${org} AND f.updated_at>=${from} AND f.updated_at<${to}`;
  const categories =
    await sql`SELECT COALESCE(NULLIF(s.triage_result->>'category',''),(SELECT j->>'name' FROM jsonb_array_elements(COALESCE(c.config_snapshot->'journeys','[]'::jsonb)) j WHERE j->>'id'=c.journey_state->>'id' LIMIT 1),'Uncategorized') AS category,count(*)::int AS conversations FROM conversations c LEFT JOIN LATERAL(SELECT triage_result FROM support_cases WHERE conversation_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) s ON true WHERE c.workspace_id=${wid} AND c.organization_id=${org} AND c.channel<>'playground' AND (EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.created_at>=${from} AND m.created_at<${to}) OR EXISTS(SELECT 1 FROM handoff_events e WHERE e.conversation_id=c.id AND e.created_at>=${from} AND e.created_at<${to} AND e.kind IN ('user_message','operator_message'))) GROUP BY 1 ORDER BY 2 DESC,1 LIMIT 100`;
  const trends =
    await sql`WITH days AS (SELECT generate_series(date_trunc('day',${from}::timestamptz AT TIME ZONE 'UTC'), date_trunc('day',(${to}::timestamptz-interval '1 microsecond') AT TIME ZONE 'UTC'),interval '1 day')::date AS day),counts AS (SELECT (m.created_at AT TIME ZONE 'UTC')::date AS day,count(*)::int AS messages,count(DISTINCT m.conversation_id)::int AS conversations FROM messages m WHERE m.workspace_id=${wid} AND m.organization_id=${org} AND m.created_at>=${from} AND m.created_at<${to} GROUP BY 1),runs AS (SELECT (started_at AT TIME ZONE 'UTC')::date AS day,count(*)::int AS runs,count(*) FILTER(WHERE status='failed')::int AS failures FROM agent_runs WHERE workspace_id=${wid} AND organization_id=${org} AND started_at>=${from} AND started_at<${to} GROUP BY 1) SELECT d.day,COALESCE(c.messages,0) AS messages,COALESCE(c.conversations,0) AS conversations,COALESCE(r.runs,0) AS runs,COALESCE(r.failures,0) AS failures FROM days d LEFT JOIN counts c USING(day) LEFT JOIN runs r USING(day) ORDER BY d.day`;
  const agents =
    await sql`SELECT a.id,a.name,count(r.id)::int AS runs,count(r.id) FILTER(WHERE r.status='completed')::int AS completed,count(DISTINCT r.conversation_id)::int AS conversations,sum(r.input_tokens)::float8 AS input_tokens,sum(r.output_tokens)::float8 AS output_tokens FROM agents a LEFT JOIN conversations c ON c.agent_id=a.id LEFT JOIN agent_runs r ON r.conversation_id=c.id AND r.started_at>=${from} AND r.started_at<${to} WHERE a.workspace_id=${wid} AND a.organization_id=${org} GROUP BY a.id ORDER BY runs DESC,a.name LIMIT 100`;
  const operators =
    await sql`WITH relevant AS (SELECT * FROM operator_presence_samples WHERE workspace_id=${wid} AND organization_id=${org} AND recorded_at>=${from} AND recorded_at<${to} UNION ALL (SELECT DISTINCT ON(user_id) * FROM operator_presence_samples WHERE workspace_id=${wid} AND organization_id=${org} AND recorded_at<${from} ORDER BY user_id,recorded_at DESC,id DESC)),samples AS (SELECT p.*,lead(recorded_at) OVER(PARTITION BY workspace_id,user_id ORDER BY recorded_at,id) AS next_at FROM relevant p),durations AS (SELECT user_id,status,GREATEST(0,extract(epoch FROM LEAST(COALESCE(next_at,${to}::timestamptz),COALESCE(expires_at,recorded_at),${to}::timestamptz)-GREATEST(recorded_at,${from}::timestamptz))) AS seconds FROM samples) SELECT u.id,u.name,COALESCE(sum(d.seconds) FILTER(WHERE status IN ('available','busy')),0)::float8 AS staffed_seconds,COALESCE(sum(d.seconds) FILTER(WHERE status='busy'),0)::float8 AS busy_seconds,CASE WHEN sum(d.seconds) FILTER(WHERE status IN ('available','busy'))>0 THEN COALESCE(sum(d.seconds) FILTER(WHERE status='busy'),0)/sum(d.seconds) FILTER(WHERE status IN ('available','busy')) ELSE NULL END::float8 AS busy_presence_rate FROM durations d JOIN users u ON u.id=d.user_id GROUP BY u.id ORDER BY u.name LIMIT 100`;
  const failures =
    await sql`SELECT COALESCE(error_code,CASE WHEN answer_kind='no_answer' THEN 'NO_ANSWER' END) AS reason,count(*)::int AS count FROM agent_runs WHERE workspace_id=${wid} AND organization_id=${org} AND started_at>=${from} AND started_at<${to} AND (status='failed' OR answer_kind='no_answer') GROUP BY 1 ORDER BY count DESC LIMIT 50`;
  return {
    range,
    summary,
    searches,
    feedback,
    categories,
    trends,
    agents,
    operators,
    failures,
    definitions: {
      activeUsers:
        "Distinct deployment-scoped browser customer sessions; legacy anonymous conversations count as separate unknown customers. Workspace users counted separately. These are not verified people.",
      categories:
        "Active customer conversations classified by latest support triage category or configured journey name; other conversations are Uncategorized.",
      utilization:
        "Busy presence seconds / available-plus-busy presence seconds, clipped to expiry. This measures declared presence, not productive handling time. Historical tracking starts at migration 0025; migration 0026 includes enable/availability changes.",
      range: "UTC, inclusive from and exclusive to; retained records only.",
      failedSearches:
        "Knowledge no-answer and retrieval/citation validation failures; this is a knowledge-answer failure count, not only search infrastructure outages.",
      resolution:
        "Customer-confirmed resolution is reported separately from containment. Confirmed AI resolution means customer marked resolved and there was no support case. Denominator is customer resolution responses, not all chats. CSAT is 1–5; staff reviews are excluded. Latest feedback update determines reporting date.",
    },
  };
}
export async function registerCustomerReports(app: FastifyInstance) {
  for (const format of ["insights", "insights.xlsx"])
    app.get(
      "/workspaces/:workspaceId/operations/" + format,
      async (r, reply) => {
        const u = await actor(r),
          w = await workspaceAccess(
            u.id,
            id(params(r).workspaceId),
            "operations:view",
          );
        const report = await customerReport(
          w.id,
          w.organization_id,
          dateRange(r.query),
        );
        if (format.endsWith(".xlsx"))
          return reply
            .type(
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
            .header(
              "content-disposition",
              'attachment; filename="agentconnect-insights.xlsx"',
            )
            .header("cache-control", "no-store")
            .send(
              excelReport({
                Summary: [
                  { ...report.range, ...report.summary, ...report.searches },
                ],
                Feedback: [report.feedback!],
                Categories: [...report.categories],
                Trends: [...report.trends],
                Agents: [...report.agents],
                Operators: [...report.operators],
                Failures: [...report.failures],
                Definitions: Object.entries(report.definitions).map(
                  ([metric, definition]) => ({ metric, definition }),
                ),
              }),
            );
        return report;
      },
    );
}
