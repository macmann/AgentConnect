# Agent Connex feature list

This inventory describes implemented product capabilities, not every requirement in the master specification. Provider integrations require configured accounts and permissions; local protocol tests do not certify external-provider acceptance.

## Workspaces and administration

- Registration, sessions, email verification, password recovery and invitations.
- Organizations, workspaces and capability-based roles.
- Encrypted workspace secrets with replacement and dependency-aware deletion.
- Audit events, protected role administration and tenant-scoped resources.
- Configurable data retention with previews and operational controls.

## Models and agent lifecycle

- Workspace-owned chat and embedding model registries, editable settings and connection diagnostics.
- OpenAI, Anthropic, Google and compatible-provider adapters; support depends on exact configured API identifiers and capabilities.
- Configure → Playground → Publish lifecycle with shared draft state and optimistic revision checks.
- Focused Overview, Prompt, Knowledge, Tools, Behavior, Experience and Advanced configuration sections.
- Structured instructions, advanced prompt controls, compiled previews and configuration readiness.
- Locale, conversation starters, welcome/fallback messages, sampling and response/history budgets.
- Streaming conversations, cancellation, citations and private run/context inspection.
- Immutable published versions and deployment environment labels.
- Rule-based lighter-model routing and controlled provider fallback; no fallback after partial output.

## Knowledge and RAG

- Text, document uploads, CSV Q&A import/export and controlled website crawling.
- PDF, DOCX, PPTX, XLSX, CSV, HTML, Markdown and text parsing.
- Embedding ingestion jobs, source status, retry/reingestion and source previews.
- Text/vector/hybrid retrieval, minimum relevance, retrieved passage limits and citations.
- Automatic, always and disabled knowledge-use policies with usage instructions.
- Optional follow-up query rewriting and model-based reranking.
- Table-aware retrieval and provenance; complex PDF tables still need review.
- Optional scanned-PDF OCR with required worker utilities.
- Knowledge review and approved releases for agents requiring reviewed content.
- Reviewed answer corrections and knowledge-gap draft creation.

## Enterprise knowledge connectors

| Source                | Credentials                                        | Source selection                                       | Sync behavior                                   |
| --------------------- | -------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| S3/S3-compatible      | Access-key JSON                                    | Bucket/prefix                                          | Fingerprint-based content updates               |
| Google Drive          | Guided OAuth or service account                    | Folder browser for OAuth; exact folder IDs             | Native document export and changed-file updates |
| OneDrive for Business | Guided Microsoft OAuth or application credentials  | Folder browser for delegated accounts; drive/item IDs  | Changed-file updates                            |
| SharePoint            | Guided Microsoft OAuth or application credentials  | Site, library and folder discovery                     | Site-bound changed-file updates                 |
| Microsoft Teams       | Guided Microsoft OAuth or application credentials  | Team/channel browser for delegated accounts; exact IDs | Message snapshots and changed-content updates   |
| Slack                 | Guided OAuth user authorization or user-token JSON | Accessible joined-channel browser; exact IDs           | Message snapshots and changed-content updates   |

All connectors have manual sync, optional schedules, status/history, cancellation, pause/resume and disconnect. Default incremental sync skips downloads/embeddings for unchanged managed content; a recovery full refresh reimports supported sources. Remote deletions are reconciled after successful complete scans. Metadata scans remain bounded full listings, not provider change/delta feeds. Source ACLs are not mirrored per reader: imported content inherits the target knowledge base’s access.

OAuth needs a one-time provider-app setup. Refreshable tokens renew server-side; revoked consent requires reconnection. Browse lists are bounded to the first 100 results, with manual IDs available. S3 does not use OAuth. Consumer/personal OneDrive is outside the current adapter.

## Tools

- Reviewed read-only HTTP, database and search tools.
- MCP tool discovery subject to supported transport and review controls.
- Automatic, required and disabled usage policies, tool instructions and call limits.
- Validated arguments, tenant/public-access restrictions and sanitized execution traces.
- No general-purpose mutating HTTP/database tool support is implied.

