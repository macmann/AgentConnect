import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  numeric,
  boolean,
  customType,
  doublePrecision,
} from "drizzle-orm/pg-core";
const created = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: created(),
});
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: created(),
});
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  name: text("name").notNull(),
  createdAt: created(),
});
export const memberships = pgTable("memberships", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id),
  workspaceId: uuid("workspace_id"),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  role: text("role").notNull(),
});
export const sessions = pgTable("sessions", {
  idHash: text("id_hash").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: created(),
});
export const secrets = pgTable("secrets", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  ciphertext: jsonb("ciphertext").notNull(),
  createdBy: uuid("created_by").notNull(),
  createdAt: created(),
});
export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id"),
  workspaceId: uuid("workspace_id"),
  actorId: uuid("actor_id").notNull(),
  action: text("action").notNull(),
  entityId: uuid("entity_id"),
  metadata: jsonb("metadata").notNull(),
  ip: text("ip").notNull(),
  userAgent: text("user_agent").notNull(),
  createdAt: created(),
});
// Explicit migration is authoritative for composite foreign keys and indexes.

export const modelConfigurations = pgTable("model_configurations", {
  revision: integer("revision").notNull().default(1),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  modelId: text("model_id").notNull(),
  baseUrl: text("base_url").notNull(),
  secretId: uuid("secret_id"),
  contextWindow: integer("context_window").notNull(),
  maxOutputTokens: integer("max_output_tokens").notNull(),
  capabilities: jsonb("capabilities").notNull(),
  createdAt: created(),
});

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  publicDescription: text("public_description").notNull(),
  draftConfig: jsonb("draft_config").notNull(),
  revision: integer("revision").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdBy: uuid("created_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  createdAt: created(),
});

export const agentVersions = pgTable("agent_versions", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  version: integer("version").notNull(),
  name: text("name").notNull(),
  publicDescription: text("public_description").notNull(),
  config: jsonb("config").notNull(),
  modelSnapshot: jsonb("model_snapshot").notNull(),
  modelId: uuid("model_id").notNull(),
  publishedBy: uuid("published_by").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
});

