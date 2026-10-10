import { queueIsOpen, availableQueue } from "./operations.js";
import { queueOperations } from "@agentconnect/schemas/support";
import type { TransactionSql } from "postgres";
import {
  routingPolicy,
  type OperatorProfile,
} from "@agentconnect/schemas/support";
import { sql } from "../db.js";
import {
  appendEvent,
  assignCase,
  lockCase,
  type SupportCase,
} from "./cases.js";
import { lockSupportCapacity } from "./operator-capacity.js";
import { HttpError } from "../http-error.js";
const eligibleMembership = (
  tx: TransactionSql,
  workspaceId: string,
  orgId: string,
) =>
  tx`EXISTS(SELECT 1 FROM memberships m WHERE m.user_id=p.user_id AND m.organization_id=${orgId} AND ((m.workspace_id=${workspaceId} AND m.role IN ('workspace_admin','builder','operator')) OR (m.workspace_id IS NULL AND m.role IN ('owner','org_admin'))))`;
export async function profileRows(
  tx: TransactionSql,
  workspaceId: string,
  orgId: string,
  q: { before?: string; beforeId?: string; limit: number; userId?: string } = {
    limit: 100,
  },
) {
  return tx<OperatorProfile[]>`SELECT p.*,p.user_id AS id,u.name,
 CASE WHEN NOT p.enabled OR NOT p.manual_availability OR p.presence_expires_at IS NULL OR p.presence_expires_at<=clock_timestamp() THEN 'offline' ELSE p.presence_status END AS effective_presence,
 load.count AS active_case_count,GREATEST(0,p.capacity_limit-load.count) AS available_capacity,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('skillId',os.skill_id,'proficiency',os.proficiency)) FROM operator_skills os JOIN support_skills sk ON sk.id=os.skill_id WHERE os.workspace_id=p.workspace_id AND os.user_id=p.user_id),'[]') AS skills
 FROM operator_profiles p JOIN users u ON u.id=p.user_id
 CROSS JOIN LATERAL(SELECT count(*)::int AS count FROM support_cases s WHERE s.workspace_id=p.workspace_id AND s.assigned_operator_id=p.user_id AND s.status IN ('assigned','active','waiting_customer','waiting_external')) load
 WHERE p.workspace_id=${workspaceId} AND p.organization_id=${orgId} AND (${q.userId ?? null}::uuid IS NULL OR p.user_id=${q.userId ?? null}) AND ${eligibleMembership(tx, workspaceId, orgId)} AND (p.created_at,p.user_id)<(${q.before ?? new Date().toISOString()},${q.beforeId ?? "ffffffff-ffff-ffff-ffff-ffffffffffff"}) ORDER BY p.created_at DESC,p.user_id DESC LIMIT ${q.limit + 1}`;
}
export async function validateRoutingSkills(
  tx: TransactionSql,
  workspaceId: string,
  skillIds: string[],
  enabledOnly = true,
) {
  if (!skillIds.length) return;
  const found =
    await tx`SELECT id FROM support_skills WHERE workspace_id=${workspaceId} AND id=ANY(${[...new Set(skillIds)]}::uuid[]) AND (NOT ${enabledOnly} OR enabled) FOR SHARE`;
  if (found.length !== new Set(skillIds).size)
    throw new HttpError(
      400,
      "Routing skills must be enabled skills from this workspace",
    );
}
export async function routingCandidates(tx: TransactionSql, s: SupportCase) {
  if (!s.queue_id)
    throw new HttpError(409, "Choose a queue before routing this case");
  const [queue] =
    await tx`SELECT * FROM support_queues WHERE id=${s.queue_id} AND workspace_id=${s.workspace_id}`;
  if (!queue || !queue.enabled)
    throw new HttpError(409, "Support queue is disabled or unavailable");
  const policy = routingPolicy.parse(queue.routing_config);
  const [caseSignals] =
    await tx`SELECT routing_requirements,triage_status,timed_out_operator_ids,assignment_timeout_count FROM support_cases WHERE id=${s.id}`;
  const signals = caseSignals?.routing_requirements ?? {};
  policy.requiredSkills = [
    ...new Set([...policy.requiredSkills, ...(signals.requiredSkills ?? [])]),
  ];
  policy.preferredSkills = [
    ...new Set([...policy.preferredSkills, ...(signals.preferredSkills ?? [])]),
  ];
  policy.preferredLanguage =
    policy.preferredLanguage ?? signals.preferredLanguage ?? null;
  // Revoked roles are checked live, including after a profile was configured.
  const rows =
    await tx`SELECT p.*,u.name,qm.priority_weight AS queue_weight,qm.last_assigned_at AS queue_last_assigned_at,
 (SELECT count(*)::int FROM support_cases c WHERE c.workspace_id=p.workspace_id AND c.assigned_operator_id=p.user_id AND c.id<>${s.id} AND c.status IN ('assigned','active','waiting_customer','waiting_external')) AS load,
 COALESCE((SELECT jsonb_object_agg(os.skill_id::text,os.proficiency) FROM operator_skills os JOIN support_skills sk ON sk.id=os.skill_id WHERE os.workspace_id=p.workspace_id AND os.user_id=p.user_id AND sk.enabled),'{}') AS skills
 FROM operator_profiles p JOIN users u ON u.id=p.user_id JOIN support_queue_members qm ON qm.workspace_id=p.workspace_id AND qm.user_id=p.user_id AND qm.queue_id=${s.queue_id}
 WHERE p.workspace_id=${s.workspace_id} AND p.organization_id=${s.organization_id} AND p.enabled AND p.manual_availability AND qm.enabled AND p.presence_status='available' AND p.presence_expires_at>clock_timestamp() AND ${eligibleMembership(tx, s.workspace_id, s.organization_id)} ORDER BY p.user_id LIMIT 100`;
  const [prior] = policy.continuity
    ? await tx`SELECT assigned_operator_id FROM support_cases WHERE conversation_id=${s.conversation_id} AND status IN ('resolved','closed') AND assigned_operator_id IS NOT NULL ORDER BY resolved_at DESC NULLS LAST,id DESC LIMIT 1`
    : [];
  const candidates = rows
    .filter(
      (p) =>
        queueIsOpen(queueOperations.parse(queue.operations_config)) &&
        caseSignals!.assignment_timeout_count <
          queueOperations.parse(queue.operations_config)
            .maxAssignmentAttempts &&
        !caseSignals!.timed_out_operator_ids.includes(p.user_id) &&
        p.load < p.capacity_limit &&
        policy.requiredSkills.every((id) => Number(p.skills[id]) >= 1) &&
        (!policy.requiredLanguage ||
          p.languages.includes(policy.requiredLanguage)),
    )
    .map((p) => {
      const skillIds = [
        ...new Set([...policy.requiredSkills, ...policy.preferredSkills]),
      ];
      const proficiency = skillIds.length
        ? skillIds.reduce((sum, id) => sum + Number(p.skills[id] ?? 0), 0) /
          (skillIds.length * 5)
        : 0;
      const factors = {
        skill: skillIds.length
          ? skillIds.filter((id) => p.skills[id]).length / skillIds.length
          : 0,
        language: policy.preferredLanguage
          ? p.languages.includes(policy.preferredLanguage)
            ? 1
            : 0
          : policy.requiredLanguage
            ? 1
            : 0,
        capacity: (p.capacity_limit - p.load) / p.capacity_limit,
        proficiency,
        priority: (p.priority_weight + p.queue_weight) / 20,
        fairness: p.queue_last_assigned_at
          ? Math.min(
              1,
              Math.max(
                0,
                (Date.now() - new Date(p.queue_last_assigned_at).getTime()) /
                  3600000,
              ),
            )
          : 1,
        continuity: prior?.assigned_operator_id === p.user_id ? 1 : 0,
      };
      const score =
        queue.routing_strategy === "least_loaded"
          ? factors.capacity
          : queue.routing_strategy === "skill_based"
            ? factors.skill + factors.proficiency
            : queue.routing_strategy === "round_robin"
              ? 0
              : Object.entries(factors).reduce(
                  (sum, [key, value]) =>
                    sum +
                    value * policy.weights[key as keyof typeof policy.weights],
                  0,
                );
      return {
        userId: p.user_id as string,
        name: p.name as string,
        score,
        factors,
        load: p.load as number,
        capacity: p.capacity_limit as number,
        lastAssignedAt: p.queue_last_assigned_at as string | null,
      };
    });
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      (a.lastAssignedAt ? new Date(a.lastAssignedAt).getTime() : 0) -
        (b.lastAssignedAt ? new Date(b.lastAssignedAt).getTime() : 0) ||
      a.userId.localeCompare(b.userId),
  );
  return {
    strategy: queue.routing_strategy as string,
    assignmentMode: queue.assignment_mode as string,
    queueId: queue.id as string,
    policy,
    candidates,
    reason: candidates.length
      ? "Eligible operators ranked"
      : "No available queue member meets skills, language and capacity requirements",
  };
}
export async function routeCase(
  tx: TransactionSql,
  s: SupportCase,
  actorId: string | null = null,
) {
  await lockSupportCapacity(tx, s.workspace_id);
  if (s.status !== "queued")
    return { assigned: false, reason: "Case is no longer queued" };
  const [triage] =
    await tx`SELECT triage_status FROM support_cases WHERE id=${s.id}`;
  if (["pending", "running"].includes(triage?.triage_status))
    return { assigned: false, reason: "Waiting for bounded handoff triage" };
  const target = await availableQueue(
    tx,
    s.workspace_id,
    s.organization_id,
    s.queue_id,
  );
  if (target && target.id !== s.queue_id) {
    const previous = s.queue_id;
    s.queue_id = target.id;
    await tx`UPDATE support_cases SET queue_id=${target.id},updated_at=clock_timestamp() WHERE id=${s.id}`;
    await appendEvent(
      tx,
      s,
      "routing.fallback",
      { id: null, type: "system" },
      { fromQueueId: previous, queueId: target.id },
    );
  }
  const result = await routingCandidates(tx, s);
  if (result.strategy === "manual" || result.assignmentMode === "manual")
    return { assigned: false, reason: "Queue uses manual assignment" };
  const best = result.candidates[0];
  if (!best) return { assigned: false, reason: result.reason };
  await assignCase(tx, s, best.userId, {
    id: actorId,
    type: actorId ? "supervisor" : "system",
    supervise: true,
  });
  const explanation = {
    strategy: result.strategy,
    operatorId: best.userId,
    score: best.score,
    factors: best.factors,
    loadBefore: best.load,
    capacity: best.capacity,
    policy: result.policy,
    assignedAt: new Date().toISOString(),
  };
  await tx`UPDATE support_cases SET routing_strategy=${result.strategy},routing_score=${best.score},routing_explanation=${tx.json(explanation)} WHERE id=${s.id}`;
  await tx`UPDATE support_queue_members SET last_assigned_at=clock_timestamp() WHERE queue_id=${s.queue_id} AND user_id=${best.userId}`;
  await appendEvent(
    tx,
    s,
    "routing.assigned",
    { id: actorId, type: actorId ? "supervisor" : "system" },
    explanation,
  );
  return { assigned: true, ...explanation };
}
// Bounded, durable backlog polling; no in-memory job can lose a queued case after restart.
export async function processSupportRouting() {
  const backlog =
    await sql`SELECT s.id,s.workspace_id FROM support_cases s JOIN support_queues q ON q.id=s.queue_id WHERE s.status='queued' AND s.triage_status NOT IN ('pending','running') AND s.routing_next_attempt_at<=clock_timestamp() AND q.enabled AND q.assignment_mode='automatic' AND q.routing_strategy<>'manual' ORDER BY s.routing_next_attempt_at,CASE s.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,s.queued_at,s.id LIMIT 25`;
  for (const row of backlog) {
    try {
      await sql.begin(async (tx) => {
        const s = await lockCase(tx, row.id, row.workspace_id);
        const result = await routeCase(tx, s);
        if (!result.assigned && s.status === "queued")
          await tx`UPDATE support_cases SET routing_next_attempt_at=clock_timestamp()+interval '15 seconds' WHERE id=${s.id}`;
      });
    } catch (error) {
      if (!(
        error instanceof HttpError && [404, 409].includes(error.statusCode)
      ))
        throw error;
    }
  }
  return backlog.length;
}

export { processSupportOperations } from "./operations.js";