## Workflows

- Visual Input, Agent, Tool, Router, Condition, Parallel, Merge, Approval and Output nodes.
- Validated mappings, sequential handoffs, conditional branches and bounded parallel paths.
- Draft revisions, immutable publication and pinned published agents.
- Durable runs, persisted traces/checkpoints, approval pause/resume, cancellation and lease recovery.
- Starter templates: assisted answer, reviewed answer and parallel research.
- Reusable workflow copies and optional transient-failure retries for agent/tool nodes.
- Named results, structured field/table presentation and real step progress.
- Customer quick actions that trigger approved published workflows.
- Nested branching inside parallel paths, reusable subworkflows and collaborative editing remain future work.

## Customer channels and rich experiences

- Hosted customer chat and origin-restricted website widget.
- Deployment branding: chatbot name, logo, colors and greeting settings.
- Persistent browser conversations, resume/history and ongoing support cases.
- Validated tables, charts, forms and generated downloadable artifacts where enabled.
- Customer feedback/CSAT, confirmed collection forms and configured journeys.
- Browser voice controls subject to browser support; provider real-time voice remains an extension.
- Customer messaging adapters for Messenger, Viber, Telegram and Teams.
- Credential/webhook setup and provider-specific acceptance are still required.

## Human support and AI copilot

- Customer escalation, support case state and operator inbox.
- Operator presence, skills, availability, queues and routing.
- Conversation triage, assignment, reassignment and human replies.
- Private copilot suggestions with explicit operator actions.
- Approved continuation from human support back to AI.
- Resolution, supervision, operational timelines and support analytics.

## Quality, reporting and optimization

- Versioned evaluation datasets and durable offline agent evaluation.
- Optional model judging, retrieval/usage metrics and baseline comparisons.
- Administrator-controlled publication gates.
- Conversation review, answer corrections and knowledge-gap grouping by normalized text.
- Active conversation/customer metrics, enquiry categories, failed searches and daily trends.
- Operator presence utilization, agent usage/cost reports and Excel exports.
- Date-range reports subject to documented bounds and retained data.
- Tokenizer-aware budgeting, component previews, history summarization and per-user quotas.
- Provider-reported usage where available; estimates are not billing invoices.

## Delivery and operations

- Docker-based local infrastructure and versioned database migrations.
- CI checks, locked release images, manifests, smoke checks and rollout/rollback tooling.
- Private aggregate metrics, worker progress probes and monitoring examples.
- API keys, signed webhook delivery and protected outbound endpoint grants.
- Backup/recovery and hardening instructions with explicit remaining acceptance work.

## Deferred or dependent work

Salesforce, Zendesk and Zoho integrations are deferred. Advanced workflow extensions, provider delta feeds, real-time provider voice, additional enterprise identity/security capabilities and production HA/recovery/performance acceptance are not claimed here. The [implementation plan](implementation-plan.md) is the current roadmap.

## Branding and display

- Agent Connex branding with the supplied cyan/violet SVG logo.
- Consistent semantic colors across workspace screens, authentication, hosted chat and workflow canvases.
- Light/dark display modes, a top theme switcher, device preference defaults and saved browser preferences.
- Independent light/dark widget switching, with customer deployment branding preserved.

## Website crawling

- Built-in Cheerio extraction with homepage/menu link discovery, robots.txt compliance, same-origin path filters and bounded page/depth/response budgets.
- Optional Firecrawl v2 API integration for rendered sites, using encrypted workspace secrets, asynchronous polling, pagination, cancellation and sanitized failures.
- Crawl output flows through existing storage, embedding, table-aware parsing and RAG citation/approval/publication controls.
- Page counts, background ingestion status, chunk inspection, retrieval testing and explicit recrawl through Reingest.
