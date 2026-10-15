import type { Sql, TransactionSql } from "postgres";
import { sql } from "./db.js";
export type GapCandidate = {
  run_id: string;
  conversation_id: string;
  answer_kind: string | null;
  error_code: string | null;
  answer_reported: boolean;
  question: string;
  review_id: string | null;
  rating: string | null;
  corrected_response: string | null;
  label: string | null;
  started_at: Date;
  customer_rating: number | null;
  customer_resolved: boolean | null;
  handed_off: boolean;
};
/** Preview and reporting must select the same current review and affected population. */
export async function gapCandidates(
  workspace: string,
  org: string,
  from: string,
  to: string,
  limit: number,
  ids: string[] | null = null,
  client: Sql | TransactionSql = sql,
) {
  return client<
    GapCandidate[]
  >`SELECT ar.id AS run_id,ar.conversation_id,ar.answer_kind,ar.error_code,EXISTS(SELECT 1 FROM answer_issues ai JOIN messages am ON am.id=ai.message_id WHERE am.run_id=ar.id) AS answer_reported,q.content AS question,cr.id AS review_id,cr.rating,cr.corrected_response,cr.label,ar.started_at,cf.rating AS customer_rating,cf.resolved AS customer_resolved,EXISTS(SELECT 1 FROM support_cases sc WHERE sc.conversation_id=ar.conversation_id) AS handed_off FROM agent_runs ar JOIN LATERAL(SELECT content FROM messages WHERE run_id=ar.id AND role='user' ORDER BY created_at,id LIMIT 1) q ON true LEFT JOIN LATERAL(SELECT cr.* FROM conversation_reviews cr JOIN messages m ON m.id=cr.message_id WHERE m.run_id=ar.id ORDER BY cr.created_at DESC,cr.id DESC LIMIT 1) cr ON true LEFT JOIN customer_feedback cf ON cf.conversation_id=ar.conversation_id WHERE ar.workspace_id=${workspace} AND ar.organization_id=${org} AND ar.started_at>=${from} AND ar.started_at<${to} AND (${ids === null} OR ar.id=ANY(${ids ?? []}::uuid[])) AND (ar.answer_kind='no_answer' OR ar.error_code IN ('NO_RELEVANT_SOURCES','CITATION_REQUIRED','INVALID_CITATION','GROUNDED_RESPONSE_INVALID') OR cr.rating='dislike' OR cf.rating<=2 OR cf.resolved=false OR EXISTS(SELECT 1 FROM answer_issues ai JOIN messages am ON am.id=ai.message_id WHERE am.run_id=ar.id)) ORDER BY ar.started_at DESC,ar.id DESC LIMIT ${limit}`;
}
export async function gapAssignmentLock(tx: TransactionSql, workspace: string) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${workspace + ":knowledge-gap-groups"},0))`;
}
