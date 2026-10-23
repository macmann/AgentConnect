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
- Multi-file knowledge uploads: up to 100 files (10 MB each), 1–3 concurrent transfers, progress, pause/cancel/retry and duplicate-safe retry keys; ingestion runs in the background.
- PDF, DOCX, PPTX, XLSX, CSV, HTML, Markdown and text parsing.
- Embedding ingestion jobs, source status, retry/reingestion and source previews.
- Text/vector/hybrid retrieval, minimum relevance, retrieved passage limits and citations.
- Automatic, always and never-retrieve knowledge-use policies with usage instructions.
- Strict structured knowledge decisions, portable JSON parsing, one repair attempt and logged raw-query retrieval fallback.
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

- Persistent per-user Playground conversations across navigation and refresh, reset with New chat.
- One customer transcript and composer across AI and human support, named specialist join/leave notices, and explicit AI takeover events.
- Immediate handoff for explicit chat requests, respecting support policy and business hours; inferred escalation offers retain customer confirmation.
- Automatic private handoff briefs, including missing summary generation when claiming manual cases.

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

## Advanced knowledge processing

- Per-base opt-in advanced document processing, off by default; standard processing makes no LLM assistance calls.
- Separate tables, grouped headers and original numeric values, with HTML spans, Excel merged cells/sparse row separators, Word grid spans and heuristic PDF coordinate extraction.
- Token-aware advanced chunks that retain table rows; bounded parent context is a separate optional retrieval setting.
- Optional workspace-model assistance restricted to validated boundaries/header counts, with call/context/time budgets and deterministic fallback warnings.
- Source extraction preview with table samples, warnings and reported processing-model usage; manual Reingest applies changed settings to existing sources.
- Durable per-job settings snapshots and immutable parent-context metadata in approved knowledge releases.
- Financial extraction requires review; spreadsheet display formats/formula evaluation and deterministic financial calculations remain outside this feature.

## Answer feedback and verified improvement

- Per-answer customer reports in hosted chat and the widget, with optional explicit human-support consent.
- Scoped, paginated reviewer queue, assignment, optimistic revisions and private event history.
- Reported/reviewing/fix-ready/verified/closed progression, reasoned dismissal and customer reopening.
- Reviewed corrections reuse conversation reviews, approval-required knowledge drafts and ingestion.
- Automatic Quality regression cases and private candidate-release evaluations of affected drafts and deployed versions.
- Server-enforced correction coverage, full passing checks and current dependency fingerprints before knowledge publication.
- Customer-visible report status excludes internal notes and proposed corrections.
- Markdown-rendered AI replies in Playground/hosted chat, including tables/code, safe links and skipped raw HTML.

## Langfuse observability

- Optional official OpenTelemetry integration for API and worker with existing generic OTLP export preserved.
- Linked agent, knowledge planning/retrieval/embedding/vector/text/reranking, tool and streamed model observations.
- Workflow node hierarchy, parallel branches, retries and stable traces across approval resumes.
- Reported token usage, first-token timing, metadata filtering and opt-in bounded content capture with credential masking.
- Asynchronous export and graceful shutdown flushing; application histories remain the durable record. See [setup](langfuse.md).

## Approved rerankers and focused diagnostics

- Agent-selectable workspace rerankers: registered LLMs or native Cohere `/v2/rerank`.
- Configurable LLM ranking output budget, metered auxiliary usage and safe retrieval-order fallback.
- Vector, lexical and RRF ranking metadata in Langfuse; optional bounded content capture.
- Playground Enter-to-send, Shift+Enter multiline input and IME-safe composition.
- Closed Debug / Advanced panels, field-help disclosures and compact Publish/Advanced views.

## Agent response language

- Match the latest user's language or choose a fixed response language in Agent Overview.
- Automatic language switching, explicit language requests and configured fallback for ambiguous messages.
- Shared policy across Playground, deployments, workflow agents and rich-response prose; versioned with agent configuration.
- Localized approved-knowledge no-answer replies with evidence safeguards intact.

## Website crawler resilience

- Bounded same-origin redirects with DNS, robots and path checks at each hop.
- Landing-page provenance and correct relative-link discovery.
- Safe terminal rejection diagnostics and actionable host/URL validation errors.

## Multilingual AI document extraction

