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
const targetSeconds = z
  .number()
  .int()
  .min(1)
  .max(2592000)
  .nullable()
  .default(null);
export const queueOperations = z.strictObject({
  sla: z
    .strictObject({
      assignmentSeconds: targetSeconds,
      firstResponseSeconds: targetSeconds,
      resolutionSeconds: targetSeconds,
      warningPercent: z.number().int().min(1).max(99).default(80),
      pauseWaitingCustomer: z.boolean().default(true),
      pauseWaitingExternal: z.boolean().default(false),
    })
    .default({
      assignmentSeconds: null,
      firstResponseSeconds: null,
      resolutionSeconds: null,
      warningPercent: 80,
      pauseWaitingCustomer: true,
      pauseWaitingExternal: false,
    }),
  acceptanceTimeoutSeconds: z.number().int().min(15).max(86400).default(120),
  maxAssignmentAttempts: z.number().int().min(1).max(10).default(3),
  businessHours: z
    .strictObject({
      enabled: z.boolean().default(false),
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
      weekly: z
        .array(
          z
            .strictObject({
              weekday: z.number().int().min(0).max(6),
              startMinute: z.number().int().min(0).max(1439),
              endMinute: z.number().int().min(1).max(1440),
            })
            .refine(
              (v) => v.endMinute > v.startMinute,
              "Closing time must follow opening time",
            ),
        )
        .max(21)
        .default([])
        .refine(
          (v) =>
            v.every((a, i) =>
              v.every(
                (b, j) =>
                  i === j ||
                  a.weekday !== b.weekday ||
                  a.endMinute <= b.startMinute ||
                  b.endMinute <= a.startMinute,
              ),
            ),
          "Hours must not overlap",
        ),
      afterHours: z
        .enum([
          "create_offline_case",
          "continue_with_ai",
          "collect_message",
          "show_business_hours",
          "route_to_fallback_queue",
        ])
        .default("create_offline_case"),
      fallbackQueueId: z.uuid().nullable().default(null),
    })
    .default({
      enabled: false,
      timezone: "UTC",
      weekly: [],
      afterHours: "create_offline_case",
      fallbackQueueId: null,
    }),
});
export type QueueOperations = z.infer<typeof queueOperations>;
export const supportTransfer = z.strictObject({
  queueId: z.uuid(),
  operatorId: z.uuid().nullable().default(null),
  reason: z.string().trim().min(1).max(500),
});
export const supportPriorityChange = z.strictObject({
  priority: supportPriority,
  reason: z.string().trim().min(1).max(500),
});
export const supportAnalyticsQuery = z.strictObject({
  days: z.coerce.number().int().min(1).max(90).default(30),
  queueId: z.uuid().optional(),
});
export const queueInput = z.strictObject({
  operations: queueOperations.default(queueOperations.parse({})),
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
  operations: queueOperations.optional(),
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
export const resumeFacts = z
  .strictObject({
    issue: z.string().trim().max(500).default(""),
    resolution: z.string().trim().max(2000).default(""),
    actionsCompleted: z
      .array(z.string().trim().min(1).max(300))
      .max(20)
      .default([]),
    references: z
      .record(
        z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/),
        z.string().trim().min(1).max(200),
      )
      .default({})
      .refine((v) => Object.keys(v).length <= 20, "Too many references"),
    expectedNextStep: z.string().trim().max(1000).default(""),
    doNotRepeat: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
    doNotRepeatToolIds: uniqueIds.default([]),
  })
  .refine(
    (v) => utf8Size(v) <= 8000,
    "Approved resolution context is too large",
  );
// Shared schema runs in browser and server without depending on Node's Buffer.
function utf8Size(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
export const aiResumeContext = z.strictObject({
  schemaVersion: z.literal(1),
  caseId: z.uuid(),
  facts: resumeFacts,
  approvedBy: z.uuid().nullable(),
  approvedAt: z.iso.datetime(),
  origin: z.enum(["operator", "deterministic_fallback"]),
});
export type ResumeFacts = z.infer<typeof resumeFacts>;
export type AIResumeContext = z.infer<typeof aiResumeContext>;
export const supportResolution = z.strictObject({
  resume: resumeFacts.optional(),
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
  slaState: z.enum(["on_track", "warning", "breached"]).optional(),
  language: languageCode.optional(),
  fromDate: z.iso.date().optional(),
  toDate: z.iso.date().optional(),
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
  waiting_customer: ["active", "queued", "resolved"],
  waiting_external: ["active", "queued", "resolved"],
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
  operations_config: QueueOperations;
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
  workspace_id: string;
  sla_state: "on_track" | "warning" | "breached";
  sla_details: Record<
    string,
    { state: string; elapsedSeconds: number; targetSeconds: number }
  >;
  acceptance_deadline: string | null;
  assignment_timeout_count: number;
  reopen_count: number;
  transfer_count: number;
  ai_resume_case_id: string | null;
  resume_context: Partial<AIResumeContext>;
  triage_status: string;
  triage_result: Record<string, unknown>;
  handoff_brief: Partial<TriageResult> & {
    provenance?: { modelId?: string; generatedAt?: string };
  };
  triage_provenance: {
    modelId?: string;
    generatedAt?: string;
    errorCode?: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
  };
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

// Escalation configuration is a complete override at each scope, never an ambiguous partial merge.
export const handoffPolicy = z.strictObject({
  humanEntryMode: z
    .enum(["disabled", "policy_controlled", "always_available"])
    .default("policy_controlled"),
  explicitRequestThreshold: z.number().int().min(1).max(10).default(2),
  loopDetectionEnabled: z.boolean().default(true),
  maxResolutionAttempts: z.number().int().min(2).max(10).default(3),
  toolFailureEscalationEnabled: z.boolean().default(true),
  toolFailureThreshold: z.number().int().min(1).max(10).default(2),
  agentCanRequestHandoff: z.boolean().default(false),
  sentimentEscalationEnabled: z.boolean().default(false),
  defaultQueueId: z.uuid().nullable().default(null),
  defaultPriority: supportPriority.default("normal"),
  aiTriageEnabled: z.boolean().default(true),
  generateHandoffSummary: z.boolean().default(true),
  returnToAIEnabled: z.boolean().default(true),
  includeHumanMessagesInAIContext: z.boolean().default(true),
  generateResolutionSummary: z.boolean().default(false),
  resolutionModelId: z.uuid().nullable().default(null),
  copilotEnabled: z.boolean().default(true),
  copilotModelId: z.uuid().nullable().default(null),
  copilotMaxOutputTokens: z.number().int().min(256).max(8192).default(2048),
  triageModelId: z.uuid().nullable().default(null),
  maxOutputTokens: z.number().int().min(256).max(8192).default(2048),
  intentRules: z
    .array(
      z.strictObject({
        intent: z.string().trim().min(1).max(80),
        queueId: z.uuid().nullable().default(null),
        priority: supportPriority.default("normal"),
        requiredSkills: uniqueIds.default([]),
      }),
    )
    .max(20)
    .refine(
      (v) => new Set(v.map((r) => r.intent)).size === v.length,
      "Duplicate intents",
    )
    .default([]),
});
export type HandoffPolicy = z.infer<typeof handoffPolicy>;
export const handoffPolicyScope = z
  .strictObject({
    scope: z.enum(["workspace", "agent", "deployment"]).default("workspace"),
    targetId: z.uuid().optional(),
  })
  .refine(
    (v) => v.scope === "workspace" || !!v.targetId,
    "Select the agent or deployment",
  );
export const triageResult = z.strictObject({
  intent: z.string().trim().max(80),
  category: z.string().trim().max(80),
  priority: supportPriority,
  language: languageCode.nullable(),
  requiredSkills: z.array(z.string().trim().min(1).max(100)).max(20),
  preferredSkills: z.array(z.string().trim().min(1).max(100)).max(20),
  sentiment: z.enum(["neutral", "positive", "frustrated", "unknown"]),
  complexity: z.enum(["low", "medium", "high", "unknown"]),
  summary: z.string().trim().min(1).max(2000),
  reason: z.string().trim().max(1000),
  customerContext: z.array(z.string().trim().max(500)).max(10),
  actionsAttempted: z.array(z.string().trim().max(500)).max(20),
  suggestedNextAction: z.string().trim().max(1000),
});
export type TriageResult = z.infer<typeof triageResult>;
export const handoffDecision = z.strictObject({
  requestHandoff: z.boolean(),
  intent: z.string().trim().max(80),
  sentiment: z.enum(["neutral", "positive", "frustrated", "unknown"]),
  reason: z.string().trim().max(1000),
});

export const copilotInput = z.strictObject({
  kind: z.enum(["reply", "summary", "next_action", "knowledge", "resolution"]),
  regenerate: z.boolean().default(false),
});
export const copilotResult = z.strictObject({
  resolution: resumeFacts.nullable().default(null),
  reply: z.string().max(4000),
  summary: z.string().max(2000),
  sentiment: z.enum(["neutral", "positive", "frustrated", "unknown"]),
  nextAction: z.enum([
    "request_information",
    "resolve",
    "escalate_supervisor",
    "none",
  ]),
  rationale: z.string().max(1000),
  toolRecommendations: z
    .array(z.strictObject({ toolId: z.uuid(), reason: z.string().max(500) }))
    .max(5),
});
export type CopilotResult = z.infer<typeof copilotResult>;
export type CopilotView = {
  id: string;
  kind: z.infer<typeof copilotInput>["kind"];
  status: "running" | "completed" | "failed";
  result: CopilotResult | null;
  citations: {
    id: number;
    title: string;
    content: string;
    sourceId: string;
    knowledgeBaseId: string;
  }[];
  tools: { id: string; name: string }[];
  provenance: {
    modelId?: string | null;
    generatedAt?: string;
    errorCode?: string | null;
    httpStatus?: number;
    providerCode?: string;
    parameter?: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
  };
  created_at: string;
};
