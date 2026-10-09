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
