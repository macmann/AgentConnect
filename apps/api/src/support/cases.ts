import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import {
  canTransition,
  controlForCase,
  isOpenCase,
  type SupportCaseStatus,
} from "@agentconnect/schemas/support";
import { permitted, type Role } from "@agentconnect/schemas/foundation";
import { reserveOperator, lockSupportCapacity } from "./operator-capacity.js";
import { caseDetail } from "./queries.js";
import { HttpError } from "../http-error.js";
export type SupportCase = {
  id: string;
  conversation_id: string;
  workspace_id: string;
  organization_id: string;
  status: SupportCaseStatus;
  assigned_operator_id: string | null;
  queue_id: string | null;
  idempotency_key: string | null;
};
export type SupportActor = {
  id: string | null;
  type: "customer" | "operator" | "supervisor" | "system";
  supervise?: boolean;
};
export async function appendEvent(
  tx: TransactionSql,
  s: SupportCase,
  type: string,
  actor: SupportActor,
  payload: Record<string, unknown> = {},
) {
  await tx`INSERT INTO support_events(id,organization_id,workspace_id,conversation_id,support_case_id,type,actor_type,actor_id,payload,created_at) VALUES (${randomUUID()},${s.organization_id},${s.workspace_id},${s.conversation_id},${s.id},${type},${actor.type},${actor.id},${tx.json(payload as never)},clock_timestamp())`;
}
async function legacyEvent(
  tx: TransactionSql,
  s: SupportCase,
  kind: string,
  actor: SupportActor,
  content = "",
) {
  await tx`INSERT INTO handoff_events(id,organization_id,workspace_id,conversation_id,kind,actor_id,content,created_at) VALUES (${randomUUID()},${s.organization_id},${s.workspace_id},${s.conversation_id},${kind},${actor.id},${content},clock_timestamp())`;
}
async function lockConversation(
  tx: TransactionSql,
  conversationId: string,
  workspaceId: string,
) {
  const [c] =
    await tx`SELECT id,workspace_id,organization_id,active_support_case_id FROM conversations WHERE id=${conversationId} AND workspace_id=${workspaceId} FOR UPDATE`;
  if (!c) throw new HttpError(404, "Conversation unavailable");
  const [running] =
    await tx`SELECT id FROM agent_runs WHERE conversation_id=${c.id} AND status='running'`;
  if (running)
    throw new HttpError(409, "Wait for the agent response to finish");
  return c;
}
export async function lockCase(
  tx: TransactionSql,
  caseId: string,
  workspaceId: string,
) {
  // All writers lock conversation first, then case (same order as AI / retention).
  const [ref] =
    await tx`SELECT conversation_id FROM support_cases WHERE id=${caseId} AND workspace_id=${workspaceId}`;
  if (!ref) throw new HttpError(404, "Support case unavailable");
  await lockConversation(tx, ref.conversation_id, workspaceId);
  const [s] = await tx<
    SupportCase[]
  >`SELECT * FROM support_cases WHERE id=${caseId} AND workspace_id=${workspaceId} FOR UPDATE`;
  if (!s) throw new HttpError(404, "Support case unavailable");
  return s;
}
export async function createCase(
  tx: TransactionSql,
  input: {
    conversationId: string;
    workspaceId: string;
    queueId?: string | null;
    reasonCode?: string;
    reasonText?: string;
    priority?: string;
    idempotencyKey?: string;
    legacy?: boolean;
  },
  actor: SupportActor,
) {
  const c = await lockConversation(tx, input.conversationId, input.workspaceId);
  if (input.idempotencyKey) {
    const [prior] = await tx<
      SupportCase[]
    >`SELECT * FROM support_cases WHERE workspace_id=${c.workspace_id} AND idempotency_key=${input.idempotencyKey}`;
    if (prior) {
      if (prior.conversation_id !== c.id)
        throw new HttpError(
          409,
          "Idempotency key belongs to another conversation",
        );
      return { supportCase: prior, created: false };
    }
  }
  const [open] = await tx<
    SupportCase[]
  >`SELECT * FROM support_cases WHERE conversation_id=${c.id} AND status NOT IN ('resolved','closed','cancelled')`;
  if (open) {
    if (input.legacy) throw new HttpError(409, "Support request already open");
    return { supportCase: open, created: false };
  }
  if (!input.queueId) {
    const [defaultQueue] =
      await tx`SELECT id FROM support_queues WHERE workspace_id=${c.workspace_id} AND organization_id=${c.organization_id} AND enabled AND is_default`;
    input.queueId = defaultQueue?.id ?? null;
  }
  if (input.queueId) {
    const [queue] =
      await tx`SELECT id FROM support_queues WHERE id=${input.queueId} AND workspace_id=${c.workspace_id} AND organization_id=${c.organization_id} AND enabled FOR SHARE`;
    if (!queue) throw new HttpError(404, "Enabled support queue unavailable");
  }
  const [s] = await tx<
    SupportCase[]
  >`INSERT INTO support_cases(id,organization_id,workspace_id,conversation_id,status,queue_id,reason_code,reason_text,priority,trigger_type,queued_at,idempotency_key) VALUES (${randomUUID()},${c.organization_id},${c.workspace_id},${c.id},'queued',${input.queueId ?? null},${input.reasonCode ?? "explicit_request"},${input.reasonText ?? ""},${input.priority ?? "normal"},${actor.type === "customer" ? "customer" : "manual"},now(),${input.idempotencyKey ?? null}) RETURNING *`;
  await tx`UPDATE conversations SET conversation_mode='waiting_human',active_support_case_id=${s!.id},handoff_status='pending' WHERE id=${c.id}`;
  await appendEvent(tx, s!, "case.created", actor);
  await legacyEvent(tx, s!, "requested", actor);
  return { supportCase: s!, created: true };
}
export function assertController(s: SupportCase, actor: SupportActor) {
  if (!actor.id || (!actor.supervise && s.assigned_operator_id !== actor.id))
    throw new HttpError(
      403,
      "Only the assigned operator or a supervisor can act on this case",
    );
}
async function setStatus(
  tx: TransactionSql,
  s: SupportCase,
  to: SupportCaseStatus,
  actor: SupportActor,
  event: string,
) {
  if (!canTransition(s.status, to))
    throw new HttpError(
      409,
      `Cannot change support case from ${s.status} to ${to}`,
    );
  if (isOpenCase(to) && !isOpenCase(s.status)) {
    const [open] =
      await tx`SELECT id FROM support_cases WHERE conversation_id=${s.conversation_id} AND status NOT IN ('resolved','closed','cancelled')`;
    if (open)
      throw new HttpError(409, "Conversation already has an open support case");
  }
  const control = controlForCase(to);
  await tx`UPDATE support_cases SET status=${to},updated_at=now(),resolved_at=CASE WHEN ${to}='resolved' THEN now() WHEN ${to}='active' AND status='resolved' THEN NULL ELSE resolved_at END,closed_at=CASE WHEN ${to}='closed' THEN now() ELSE closed_at END WHERE id=${s.id}`;
  // Closing an old resolved case must not overwrite a newer case's control.
  const [c] =
    await tx`SELECT active_support_case_id FROM conversations WHERE id=${s.conversation_id}`;
  if (isOpenCase(to) || c?.active_support_case_id === s.id)
    await tx`UPDATE conversations SET conversation_mode=${control.mode},handoff_status=${control.legacy},active_support_case_id=${isOpenCase(to) ? s.id : null} WHERE id=${s.conversation_id}`;
  await appendEvent(tx, s, event, actor, { from: s.status, to });
  s.status = to;
}
export async function claimCase(
  tx: TransactionSql,
  s: SupportCase,
  actor: SupportActor,
  legacy = false,
) {
  if (!actor.id) throw new HttpError(403, "Sign in required");
  if (!legacy && s.status === "active" && s.assigned_operator_id === actor.id)
    return;
  if (s.status !== "queued")
    throw new HttpError(409, "Support case is not available to claim");
  await eligibleOperator(tx, actor.id, s.workspace_id, s.organization_id);
  await reserveOperator(tx, actor.id, s.workspace_id, s.id);
  await tx`UPDATE support_cases SET assigned_operator_id=${actor.id},assigned_at=now(),accepted_at=now() WHERE id=${s.id}`;
  s.assigned_operator_id = actor.id;
  await setStatus(tx, s, "active", actor, "case.claimed");
  await legacyEvent(tx, s, "claimed", actor);
}
export async function eligibleOperator(
  tx: TransactionSql,
  userId: string,
  workspaceId: string,
  orgId: string,
) {
  const memberships =
    await tx`SELECT role,workspace_id FROM memberships WHERE user_id=${userId} AND organization_id=${orgId} AND (workspace_id=${workspaceId} OR workspace_id IS NULL) FOR SHARE`;
  const org = memberships.find(
    (m) => m.workspace_id === null && ["owner", "org_admin"].includes(m.role),
  );
  const role = (org?.role ??
    memberships.find((m) => m.workspace_id === workspaceId)?.role) as
    Role | undefined;
  if (!role || !permitted(role, "support:reply"))
    throw new HttpError(
      403,
      "Selected user is not an eligible workspace operator",
    );
}
export async function assignCase(
  tx: TransactionSql,
  s: SupportCase,
  operatorId: string,
  actor: SupportActor,
  queueId?: string | null,
) {
  if (!actor.supervise) throw new HttpError(403, "Supervisor access required");
  await lockSupportCapacity(tx, s.workspace_id);
  await eligibleOperator(tx, operatorId, s.workspace_id, s.organization_id);
  if (
    s.status === "assigned" &&
    s.assigned_operator_id === operatorId &&
    (queueId === undefined || queueId === s.queue_id)
  )
    return;
  if (s.status !== "queued")
    throw new HttpError(409, "Only queued cases can be assigned");
  if (queueId && queueId !== s.queue_id) {
    const [queue] =
      await tx`SELECT id FROM support_queues WHERE id=${queueId} AND workspace_id=${s.workspace_id} AND organization_id=${s.organization_id} AND enabled FOR SHARE`;
    if (!queue) throw new HttpError(404, "Enabled support queue unavailable");
  }
  await reserveOperator(tx, operatorId, s.workspace_id, s.id);
  await tx`UPDATE support_cases SET queue_id=${queueId === undefined ? s.queue_id : queueId},assigned_operator_id=${operatorId},assigned_at=now() WHERE id=${s.id}`;
  s.assigned_operator_id = operatorId;
  if (queueId !== undefined) s.queue_id = queueId;
  await setStatus(tx, s, "assigned", actor, "case.assigned");
}
export async function transitionCase(
  tx: TransactionSql,
  s: SupportCase,
  to: SupportCaseStatus,
  actor: SupportActor,
) {
  assertController(s, actor);
  // Claim/assign/resolve carry dedicated invariants and cannot use generic changes.
  if (
    ["assigned", "resolved"].includes(to) ||
    (to === "active" &&
      ![
        "assigned",
        "waiting_customer",
        "waiting_external",
        "resolved",
      ].includes(s.status))
  )
    throw new HttpError(
      409,
      "Use the dedicated claim, assign or resolve action",
    );
  if (to === s.status) return;
  if (to === "active" && s.status === "resolved" && s.assigned_operator_id) {
    await eligibleOperator(
      tx,
      s.assigned_operator_id,
      s.workspace_id,
      s.organization_id,
    );
    await reserveOperator(tx, s.assigned_operator_id, s.workspace_id, s.id);
  }
  await setStatus(tx, s, to, actor, "case.status_changed");
  if (to === "active" && s.assigned_operator_id) {
    await tx`UPDATE support_cases SET accepted_at=now() WHERE id=${s.id}`;
    await legacyEvent(tx, s, "claimed", actor);
  }
  if (to === "queued")
    await tx`UPDATE support_cases SET assigned_operator_id=NULL,assigned_at=NULL,accepted_at=NULL WHERE id=${s.id}`;
}
export async function resolveCase(
  tx: TransactionSql,
  s: SupportCase,
  actor: SupportActor,
  summary: string,
  code: string,
  legacy = false,
) {
  assertController(s, actor);
  if (!legacy && s.status === "resolved") return;
  // Legacy inbox can resolve unclaimed requests; record a claim first.
  if (legacy && s.status === "queued" && actor.supervise)
    await claimCase(tx, s, actor);
  if (!["active", "waiting_customer", "waiting_external"].includes(s.status))
    throw new HttpError(409, "Support case must be active before resolution");
  await tx`UPDATE support_cases SET resolution_code=${code},resolution_summary=${summary},resume_context=${tx.json({ summary, code })} WHERE id=${s.id}`;
  await setStatus(tx, s, "resolved", actor, "case.resolved");
  await legacyEvent(tx, s, "resolved", actor);
}
export async function sendSupportMessage(
  tx: TransactionSql,
  s: SupportCase,
  actor: SupportActor,
  content: string,
) {
  if (!isOpenCase(s.status))
    throw new HttpError(409, "Support request is not open");
  if (actor.type !== "customer") {
    assertController(s, actor);
    if (!["active", "waiting_customer", "waiting_external"].includes(s.status))
      throw new HttpError(409, "Accept the case before replying");
  }
  const column =
    actor.type === "customer"
      ? "last_customer_message_at"
      : "last_human_message_at";
  await tx`UPDATE conversations SET ${tx(column)}=now() WHERE id=${s.conversation_id}`;
  if (actor.type !== "customer")
    await tx`UPDATE support_cases SET first_response_at=COALESCE(first_response_at,now()),updated_at=now() WHERE id=${s.id}`;
  await appendEvent(tx, s, "message.created", actor, { content });
  await legacyEvent(
    tx,
    s,
    actor.type === "customer" ? "user_message" : "operator_message",
    actor,
    content,
  );
}
export async function legacyHandoff(
  tx: TransactionSql,
  conversationId: string,
  workspaceId: string,
  action: "request" | "claim" | "resolve" | "message" | "reply",
  content: string,
  actor: SupportActor,
) {
  if (action === "request")
    return createCase(tx, { conversationId, workspaceId, legacy: true }, actor);
  const c = await lockConversation(tx, conversationId, workspaceId);
  if (!c.active_support_case_id)
    throw new HttpError(409, "Support request is not open");
  const s = await lockCase(tx, c.active_support_case_id, workspaceId);
  if (action === "claim") await claimCase(tx, s, actor, true);
  else if (action === "resolve") {
    // Preserve legacy resolve of pending requests by operators.
    if (s.status === "queued") await claimCase(tx, s, actor);
    await resolveCase(
      tx,
      s,
      actor,
      "Resolved through the legacy support inbox.",
      "resolved",
      true,
    );
  } else await sendSupportMessage(tx, s, actor, content);
}
export async function readCase(caseId: string, workspaceId: string) {
  const s = await caseDetail(caseId, workspaceId);
  if (!s) throw new HttpError(404, "Support case unavailable");
  return s;
}