- Optional multilingual vision extraction for scanned PDFs and PNG/JPEG/WebP uploads, using workspace OpenAI-compatible, OpenAI, Anthropic or Gemini models.
- Scanned/table/all-page modes, original-script preservation, structured multi-header tables, uncertainty warnings, page/output budgets, source-scoped extraction caching and reviewable extraction previews.

## Document quality benchmarks and correction workspace

- Guided real-source benchmark cases, trusted reference transcription, exact table-cell expectations and cited-page coverage using existing Quality Lab datasets and runs.
- Immutable extraction snapshots, dependency/source-drift checks, tag-level results, baseline comparisons and JSON result export; existing latency/cost and answer checks retained.
- Side-by-side authenticated original-page images and editable AI text/tables, atomic audited corrections, optimistic revision protection and reindexing without another vision call.
- Unchanged-source corrections persist through Reingest; an explicit automatic-extraction reset preserves history and existing reviewed-release controls.

### Extraction observability and financial calculations

- Durable extraction usage by source revision/job attempt: vision pages, boundary assistance, cache hits, correction reuse, safe failures, token usage, duration, immutable model-price snapshots and explicit unknown costs.
- Source-level usage viewer, available for failed ingestion, and metadata-only nested Langfuse ingestion/extraction traces.
- Built-in financial calculator tool: exact decimal sums, differences, ratios, percentages and growth; explicit scales, units, precision and rounding; multilingual digits and accounting negatives.
- Evidence-required operands validated against authorized current-query passages, with formula and source/page/chunk provenance; supported in regular and grounded RAG agents and workflow agent nodes. Optional ungrounded mode supports explicit supplied workflow/test inputs without claiming source verification.

### Multilingual validation and reviewed semantic topics

- Guided language-variant benchmark authoring with shared intents, BCP 47 language annotations, expected retrieved/cited sources, reviewed phrases and optional writing-system checks.
- Language-aware Unicode phrase checks, explicit LLM-judge language compliance, reports by language pair/intent, baseline deltas and existing JSON exports. Unknown language assessments stay unmeasured.
- Semantic gap previews with per-topic members and pairwise similarity, selective application, expiry, optimistic snapshot checks, tenant/creator access controls, idempotent concurrent application and audited reviewer decisions.
- Reviewer merges/splits remain protected, full questions reach only the selected configured embedding provider, and preview application makes no further embedding call. No automatic knowledge publication.

### Connector feeds and reusable workflow components

- Google Drive Changes and Microsoft OneDrive/SharePoint delta checkpoints skip unchanged inventories. Cursors advance only after successful sync, recover from expiry, reset on connector revision/full refresh, and are never exposed in API history. Changed scopes still use bounded complete reconciliation for deletion and folder-move safety. S3/Teams/Slack retain scans.
- Workspace workflow component library: save selected processing nodes with a single entry/exit, immutable versions, select an older version, insert independent editable copies, and archive unused entries. Node IDs and internal inputs are remapped. Normal workflow validation, permissions, traces and published snapshots remain authoritative.

## Platform API and MCP

- Published agent JSON invocation and raw knowledge search with scoped, expiring, revocable keys.
- Stateless MCP Streamable HTTP with `agent_invoke` and `knowledge_search` tools.
- Key-bound durable conversations; published version snapshots and current issuer permission checks.
- Optional execution details: recorded tool inputs/outputs, raw retrieval candidates, vector/lexical/RRF stages, reranking scores and final context chunks.
- Existing streaming agent API remains available for legacy keys. See [integration guide](platform-api.md).

- **Approved Q&A preference:** agent-level balanced or approved-Q&A-first retrieval, configurable semantic threshold, published snapshot provenance, supporting documents and document fallback; preserved through reranking and shared agent API/MCP/workflow execution.
- **RAG metadata tagging and filtering:** editable tags and flat custom fields for every knowledge source, metadata revision conflicts, connector refresh preservation, frozen release metadata, SQL prefilters in vector/hybrid retrieval, agent/playground controls and REST/MCP search parity.
- **Bulk metadata and optional AI tagging:** shared metadata on single/bulk uploads, retry-stable options, previews and atomic 100-source patches, optional workspace-model tagging jobs, and per-source reviewed application with stale-edit protection.
