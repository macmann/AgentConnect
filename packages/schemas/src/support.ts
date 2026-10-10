import { z } from "zod";
export const supportCaseStatus = z.enum([
  "requested",
  "triaging",
  "queued",
  "assigned",
  "active",
  "waiting_customer",
  "waiting_external",
  "resolved",
  "closed",
  "cancelled",
]);
export type SupportCaseStatus = z.infer<typeof supportCaseStatus>;
export const conversationMode = z.enum([
  "ai",
  "waiting_human",
  "human",
  "returning_to_ai",
]);
export const supportPriority = z.enum(["low", "normal", "high", "urgent"]);
export const routingMode = z.enum([
  "manual",
  "round_robin",
  "least_loaded",
  "skill_based",
  "hybrid",
]);
export const queueInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).default(""),
  enabled: z.boolean().default(true),
  priority: supportPriority.default("normal"),
  // Automated strategies are enabled in Phase C, not silently treated as manual.
  routingStrategy: z.literal("manual").default("manual"),
});
export const queuePatch = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(1000).optional(),
  enabled: z.boolean().optional(),
  priority: supportPriority.optional(),
  routingStrategy: z.literal("manual").optional(),
});
export const caseInput = z.strictObject({
  conversationId: z.uuid(),
  queueId: z.uuid().nullable().default(null),
  reasonCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .default("manual"),
  reasonText: z.string().trim().max(1000).default(""),
  priority: supportPriority.default("normal"),
  idempotencyKey: z.uuid().optional(),
});
export const supportAssignment = z.strictObject({
  operatorId: z.uuid(),
  queueId: z.uuid().nullable().optional(),
});
export const supportResolution = z.strictObject({
  finalResponse: z.string().trim().max(4000).optional(),
  code: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .default("resolved"),
  summary: z.string().trim().min(1).max(4000),
});
export const supportTransition = z.strictObject({ status: supportCaseStatus });
export const supportPage = z
  .strictObject({
    before: z.iso.datetime().optional(),
    beforeId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine(
    (q) => !!q.before === !!q.beforeId,
    "Cursor requires before and beforeId",
  );
export const supportCaseQuery = supportPage.safeExtend({
  status: supportCaseStatus.optional(),
  scope: z
    .enum(["all", "open", "waiting", "active", "mine", "unassigned"])
    .default("all"),
  priority: supportPriority.optional(),
  channel: z.enum(["playground", "hosted", "widget"]).optional(),
  search: z.string().trim().max(100).optional(),
  queueId: z.uuid().optional(),
  assignedOperatorId: z.uuid().optional(),
});
// Pure domain rules are shared with clients; authorization and locking stay server-side.
const transitions: Record<SupportCaseStatus, readonly SupportCaseStatus[]> = {
  requested: ["triaging", "queued", "cancelled"],
  triaging: ["queued", "cancelled"],
  queued: ["assigned", "active", "cancelled"],
  assigned: ["active", "queued", "cancelled"],
  active: ["waiting_customer", "waiting_external", "queued", "resolved"],
  waiting_customer: ["active", "resolved"],
  waiting_external: ["active", "resolved"],
  resolved: ["closed", "active"],
  closed: [],
  cancelled: [],
};
export function canTransition(from: SupportCaseStatus, to: SupportCaseStatus) {
  return transitions[from].includes(to);
}
export function isOpenCase(status: SupportCaseStatus) {
  return !["resolved", "closed", "cancelled"].includes(status);
}
export function controlForCase(status: SupportCaseStatus) {
  if (!isOpenCase(status)) return { mode: "ai", legacy: "resolved" } as const;
  if (["active", "waiting_customer", "waiting_external"].includes(status))
    return { mode: "human", legacy: "active" } as const;
  return { mode: "waiting_human", legacy: "pending" } as const;
}

export const supportMessage = z.strictObject({
  content: z.string().trim().min(1).max(4000),
});
export type SupportCursor = { before: string; beforeId: string };
export type SupportPage<T> = { items: T[]; nextCursor: SupportCursor | null };
export type SupportQueue = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: z.infer<typeof supportPriority>;
};
export type SupportOperator = { id: string; name: string; created_at: string };
export type SupportCaseView = {
  id: string;
  conversation_id: string;
  status: SupportCaseStatus;
  priority: z.infer<typeof supportPriority>;
  queue_id: string | null;
  assigned_operator_id: string | null;
  reason_code: string;
  reason_text: string;
  created_at: string;
  requested_at: string;
  resolved_at: string | null;
  resolution_code: string | null;
  resolution_summary: string | null;
  queue_name: string | null;
  assigned_operator_name: string | null;
  customer_name: string;
  agent_name: string;
  channel: string;
  conversation_mode: z.infer<typeof conversationMode>;
  active_support_case_id: string | null;
  latest_message: string | null;
};
export type SupportTimelineItem = {
  id: string;
  kind: "customer" | "ai" | "operator" | "system" | "note";
  content: string;
  created_at: string;
  actor_name: string | null;
  case_id: string | null;
  event_type: string | null;
  status: string | null;
};
