import type { TransactionSql } from "postgres";
import {
  queueOperations,
  type QueueOperations,
  isOpenCase,
} from "@agentconnect/schemas/support";
import { sql } from "../db.js";
import { HttpError } from "../http-error.js";
import {
  appendEvent,
  lockCase,
  transitionCase,
  assignCase,
  assertController,
  type SupportCase,
  type SupportActor,
} from "./cases.js";
export function queueIsOpen(config: QueueOperations, now = new Date()) {
  const hours = config.businessHours;
  if (!hours.enabled) return true;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: hours.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (key: string) => parts.find((p) => p.type === key)!.value;
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    part("weekday"),
  );
  const minute = Number(part("hour")) * 60 + Number(part("minute"));
  return hours.weekly.some(
    (w) => w.weekday === day && minute >= w.startMinute && minute < w.endMinute,
  );
}
export async function validateOperations(
  tx: TransactionSql,
  wid: string,
  org: string,
  config: QueueOperations,
  queueId?: string,
) {
  const fallback = config.businessHours.fallbackQueueId;
  if (
    config.businessHours.afterHours === "route_to_fallback_queue" &&
    !fallback
  )
    throw new HttpError(400, "Choose a fallback queue");
  const seen = new Set(queueId ? [queueId] : []);
  let current = fallback;
  for (let depth = 0; current; depth++) {
    if (depth >= 8 || seen.has(current))
      throw new HttpError(
        400,
        "Fallback queues must not form a cycle or exceed eight hops",
      );
    seen.add(current);
    const [q] =
      await tx`SELECT operations_config FROM support_queues WHERE id=${current} AND workspace_id=${wid} AND organization_id=${org} AND enabled`;
    if (!q)
      throw new HttpError(
        400,
        "Choose an enabled fallback queue in this workspace",
      );
    const next = queueOperations.parse(q.operations_config).businessHours;
    current =
      next.afterHours === "route_to_fallback_queue"
        ? next.fallbackQueueId
        : null;
  }
}
export async function availableQueue(
  tx: TransactionSql,
  wid: string,
  org: string,
  queueId: string | null,
  customer = false,
) {
  const seen = new Set<string>();
  let current = queueId;
  while (current) {
    if (seen.has(current) || seen.size >= 8)
      throw new HttpError(
        409,
        "Fallback queue configuration requires administrator review",
      );
    seen.add(current);
    const [q] =
      await tx`SELECT * FROM support_queues WHERE id=${current} AND workspace_id=${wid} AND organization_id=${org} AND enabled`;
    if (!q) throw new HttpError(404, "Enabled support queue unavailable");
    const cfg = queueOperations.parse(q.operations_config);
    if (queueIsOpen(cfg)) return q;
    if (
      cfg.businessHours.afterHours === "route_to_fallback_queue" &&
      cfg.businessHours.fallbackQueueId
    ) {
      current = cfg.businessHours.fallbackQueueId;
      continue;
    }
    if (customer && cfg.businessHours.afterHours === "continue_with_ai")
      throw new HttpError(
        409,
        "Support is outside business hours. Continue with the AI assistant or try again during support hours.",
      );
    return q; // Durable offline case; automatic routing waits for reopening.
  }
  return null;
}
type ClockCase = {
  updated_at?: Date | string;
  requested_at: Date | string;
  first_assigned_at?: Date | string | null;
  first_response_at?: Date | string | null;
  resolved_at?: Date | string | null;
  closed_at?: Date | string | null;
  status: string;
  resolution_paused_at?: Date | string | null;
  resolution_paused_seconds?: number;
  sla_snapshot: unknown;
};
export function caseSLA(s: ClockCase, now = new Date()) {
  const cfg = queueOperations.parse(s.sla_snapshot).sla;
  const start = new Date(s.requested_at).getTime();
  const terminal = ["resolved", "closed", "cancelled"].includes(s.status);
  const stop = terminal
    ? new Date(s.resolved_at ?? s.closed_at ?? s.updated_at ?? now).getTime()
    : now.getTime();
  const paused =
    (s.resolution_paused_seconds ?? 0) +
    (s.resolution_paused_at
      ? Math.max(0, (stop - new Date(s.resolution_paused_at).getTime()) / 1000)
      : 0);
  const details: Record<
    string,
    {
      state: "on_track" | "warning" | "breached";
      elapsedSeconds: number;
      targetSeconds: number;
    }
  > = {};
  for (const [key, target, done, pause] of [
    ["assignment", cfg.assignmentSeconds, s.first_assigned_at, 0],
    ["first_response", cfg.firstResponseSeconds, s.first_response_at, 0],
    ["resolution", cfg.resolutionSeconds, s.resolved_at, paused],
  ] as const) {
    if (target === null) continue;
    const elapsed = Math.max(
      0,
      ((done ? new Date(done).getTime() : stop) - start) / 1000 - pause,
    );
    details[key] = {
      state:
        elapsed >= target
          ? "breached"
          : !done && !terminal && elapsed >= (target * cfg.warningPercent) / 100
            ? "warning"
            : "on_track",
      elapsedSeconds: Math.round(elapsed),
      targetSeconds: target,
    };
  }
  const states = Object.values(details).map((v) => v.state);
  return {
    sla_state: states.includes("breached")
      ? ("breached" as const)
      : states.includes("warning")
        ? ("warning" as const)
        : ("on_track" as const),
    sla_details: details,
  };
}
export async function refreshCaseSLA(tx: TransactionSql, s: SupportCase) {
  const [live] =
    await tx`SELECT * FROM support_cases WHERE id=${s.id} AND workspace_id=${s.workspace_id}`;
  const evaluated = caseSLA(live as ClockCase);
  for (const [metric, d] of Object.entries(evaluated.sla_details))
    if (d.state !== "on_track" && live!.sla_details[metric]?.state !== d.state)
      await appendEvent(
        tx,
        s,
        "sla." + d.state,
        { id: null, type: "system" },
        { metric, targetSeconds: d.targetSeconds },
      );
  await tx`UPDATE support_cases SET sla_state=${evaluated.sla_state},sla_details=${tx.json(evaluated.sla_details)},sla_checked_at=clock_timestamp() WHERE id=${s.id}`;
  return evaluated;
}
export async function transferCase(
  tx: TransactionSql,
  s: SupportCase,
  actor: SupportActor,
  input: { queueId: string; operatorId: string | null; reason: string },
) {
  assertController(s, actor);
  if (!isOpenCase(s.status))
    throw new HttpError(409, "Only open support cases can be transferred");
  const [live] =
    await tx`SELECT triage_status FROM support_cases WHERE id=${s.id}`;
  if (["pending", "running"].includes(live!.triage_status))
    throw new HttpError(409, "Wait for handoff triage before transferring");
  const target = await availableQueue(
    tx,
    s.workspace_id,
    s.organization_id,
    input.queueId,
  );
  if (!target) throw new HttpError(404, "Queue unavailable");
  const oldQueue = s.queue_id,
    oldOperator = s.assigned_operator_id;
  // Requeue inside the existing conversation lock; AI never gains control.
  await transitionCase(tx, s, "queued", actor);
  await tx`UPDATE support_cases SET queue_id=${target.id},transfer_count=transfer_count+1,timed_out_operator_ids='{}',assignment_timeout_count=0,routing_next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=${s.id}`;
  s.queue_id = target.id;
  s.assigned_operator_id = null;
  if (input.operatorId)
    await assignCase(tx, s, input.operatorId, { ...actor, supervise: true });
  await appendEvent(tx, s, "case.transferred", actor, {
    fromQueueId: oldQueue,
    queueId: target.id,
    fromOperatorId: oldOperator,
    operatorId: input.operatorId,
    reason: input.reason,
  });
}
export async function processSupportOperations() {
  const batch =
    await sql`SELECT id,workspace_id FROM support_cases WHERE status NOT IN ('closed','cancelled') AND operations_next_attempt_at<=clock_timestamp() AND (status<>'resolved' OR sla_checked_at IS NULL OR sla_checked_at<updated_at) ORDER BY operations_next_attempt_at,id LIMIT 25`;
  for (const row of batch) {
    try {
      await sql.begin(async (tx) => {
        const s = await lockCase(tx, row.id, row.workspace_id);
        const [live] = await tx`SELECT * FROM support_cases WHERE id=${s.id}`;
        if (!live || (!isOpenCase(s.status) && s.status !== "resolved")) return;
        if (new Date(live.operations_next_attempt_at).getTime() > Date.now())
          return;
        const evaluated = caseSLA(live as ClockCase);
        for (const [metric, d] of Object.entries(evaluated.sla_details))
          if (
            d.state !== "on_track" &&
            live.sla_details[metric]?.state !== d.state
          ) {
            await appendEvent(
              tx,
              s,
              "sla." + d.state,
              { id: null, type: "system" },
              { metric, targetSeconds: d.targetSeconds },
            );
          }
        await tx`UPDATE support_cases SET sla_state=${evaluated.sla_state},sla_details=${tx.json(evaluated.sla_details)},sla_checked_at=clock_timestamp(),operations_next_attempt_at=clock_timestamp()+interval '5 seconds' WHERE id=${s.id}`;
        if (
          s.status === "assigned" &&
          live.acceptance_deadline &&
          new Date(live.acceptance_deadline).getTime() <= Date.now()
        ) {
          const operator = s.assigned_operator_id;
          await transitionCase(tx, s, "queued", {
            id: null,
            type: "system",
            supervise: true,
          });
          await tx`UPDATE support_cases SET assignment_timeout_count=assignment_timeout_count+1,timed_out_operator_ids=array_append(timed_out_operator_ids,${operator}::uuid),routing_next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=${s.id}`;
          await appendEvent(
            tx,
            s,
            "assignment.expired",
            { id: null, type: "system" },
            { operatorId: operator },
          );
        }
      });
    } catch (e) {
      if (!(e instanceof HttpError && [404, 409].includes(e.statusCode)))
        throw e;
    }
  }
  return batch.length;
}
