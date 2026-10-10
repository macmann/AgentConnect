# Foundation data model

Migration: packages/db/migrations/0001_foundation.sql. See architecture.md for ERD.

users: UUID identity, unique normalized email, name, scrypt hash, verification/creation timestamps.
sessions: token hash, user foreign key, expiration/creation timestamps.
auth_tokens: hash, user, verify/reset purpose and expiration.
organizations: UUID identity, name, creation timestamp.
workspaces: UUID identity, organization ownership, name, creation timestamp.
memberships: organization, optional workspace, user, constrained role, unique tenant/scope/user index.
invitations: organization, optional workspace, normalized email, role, hash, expiry and acceptance.
secrets: organization and workspace ownership, name, envelope ciphertext JSONB, creator/time; unique workspace/name.
audit_events: tenant ownership, actor, action, entity, safe metadata, IP/user-agent, timestamp; tenant/time index.
mail_outbox: recipient, subject, encrypted body, created/sent timestamps. Email payload is erased after delivery.

Schema versions are stored separately in schema_migrations. No seed users or mock product records are inserted.

## Phase 1

Migration `0002_single_agent.sql` adds the following tables. Both migrations execute transactionally under the migration advisory lock. Explicit SQL migrations are authoritative for composite constraints, indexes and immutability triggers; Drizzle definitions describe the columns.

- model_configurations: workspace provider/model identity, approved endpoint, encrypted-secret reference, declared context/output limits and supported sampling parameters.
- agents: tenant-owned draft JSON, names/descriptions, optimistic revision and archive timestamp.
- agent_versions: immutable configuration and model snapshots, publisher and numbered version. A database trigger rejects updates.
- deployments: enabled public deployment pinned to a published version belonging to the same agent and tenant.
- conversations: frozen configuration/model snapshots, authenticated creator or hashed anonymous continuation token, optional pinned deployment/version.
- agent_runs: conversation, status, trace ID, nullable reported token counts, sanitized error code, start/finish times. A partial unique index permits one running response per conversation.
- messages: user/assistant content, conversation/run identity and creation time. Partial responses survive cancellation and failures.

Composite foreign keys enforce tenant identity for secrets, models, agents, versions, deployments and conversations. Conversation lists use a timestamp plus UUID cursor; message history has a conversation/time index. Publication snapshots credential references rather than plaintext values, allowing credential rotation without changing a deployed prompt.

## Phase 2

Migration `0003_knowledge.sql` adds embedding_models, knowledge_bases, knowledge_sources, knowledge_documents, knowledge_chunks and knowledge_jobs. Models track dimensions and tenant credential references; base/model/dimension composite foreign keys prohibit mixed spaces. Source revisions protect worker output from superseded edits. Document metadata preserves provenance and private raw-object references.

Chunks have pgvector values, dimension checks and generated full-text vectors. Each base creates a partial, dimension-specific HNSW cosine index; a shared GIN index supports text retrieval. Jobs store claim leases, attempt counts, sanitized errors and persisted retry times. Source tombstones retain delayed object-purge state. Messages now persist referenced citations; agent runs persist retrieval provenance and latency.

Agent configuration schema defaults RAG to no attached knowledge, preserving Phase 1 drafts and published versions. Knowledge content remains live across deployments; archived/non-public bases are rejected at retrieval rather than silently replaced.

Phase 3 adds `mcp_connectors` (secret-backed approved endpoints and cached capabilities), `tools` (configuration/schema, enable/public policy, optimistic revision) and `tool_executions` (sanitized test/run traces and outcomes). Tool/run foreign keys include workspace and organization. Agent JSON snapshots include tool attachment IDs and call budgets; current tool/connector settings and revocations are checked at execution.

Phase 4 migration 0005 adds workflows, immutable workflow_versions, snapshot-bearing workflow_runs, workflow_node_runs and workflow_approvals. Composite tenant foreign keys link all records; tool_executions gains workflow run/node references. The official LangGraph PostgreSQL saver owns checkpoint tables in workflow_checkpoints. Those tables store run-thread state and require the same restricted database access and retention policy as run inputs and outputs.

Migration 0006 adds revision and archived_at to model_configurations. Registry removal archives the row, preserving composite foreign keys from published agent versions. Current agent drafts must switch models or be archived before registry removal. Published model snapshots remain immutable when registry settings are edited.

## Phase 5 operations

Migration 0007 adds tenant-bound `conversation_reviews`, `model_prices`, `workspace_api_keys`, `workspace_webhooks` and `webhook_deliveries`. Review records reference an assistant message and reviewer without changing historical content. API keys store hashes and a single agent/workspace scope; webhook signing secrets remain encrypted. Agent runs retain input/output USD rates at completion so future price edits do not change estimates. Deployments add environment labels; promotions affect future conversation snapshots. The webhook outbox transaction is shared with terminal agent-run persistence, and delivery claims use leases and bounded retries.


## Support foundation

Migration 0017 adds support_cases, support_queues and support_events, with tenant-consistent composite foreign keys, one-open-case uniqueness and a conversation active-case pointer. Events reject updates but cascade with approved conversation retention. See [human support](human-support.md).