export const deployments = pgTable("deployments", {
  widgetSettings: jsonb("widget_settings").notNull().default({}),
  environment: text("environment").notNull().default("production"),
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  versionId: uuid("version_id").notNull(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull(),
  createdAt: created(),
});

export const conversations = pgTable("conversations", {
  channel: text("channel").notNull().default("hosted"),
  widgetOrigin: text("widget_origin"),
  handoffStatus: text("handoff_status").notNull().default("none"),
  conversationMode: text("conversation_mode").notNull().default("ai"),
  activeSupportCaseId: uuid("active_support_case_id"),
  lastCustomerMessageAt: timestamp("last_customer_message_at", {
    withTimezone: true,
  }),
  lastAgentMessageAt: timestamp("last_agent_message_at", {
    withTimezone: true,
  }),
  lastHumanMessageAt: timestamp("last_human_message_at", {
    withTimezone: true,
  }),
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  versionId: uuid("version_id"),
  deploymentId: uuid("deployment_id"),
  userId: uuid("user_id"),
  guestTokenHash: text("guest_token_hash"),
  configSnapshot: jsonb("config_snapshot").notNull(),
  modelSnapshot: jsonb("model_snapshot").notNull(),
  createdAt: created(),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const agentRuns = pgTable("agent_runs", {
  inputUsdPerMillion: numeric("input_usd_per_million", {
    precision: 14,
    scale: 6,
  }),
  outputUsdPerMillion: numeric("output_usd_per_million", {
    precision: 14,
    scale: 6,
  }),
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  conversationId: uuid("conversation_id").notNull(),
  status: text("status").notNull(),
  traceId: text("trace_id").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  errorCode: text("error_code"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  retrieval: jsonb("retrieval").notNull(),
  retrievalMs: integer("retrieval_ms"),
});

export const messages = pgTable("messages", {
  uiBlocks: jsonb("ui_blocks").notNull().default([]),
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  conversationId: uuid("conversation_id").notNull(),
  runId: uuid("run_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  citations: jsonb("citations").notNull(),
  createdAt: created(),
});

const vector = customType<{ data: string }>({ dataType: () => "vector" });
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const embeddingModels = pgTable("embedding_models", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  modelId: text("model_id").notNull(),
  baseUrl: text("base_url").notNull(),
  secretId: uuid("secret_id"),
  dimensions: integer("dimensions").notNull(),
  createdAt: created(),
});

export const knowledgeBases = pgTable("knowledge_bases", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  embeddingModelId: uuid("embedding_model_id").notNull(),
  dimensions: integer("dimensions").notNull(),
  chunkSize: integer("chunk_size").notNull(),
  chunkOverlap: integer("chunk_overlap").notNull(),
  chunkStrategy: text("chunk_strategy").notNull(),
  publicAccess: boolean("public_access").notNull(),
  revision: integer("revision").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: created(),
});

export const knowledgeSources = pgTable("knowledge_sources", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  knowledgeBaseId: uuid("knowledge_base_id").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  filename: text("filename"),
  objectKey: text("object_key"),
  sourceUrl: text("source_url"),
  byteSize: integer("byte_size").notNull(),
  metadata: jsonb("metadata").notNull(),
  revision: integer("revision").notNull(),
  status: text("status").notNull(),
  errorCode: text("error_code"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  createdAt: created(),
});

export const knowledgeDocuments = pgTable("knowledge_documents", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  sourceId: uuid("source_id").notNull(),
  knowledgeBaseId: uuid("knowledge_base_id").notNull(),
  title: text("title").notNull(),
  sourceUrl: text("source_url"),
  metadata: jsonb("metadata").notNull(),
  pageCount: integer("page_count").notNull(),
  contentHash: text("content_hash").notNull(),
  revision: integer("revision").notNull(),
  createdAt: created(),
});

export const knowledgeChunks = pgTable("knowledge_chunks", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  documentId: uuid("document_id").notNull(),
  sourceId: uuid("source_id").notNull(),
  knowledgeBaseId: uuid("knowledge_base_id").notNull(),
  embeddingModelId: uuid("embedding_model_id").notNull(),
  dimensions: integer("dimensions").notNull(),
  ordinal: integer("ordinal").notNull(),
  content: text("content").notNull(),
  page: integer("page"),
  heading: text("heading"),
  metadata: jsonb("metadata").notNull(),
  embedding: vector("embedding").notNull(),
  searchVector: tsvector("search_vector").notNull(),
});

export const knowledgeJobs = pgTable("knowledge_jobs", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  sourceId: uuid("source_id").notNull(),
  knowledgeBaseId: uuid("knowledge_base_id").notNull(),
  sourceRevision: integer("source_revision").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull(),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  leaseToken: uuid("lease_token"),
  errorCode: text("error_code"),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: created(),
});
export const mcpConnectors = pgTable("mcp_connectors", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  secretId: uuid("secret_id"),
  enabled: boolean("enabled").notNull().default(true),
  capabilities: jsonb("capabilities").notNull(),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }),
  revision: integer("revision").notNull().default(1),
  createdAt: created(),
});
export const tools = pgTable("tools", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  kind: text("kind").notNull(),
  config: jsonb("config").notNull(),
  inputSchema: jsonb("input_schema").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  publicAccess: boolean("public_access").notNull().default(false),
  timeoutMs: integer("timeout_ms").notNull(),
  revision: integer("revision").notNull().default(1),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: created(),
});
export const toolExecutions = pgTable("tool_executions", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  toolId: uuid("tool_id").notNull(),
  runId: uuid("run_id"),
  workflowRunId: uuid("workflow_run_id"),
  workflowNodeId: text("workflow_node_id"),
  userId: uuid("user_id"),
  toolName: text("tool_name").notNull(),
  toolRevision: integer("tool_revision").notNull(),
  arguments: jsonb("arguments").notNull(),
  result: jsonb("result"),
  status: text("status").notNull(),
  errorCode: text("error_code"),
  durationMs: integer("duration_ms"),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const workflows = pgTable("workflows", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  draftGraph: jsonb("draft_graph").notNull(),
  revision: integer("revision").notNull().default(1),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdBy: uuid("created_by").notNull(),
  createdAt: created(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const workflowVersions = pgTable("workflow_versions", {
  id: uuid("id").primaryKey(),
  workflowId: uuid("workflow_id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  version: integer("version").notNull(),
  name: text("name").notNull(),
  graph: jsonb("graph").notNull(),
  publishedBy: uuid("published_by").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const workflowRuns = pgTable("workflow_runs", {
  id: uuid("id").primaryKey(),
  workflowId: uuid("workflow_id").notNull(),
  versionId: uuid("version_id"),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  userId: uuid("user_id").notNull(),
  graphSnapshot: jsonb("graph_snapshot").notNull(),
  input: text("input").notNull(),
  status: text("status").notNull(),
  output: jsonb("output"),
  errorCode: text("error_code"),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  leaseOwner: uuid("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  createdAt: created(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
export const workflowNodeRuns = pgTable("workflow_node_runs", {
  runId: uuid("run_id").notNull(),
  nodeId: text("node_id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  label: text("label").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  input: jsonb("input"),
  output: jsonb("output"),
  errorCode: text("error_code"),
  durationMs: integer("duration_ms"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  citations: jsonb("citations").notNull().default([]),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
export const workflowApprovals = pgTable("workflow_approvals", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull(),
  nodeId: text("node_id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  prompt: text("prompt").notNull(),
  input: jsonb("input").notNull(),
  decision: text("decision").notNull(),
  comment: text("comment").notNull().default(""),
  editedInput: jsonb("edited_input"),
  decidedBy: uuid("decided_by"),
  createdAt: created(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

export const conversationReviews = pgTable("conversation_reviews", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  messageId: uuid("message_id").notNull(),
  reviewerId: uuid("reviewer_id").notNull(),
  rating: text("rating"),
  label: text("label"),
  comment: text("comment").notNull(),
  correctedResponse: text("corrected_response"),
  reason: text("reason").notNull(),
  createdAt: created(),
});
export const modelPrices = pgTable("model_prices", {
  modelId: uuid("model_id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  inputUsdPerMillion: numeric("input_usd_per_million", {
    precision: 14,
    scale: 6,
  }).notNull(),
  outputUsdPerMillion: numeric("output_usd_per_million", {
    precision: 14,
    scale: 6,
  }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  updatedBy: uuid("updated_by").notNull(),
});
export const workspaceApiKeys = pgTable("workspace_api_keys", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  label: text("label").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  prefix: text("prefix").notNull(),
  createdBy: uuid("created_by").notNull(),
  scope: text("scope").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: created(),
});
export const workspaceWebhooks = pgTable("workspace_webhooks", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  signingSecret: jsonb("signing_secret").notNull(),
  enabled: boolean("enabled").notNull(),
  createdBy: uuid("created_by").notNull(),
  createdAt: created(),
});
export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey(),
  webhookId: uuid("webhook_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  errorCode: text("error_code"),
  httpStatus: integer("http_status"),
  createdAt: created(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
});

export const generatedArtifacts = pgTable("generated_artifacts", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  messageId: uuid("message_id").notNull(),
  name: text("name").notNull(),
  contentType: text("content_type").notNull(),
  storageKey: text("storage_key").notNull().unique(),
  byteSize: integer("byte_size").notNull(),
  createdAt: created(),
});
export const collectedSubmissions = pgTable("collected_submissions", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  messageId: uuid("message_id").notNull(),
  conversationId: uuid("conversation_id").notNull(),
  blockId: text("block_id").notNull(),
  values: jsonb("values").notNull(),
  submittedBy: uuid("submitted_by"),
  createdAt: created(),
});

export const handoffEvents = pgTable("handoff_events", {
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  kind: text("kind").notNull(),
  content: text("content").notNull(),
  actorId: uuid("actor_id"),
  createdAt: created(),
});

export const evaluationDatasets = pgTable("evaluation_datasets", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  examples: jsonb("examples").notNull(),
  revision: integer("revision").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: created(),
});
export const evaluationRuns = pgTable("evaluation_runs", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  agentId: uuid("agent_id").notNull(),
  datasetId: uuid("dataset_id").notNull(),
  requestedBy: uuid("requested_by").notNull(),
  agentRevision: integer("agent_revision").notNull(),
  datasetRevision: integer("dataset_revision").notNull(),
  configSnapshot: jsonb("config_snapshot").notNull(),
  modelSnapshot: jsonb("model_snapshot").notNull(),
  examplesSnapshot: jsonb("examples_snapshot").notNull(),
  evaluator: jsonb("evaluator").notNull(),
  judgeSnapshot: jsonb("judge_snapshot"),
  pricesSnapshot: jsonb("prices_snapshot").notNull(),
  fingerprint: text("fingerprint").notNull(),
  baselineRunId: uuid("baseline_run_id"),
  status: text("status").notNull(),
  summary: jsonb("summary"),
  errorCode: text("error_code"),
  attempts: integer("attempts").notNull(),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  createdAt: created(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
export const evaluationResults = pgTable("evaluation_results", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  exampleId: uuid("example_id").notNull(),
  status: text("status").notNull(),
  output: text("output").notNull(),
  score: doublePrecision("score"),
  passed: boolean("passed").notNull(),
  metrics: jsonb("metrics").notNull(),
  errorCode: text("error_code"),
  createdAt: created(),
});
export const agentQualityGates = pgTable("agent_quality_gates", {
  agentId: uuid("agent_id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  settings: jsonb("settings").notNull(),
  updatedBy: uuid("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const enterpriseConnectors = pgTable("enterprise_connectors", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  knowledgeBaseId: uuid("knowledge_base_id").notNull(),
  secretId: uuid("secret_id"),
  selection: jsonb("selection").notNull(),
  enabled: boolean("enabled").notNull(),
  revision: integer("revision").notNull(),
  scheduleMinutes: integer("schedule_minutes"),
  nextSyncAt: timestamp("next_sync_at", { withTimezone: true }),
  createdBy: uuid("created_by").notNull(),
  updatedBy: uuid("updated_by").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: created(),
});
export const connectorSyncs = pgTable("connector_syncs", {
  id: uuid("id").primaryKey(),
  connectorId: uuid("connector_id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  requestedBy: uuid("requested_by").notNull(),
  connectorRevision: integer("connector_revision").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull(),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  counts: jsonb("counts").notNull(),
  errorCode: text("error_code"),
  createdAt: created(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
export const connectorItems = pgTable("connector_items", {
  connectorId: uuid("connector_id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  externalKey: text("external_key").notNull(),
  sourceId: uuid("source_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  lastSeenSync: uuid("last_seen_sync").notNull(),
});

export const workspaceRetention = pgTable("workspace_retention", {
  workspaceId: uuid("workspace_id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  revision: integer("revision").notNull().default(1),
  conversationDays: integer("conversation_days"),
  runDays: integer("run_days"),
  artifactDays: integer("artifact_days"),
  connectorDays: integer("connector_days"),
  updatedBy: uuid("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
});
export const retentionRuns = pgTable("retention_runs", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  policyRevision: integer("policy_revision").notNull(),
  requestedBy: uuid("requested_by").notNull(),
  triggerKind: text("trigger_kind").notNull(),
  status: text("status").notNull(),
  counts: jsonb("counts").notNull().default({}),
  errorCode: text("error_code"),
  createdAt: created(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
export const retentionObjectDeletions = pgTable("retention_object_deletions", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  organizationId: uuid("organization_id").notNull(),
  storageKey: text("storage_key").notNull(),
  attempts: integer("attempts").notNull().default(0),
  status: text("status").notNull().default("pending"),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  errorCode: text("error_code"),
  createdAt: created(),
});

// Constraints and tenant-consistent composite foreign keys are defined in migration 0017.
export const supportQueues = pgTable("support_queues", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  enabled: boolean("enabled").notNull().default(true),
  priority: text("priority").notNull().default("normal"),
  routingStrategy: text("routing_strategy").notNull().default("manual"),
  assignmentMode: text("assignment_mode").notNull().default("manual"),
  isDefault: boolean("is_default").notNull().default(false),
  routingConfig: jsonb("routing_config").notNull().default({}),
  createdAt: created(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const supportCases = pgTable("support_cases", {
  routingNextAttemptAt: timestamp("routing_next_attempt_at", {
    withTimezone: true,
  })
    .notNull()
    .defaultNow(),
  routingStrategy: text("routing_strategy"),
  routingScore: doublePrecision("routing_score"),
  routingExplanation: jsonb("routing_explanation").notNull().default({}),
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  conversationId: uuid("conversation_id").notNull(),
  status: text("status").notNull(),
  reasonCode: text("reason_code").notNull().default("manual"),
  reasonText: text("reason_text").notNull().default(""),
  triggerType: text("trigger_type").notNull().default("manual"),
  priority: text("priority").notNull().default("normal"),
  queueId: uuid("queue_id"),
  assignedOperatorId: uuid("assigned_operator_id"),
  idempotencyKey: uuid("idempotency_key"),
  resolutionCode: text("resolution_code"),
  resolutionSummary: text("resolution_summary"),
  resumeContext: jsonb("resume_context").notNull().default({}),
  requestedAt: timestamp("requested_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  queuedAt: timestamp("queued_at", { withTimezone: true }),
  assignedAt: timestamp("assigned_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: created(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const supportEvents = pgTable("support_events", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  conversationId: uuid("conversation_id").notNull(),
  supportCaseId: uuid("support_case_id").notNull(),
  type: text("type").notNull(),
  actorType: text("actor_type").notNull(),
  actorId: uuid("actor_id"),
  payload: jsonb("payload").notNull().default({}),
  createdAt: created(),
});

export const supportNotes = pgTable("support_notes", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  conversationId: uuid("conversation_id").notNull(),
  supportCaseId: uuid("support_case_id").notNull(),
  authorId: uuid("author_id").notNull(),
  content: text("content").notNull(),
  createdAt: created(),
});

export const operatorProfiles = pgTable("operator_profiles", {
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  userId: uuid("user_id").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  manualAvailability: boolean("manual_availability").notNull().default(true),
  capacityLimit: integer("capacity_limit").notNull().default(5),
  priorityWeight: integer("priority_weight").notNull().default(1),
  timezone: text("timezone").notNull().default("UTC"),
  languages: jsonb("languages").notNull().default([]),
  presenceStatus: text("presence_status").notNull().default("offline"),
  presenceExpiresAt: timestamp("presence_expires_at", { withTimezone: true }),
  lastAssignedAt: timestamp("last_assigned_at", { withTimezone: true }),
  createdAt: created(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const supportSkills = pgTable("support_skills", {
  id: uuid("id").primaryKey(),
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: created(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const operatorSkills = pgTable("operator_skills", {
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  userId: uuid("user_id").notNull(),
  skillId: uuid("skill_id").notNull(),
  proficiency: integer("proficiency").notNull(),
});
export const supportQueueMembers = pgTable("support_queue_members", {
  organizationId: uuid("organization_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  queueId: uuid("queue_id").notNull(),
  userId: uuid("user_id").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  priorityWeight: integer("priority_weight").notNull().default(1),
  lastAssignedAt: timestamp("last_assigned_at", { withTimezone: true }),
  createdAt: created(),
});
