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
export const presenceStatus = z.enum([
  "offline",
  "available",
  "busy",
  "away",
  "do_not_disturb",
]);
const languageCode = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/);
const uniqueIds = z
  .array(z.uuid())
  .max(20)
  .refine((v) => new Set(v).size === v.length, "Duplicate skills");
export const routingPolicy = z.strictObject({
  requiredSkills: uniqueIds.default([]),
  preferredSkills: uniqueIds.default([]),
  requiredLanguage: languageCode.nullable().default(null),
  preferredLanguage: languageCode.nullable().default(null),
  continuity: z.boolean().default(true),
  weights: z
    .strictObject({
      skill: z.number().min(0).max(100).default(25),
      language: z.number().min(0).max(100).default(20),
      capacity: z.number().min(0).max(100).default(30),
      proficiency: z.number().min(0).max(100).default(10),
      priority: z.number().min(0).max(100).default(5),
      fairness: z.number().min(0).max(100).default(5),
      continuity: z.number().min(0).max(100).default(5),
    })
    .default({
      skill: 25,
      language: 20,
      capacity: 30,
      proficiency: 10,
      priority: 5,
      fairness: 5,
      continuity: 5,
    }),
});
export const operatorProfileInput = z.strictObject({
  enabled: z.boolean().default(true),
  manualAvailability: z.boolean().default(true),
  capacityLimit: z.number().int().min(1).max(100).default(5),
  priorityWeight: z.number().int().min(1).max(10).default(1),
  timezone: z
    .string()
    .max(100)
    .refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, "Use a valid IANA timezone")
    .default("UTC"),
  languages: z
    .array(languageCode)
    .max(30)
    .refine((v) => new Set(v).size === v.length, "Duplicate languages")
    .default([]),
  skills: z
    .array(
      z.strictObject({
        skillId: z.uuid(),
        proficiency: z.number().int().min(1).max(5),
      }),
    )
    .max(20)
    .refine(
      (v) => new Set(v.map((s) => s.skillId)).size === v.length,
      "Duplicate skills",
    )
    .default([]),
});
export const skillInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).default(""),
  enabled: z.boolean().default(true),
});
export const queueMembersInput = z.strictObject({
  members: z
    .array(
      z.strictObject({
        userId: z.uuid(),
        enabled: z.boolean().default(true),
        priorityWeight: z.number().int().min(1).max(10).default(1),
      }),
    )
    .max(100)
    .refine(
      (v) => new Set(v.map((m) => m.userId)).size === v.length,
      "Duplicate members",
    ),
});
export const queueInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).default(""),
  enabled: z.boolean().default(true),
  priority: supportPriority.default("normal"),
  routingStrategy: routingMode.default("manual"),
  assignmentMode: z
    .enum(["manual", "recommend", "automatic"])
    .default("manual"),
  isDefault: z.boolean().default(false),
  routingConfig: routingPolicy.default(routingPolicy.parse({})),
});
export const queuePatch = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(1000).optional(),
  enabled: z.boolean().optional(),
  priority: supportPriority.optional(),
  routingStrategy: routingMode.optional(),
  assignmentMode: z.enum(["manual", "recommend", "automatic"]).optional(),
  isDefault: z.boolean().optional(),
  routingConfig: routingPolicy.optional(),
  members: queueMembersInput.shape.members.optional(),
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
  routing_strategy: z.infer<typeof routingMode>;
  assignment_mode: "manual" | "recommend" | "automatic";
  is_default: boolean;
  routing_config: z.infer<typeof routingPolicy>;
};
export type SupportOperator = { id: string; name: string; created_at: string };
export type SupportCaseView = {
  routing_strategy: string | null;
  routing_score: number | null;
  routing_explanation: { factors?: Record<string, number> };
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

export type OperatorProfile = {
  user_id: string;
  name: string;
  enabled: boolean;
  manual_availability: boolean;
  capacity_limit: number;
  priority_weight: number;
  timezone: string;
  languages: string[];
  presence_status: z.infer<typeof presenceStatus>;
  effective_presence: z.infer<typeof presenceStatus>;
  presence_expires_at: string | null;
  active_case_count: number;
  available_capacity: number;
  skills: { skillId: string; proficiency: number }[];
  created_at: string;
  id: string;
};
export type SupportSkill = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  created_at: string;
};
