import type { TransactionSql } from "postgres";
import { HttpError } from "../http-error.js";
// Serializes capacity reservations across different conversations and routing workers.
// Acquire only after conversation/case locks; configuration writers never acquire cases.
export async function lockSupportCapacity(
  tx: TransactionSql,
  workspaceId: string,
) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 7319))`;
}
export async function reserveOperator(
  tx: TransactionSql,
  userId: string,
  workspaceId: string,
  caseId: string,
) {
  await lockSupportCapacity(tx, workspaceId);
  const [p] =
    await tx`SELECT * FROM operator_profiles WHERE workspace_id=${workspaceId} AND user_id=${userId} FOR UPDATE`;
  // Optional profiles keep the pre-enrichment manual workflow compatible.
  if (!p) return;
  if (!p.enabled || !p.manual_availability)
    throw new HttpError(
      409,
      "Operator is disabled or unavailable for new cases",
    );
  const [load] =
    await tx`SELECT count(*)::int AS count FROM support_cases WHERE workspace_id=${workspaceId} AND assigned_operator_id=${userId} AND id<>${caseId} AND status IN ('assigned','active','waiting_customer','waiting_external')`;
  if (load!.count >= p.capacity_limit)
    throw new HttpError(409, "Operator has reached their support capacity");
  await tx`UPDATE operator_profiles SET last_assigned_at=clock_timestamp() WHERE workspace_id=${workspaceId} AND user_id=${userId}`;
}
