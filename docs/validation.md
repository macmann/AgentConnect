# Validation

Validated on 2026-10-09 in the supplied cloud environment using Node 24.19.0 and pnpm 11.19.0.

- `pnpm lint`: passed.
- `pnpm typecheck`: all five packages passed.
- `pnpm test`: 10 tests passed, 0 failed/skipped. Real PostgreSQL, Redis, S3-compatible storage and Temporal were exercised. Checks include origin enforcement, tenant isolation, email-bound one-time invitations, least privilege, encrypted secret persistence, audit redaction and password-reset session revocation.
- `pnpm build`: Next.js production output plus compiled API and mail-worker artifacts passed.
- `pnpm test:e2e`: one browser scenario passed on development processes and again against compiled API/worker plus the production web build. It covers registration, local SMTP verification, organization/workspace creation, invitation delivery, secrets, audit history, desktop and mobile layout. Test records are removed afterward.
- `scripts/cloud-install.sh`: passed twice; frozen installation, existing .env preservation, infrastructure startup, repeatable migration, bucket initialization and build verified.
- `/health/ready`: ready; PostgreSQL, Redis, storage and Temporal.
- Installed pgvector extension: 0.8.7.
- `/openapi.json`: 19 documented paths with request schemas.

The repository initially had no files or commits and the remote had no refs. An empty initial `main` commit establishes the review base; the Phase 0–2 implementation is submitted on `feat/agentconnect-foundation-rag`. Generated output, local credentials and browser reports are ignored.

Reusable install_script and start_skill were saved to the environment configuration draft. Publication and validation in a newly restored task have not occurred. Review/save the environment settings and publish through the product.

These earlier checks establish Phase 0 development capabilities. The Phase 1 results below supersede the initial feature status. External SMTP providers, RAG, workflow execution and production security/HA deployment remain unverified or unimplemented.

## Phase 1 single-agent MVP

Validated on 2026-10-09 in the same local cloud environment.

- `pnpm test`: 27 API/provider tests passed, no failures or skips. Coverage includes scoped model/secret ownership, agent permissions and tenancy, optimistic drafts, immutable publication, pinned deployment prompts, opaque anonymous authorization, persisted messages/usage/errors, rollback/archive/disable, interrupted-run recovery, adapter protocols, fragmented SSE parsing, sanitized upstream failures, endpoint restrictions and real HTTP no-redirect transport.
- `pnpm typecheck`: all seven application/library packages passed. Run type checking after builds: Next build replaces generated type files and cannot share those files safely with concurrent `tsc`.
- `pnpm lint`: passed.
- `pnpm build`: Next production build plus compiled API and worker passed. The provider transport dependency is external to the ESM API bundle and installed as an explicit runtime dependency; compiled startup was exercised.
- Browser agent lifecycle passed with the development UI/API and an explicit local HTTP protocol fixture. It covers registry, prompts, persisted streaming, cancellation, overlapping-request rejection, publishing, hosted anonymous continuation and mobile layout.
- `pnpm test:e2e`: both foundation and agent scenarios passed against the compiled API/worker and production Next web build. Three successful agent requests and one cancelled request were verified in PostgreSQL. Test tenants were removed afterward.
- Frozen lockfile install passed after adding provider/runtime packages. The complete `scripts/cloud-install.sh` also passed again: existing .env preserved, infrastructure healthy, both migrations repeatable, bucket initialized and all build tasks passed.
- Infrastructure readiness reports PostgreSQL, Redis, storage and Temporal ready.

No provider credentials are configured. OpenAI, Anthropic and Gemini protocols were fixture-tested; no live hosted model, account entitlement, model-specific parameter compatibility or billing behavior was validated. Live acceptance requires a workspace secret and model registration, plus permitted provider egress. Production code has no mock response mode.

Updated startup instructions and provider egress for api.openai.com, api.anthropic.com and generativelanguage.googleapis.com were saved to the cloud environment configuration draft. Saving does not apply or publish them: review and save in environment settings, then publish. Fresh-task restoration remains unverified. The temporary browser fixture private-host exception is removed from normal startup.

## Phase 2 knowledge / RAG

Validated on 2026-10-09 in the supplied cloud environment.

- `pnpm test`: 46 tests passed, none failed/skipped. New checks cover embedding/credential ownership, knowledge capabilities, HNSW creation, durable ingestion, real S3 storage, dimension mismatch rejection, backoff and lease recovery, source revision replacement, no-source generation prevention, citation persistence, public-knowledge opt-in/revocation, Q&A CSV validation, logical deletion and delayed object purge.
- Actual local HTTP website ingestion covers bounded same-origin crawling, canonical provenance, robots enforcement and redirect rejection. Separate parser tests extract real PDF, DOCX, PPTX, XLSX, CSV, TXT, Markdown, HTML and JSON content; unsafe XML, oversized archive expansion and unsupported/empty files fail explicitly.
- `pnpm lint` and `pnpm typecheck`: passed; eight application/library packages are checked.
- `pnpm build`: production Next output and compiled API/worker passed. Parser/provider dependencies resolve from installed runtime packages; the frozen lockfile is valid.
- `pnpm test:e2e`: all three scenarios passed against compiled API/worker and production web output. Knowledge acceptance covers embedding registration, Markdown upload, background ingestion, retrieval inspection, agent attachment, cited playground/anonymous hosted responses, mobile layout and real PDF extraction with page provenance by the compiled worker. Explicit local HTTP protocol fixtures provide embeddings/generation; production has no fixture mode. New knowledge fixtures clean up their own SQL, HNSW indexes and S3 artifacts.
- The full cloud installer passed again: preserved .env, healthy infrastructure, all three migrations repeatable, storage initialized, frozen dependencies installed and builds completed.

Cloud runtime inspection found no configured provider credentials. Its observed network policy state was unknown, and the startup policy snapshot restricts user destinations. Provider-domain egress and updated Phase 2 startup instructions are saved in the environment configuration draft; they have not been applied/published. Review/save settings and publish to activate them. Fresh-task restoration remains unverified.

Live hosted embeddings, live grounded generation, billing, large-dataset recall/latency and enterprise security/load validation remain pending. The current citation check validates references to retrieved passages, not the factual entailment of every claim. See rag.md for concrete limits and future parser/retrieval/operations extensions. The temporary private-host exceptions are removed from normal startup.

## Phase 3 read-only tooling / MCP

Validated on 2026-10-09 in the supplied cloud environment.

- `pnpm test`: 55 tests passed, no failures/skips. Tool tests cover administrator/builder/viewer boundaries, tenant credential ownership, approved endpoints, strict argument validation, real HTTP redirect/size/deadline failures, credential redaction, optimistic revisions, tool/connector revocation, bounded agent planning, result grounding and combined reported model usage. Earlier foundation, agent and RAG tests also passed.
- MCP protocol fixtures exercise the official SDK over real HTTP: initialize, bounded tools/resources/prompts discovery, declared read-only registration, schema/hint drift refusal, execution and bounded session termination. The Brave Search adapter is protocol-tested through an explicit injected transport; no live search request was made.
- A real PostgreSQL test creates a dedicated non-superuser login with SELECT on its fixture table, then verifies bounded parameterized reads and injection treated as a filter value. Its role/table and tenant records are removed afterward.
- `pnpm test:e2e`: all four scenarios passed together against compiled API/worker and production Next output. The new tooling flow registers/tests a tool, attaches it to an agent, displays returned results in playground and anonymous hosted chat, checks mobile overflow and restores saved traces in conversation history. Explicit HTTP model/tool fixtures provide responses; production has no fixture mode.
- Earlier repeated browser runs hit the real shared-IP rate limiter after preceding test traffic. The tooling browser hook now paces itself using the API's rate-limit headers; the limit itself is unchanged. The final compiled browser instance used an initially empty, separate Redis logical database for test-state isolation.
- Lint, eight-package type checking and production builds passed. The final MCP session-cleanup change passed the full 55-test suite and build; the complete browser run preceded that isolated transport-cleanup change.
- Frozen-lockfile installation passed after adding the official MCP SDK/AJV runtime dependencies. The fourth migration was applied and repeat invocation passed. API readiness reports PostgreSQL, Redis, storage and Temporal ready. The local uncommitted migration's run foreign key was synchronized to its final composite tenant definition.

No live model tool selection, Brave account request, third-party MCP server, external production PostgreSQL connection or production load/security acceptance was validated. Credentials remain absent and cloud provider/tool egress is not published. tools.md documents the supported read-only slice and the unimplemented mutation/approval, additional database, OAuth, MCP transport and native function-call extensions. Updated startup instructions were saved as an environment configuration draft; publication/fresh-task restoration remain unverified. Temporary fixture destination grants are removed from normal startup.

Phase 3 implementation is submitted for review on `feat/safe-tools-mcp`, based on the merged Phase 0–2 main branch.

## Phase 4 visual workflows

Validated on 2026-10-09 after pulling merged Phase 3 main (`2712343`), on `feat/visual-workflows`.

- Frozen-lockfile installation and repeated migration passed; existing local credentials were preserved.
- `pnpm lint` and `pnpm typecheck` passed across all eight packages.
- `pnpm test`: 66 tests passed, no failures, skips or cancellations. Eleven workflow checks cover graph structure, tenant/role boundaries, optimistic revisions, immutable versions, pinned agent handoffs, selected conditional branches, concurrent joins with unequal paths, persisted approval and saver restart/resume, tool linkage, lease recovery, sanitized failures, and queued/running cancellation. The running cancellation check verifies that the actual provider signal is aborted and terminal run/node status is persisted.
- `pnpm build`: all eight targets passed, including the Next.js production build and compiled API/worker. A worker/server import coupling found during startup was corrected by extracting shared model helpers; the compiled workflow worker starts successfully.
- `pnpm test:e2e`: all five browser scenarios passed against compiled API/worker and the production web build. The new scenario creates a visual review workflow, saves/validates/publishes it, executes a pinned version, edits approval input, resumes the second agent, and verifies the final output and visible canvas nodes. Desktop/mobile screenshots were inspected; mobile overflow checks passed.
- Workflow tests use actual PostgreSQL checkpoints and explicit local HTTP/provider fixtures. Hosted-provider acceptance remains pending; these results do not certify production operations or the full specification's richer node catalog.
- Phase 4 startup guidance was saved to the cloud environment draft. Publication and a new-task restoration check have not occurred.

See workflows.md for supported graph shapes, execution bounds, at-least-once recovery, and remaining extensions.

## Development email verification setting

The API exposes `verificationRequired` separately from the actual verified-email status. Local initialization sets `REQUIRE_EMAIL_VERIFICATION=false`; absent configuration still requires verification, and production rejects a disabled requirement. Existing unverified accounts can create organizations and accept email-bound invitations when the development bypass is enabled.

- `REQUIRE_EMAIL_VERIFICATION=true pnpm test`: 68 passed, including bypass/re-enable behavior, unchanged verification status, and production startup rejection.
- Lint, typecheck and all eight build targets passed.
- The focused browser scenario passed against compiled API and production web output with local bypass enabled: the verification banner is absent, an unverified account creates an organization, and its verification timestamp remains null. That scenario explicitly skips when a server requires verification.
- This cloud instance's ignored `.env` now disables the development verification gate. No account verification timestamps or existing SMTP credentials were changed. SMTP and Mailpit configuration are documented in deployment.md.

## Phase 4 local usability fixes

User-provided logs contained repeated generic workflow-worker failures and React Flow node initialization warnings. Generic worker messages do not establish the underlying database error. Worker diagnostics now expose sanitized error codes with migration/connection hints and retry backoff. A focused unit test confirms that raw connection/provider details are not logged.

Canvas nodes now retain React Flow measurement state through controlled node changes. The workflow browser scenario drags a node twice, checks position changes, asserts no initialization warning, and completes publication/approval/resume. The agent browser scenario checks the disabled button and missing-model explanation before registration, then creates an agent after registration. Both browser scenarios passed against compiled services and production web output; typecheck, lint and all eight build targets passed.

## Custom hosted model setup diagnostics

The model-registry screenshot showed an unapproved DeepSeek hostname and no selected workspace credential. Registration errors now distinguish host approval, HTTPS and malformed endpoints. Form guidance explains custom-host approval, restarting API/worker, and explicitly selecting a saved API-key secret. No server allowlist was broadened automatically.

All 10 focused agent API tests passed, including rejection of an unapproved DeepSeek host, acceptance after explicit approval, persistence of the selected workspace secret, and rejection of HTTP for that hosted endpoint. Lint, typecheck and all eight build targets passed. These tests validate registration policy; live DeepSeek authentication/model acceptance was not tested.

## Model management and connection-test diagnostics

Migration 0006 adds optimistic revision and archive metadata to model configurations. Administrators can edit all registry settings and remove a model after confirmation. Active agent drafts block removal; published snapshots and historical rows remain intact. Endpoint approval, credential tenancy and output/context limits apply on updates. Browser preflight now permits PUT/DELETE while retaining the configured origin and write-origin validation.

The API previously masked sanitized model-test 502 messages as Internal server error. Model tests now report safe provider error codes with configuration hints, protect initialization/credential failures, and identify undecryptable stored credentials without exposing ciphertext or raw errors. The user's browser logs confirmed 502 responses but did not identify the actual DeepSeek failure; live DeepSeek acceptance remains unverified.

- `REQUIRE_EMAIL_VERIFICATION=true pnpm test`: 73 tests passed, no failures/skips. New checks cover model lifecycle permissions, stale revisions, active-draft deletion protection, snapshot retention, archived-model exclusion, sanitized provider errors, undecryptable credentials and browser preflight methods.
- The updated agent browser scenario passed against compiled API and production web output: register, prefilled edit/save, confirmed deletion, create/chat/publish and hosted chat. The workflow browser scenario also passed during this change.
- Lint, typecheck, all eight build targets, and repeated migration passed.

## Phase 5 enterprise operations initial release

- Final backend suite: **86 passed**, zero failures/skips. New integration coverage checks tenant/capability boundaries, separate corrections, conversation filters, saved pricing rates, protected role edits, API-key hash/scope/expiry/revocation/current permissions and independent per-key limiting. Webhook fixtures verify signing, payload redaction, transient backoff, manual retry, secret rotation, disabled queueing and final-attempt lease recovery. Deployment tests reject foreign published versions and unauthorized promotion.
- Operations browser scenarios passed: analytics, pricing edits, one-time key display/dismissal/revocation, deployment environment updates, unapproved webhook explanation, audit action filter, response review/correction, rating filter, mobile layout and analyst read-only controls. Two attachment navigation/selection/error scenarios also passed.
- Lint, all eight package typechecks and all eight build targets passed. Migration 0007 was applied and a repeated migration passed. API infrastructure readiness and web HTTP 200 passed after restoring development services.
- Explicit fixtures demonstrate protocol/database behavior, not live DeepSeek or third-party HTTPS receiver acceptance. The mobile view was visually inspected; its cost card was widened to keep values readable. Production retention and the broader Phase 5 extensions remain listed in implementation-plan.md and operations.md.

## Phase 6 generative experience initial release

- Backend suite with verification enabled: **93 passed**, zero failures/skips. Seven new integration tests cover strict schemas, no raw JSON/token rendering, persisted components, private artifacts, CSV formula protection, signed download grant/expiry/tampering, tenant/role access, validated confirmed forms/actions, replay rejection, guest tokens and disabled deployments.
- The generative browser scenario passed after the final UI changes: real SSE through an explicitly approved local protocol fixture; chart/table rendering; rejected then accepted confirmation; actual CSV download; stored-record search; hosted forms disabled by default; mobile overflow check. The mobile screenshot was visually inspected. No live provider acceptance is implied.
- Lint, all eight package typechecks and all eight build targets passed. Migration 0008 was applied and repeated successfully. Development services were restored without the temporary local provider-host grant.
- Phase 6 currently covers chat, single-series charts, built-in collection and TXT/Markdown/CSV. Remaining rich-file formats, custom actions/approvals, workflow UI outputs, provider acceptance and production retention are explicit in implementation-plan.md and generative-experience.md.

## Phase 7 web channels, browser voice and human support initial release

- Backend suite: **98 passed**, zero failures/skips. Five new integration scenarios cover exact-origin validation and restricted CORS, default-disabled embedding, private API origin protection, widget token/deployment/channel/origin binding, tenant/admin permissions, guest and operator handoff access, atomic transition/replay rules, active-run protection and agent pause/resume.
- The final browser scenario passed: configure a deployment, load the script on a separate local website origin, stream a reply, request human support, join/reply as an operator, send visitor support messages, resolve and return to the agent. Mobile overflow and rendered screenshots were inspected. The browser exposed a static-script resource-policy issue, fixed with a cross-origin resource exception on `/widget.js` only.
- Browser speech fixtures verified editable dictation, explicit playback and microphone-denial fallback. These tests do not validate actual microphone capture, speech service or live model acceptance. WhatsApp/Messenger and provider real-time voice are documented planned integrations, not implemented adapters.
- Lint, all eight typechecks and all eight build targets passed. Migration 0009 applied and repeated successfully. Normal development services were restored without the temporary local model-host grant.

## OpenAI completion parameter and safe provider diagnostics

- OpenAI Chat Completions uses `max_completion_tokens`; compatible providers retain `max_tokens`. Protocol assertions cover both mappings and omitted disabled sampling parameters. HTTP error tests preserve status and recognized code/parameter, reject arbitrary codes/fields and oversized/non-JSON error bodies, and verify transport cleanup.
- Connection-test integration checks display HTTP/model-access and unsupported-temperature hints, reject empty visible responses, and retain existing credential-failure handling. Provider messages, raw error bodies and credentials are excluded from logs and responses. The connection probe uses at most 1,024 completion tokens, bounded by the registry limit.
- Final full backend suite: **94 passed**, zero failures/skips. Lint, all eight typechecks and all eight build targets passed. Earlier runs encountered a development-worker race and shared Redis rate-limit buckets; the final run completed with worker supervisors stopped and normal bucket expiry. No rate-limit checks were disabled.
- `gpt-6-luna` availability and the user's actual OpenAI project/model acceptance remain unverified. The original screenshot/error did not supply a provider HTTP status or structured error code, so the compatibility fix does not establish its original root cause.

## Phase 8 initial quality release (2026-10-10)

- Local `feat/quality-platform` starts from Phase 7 `f4654ff` and includes the local OpenAI compatibility fix `1db5e04`; no pull/rebase from main was performed.
- Migration 0010 applied successfully and a repeat migration run completed without reapplying it; pgvector version verified.
- Full backend suite: **115 passed, 0 failed**. Sixteen quality checks cover scoring, tenant/role restrictions, publication gates, dataset/draft revisions, provider errors, malformed judges, cancellation, pricing snapshots, dependency changes, revoked requester access and lease recovery/checkpoints.
- Quality fixtures use a separate loopback client IP so added tests do not exhaust the existing suite's shared Redis rate bucket. Rate limits remain enabled. Initial attempts hit shared buckets; the final full run passed after normal expiry.
- Browser quality lifecycle: **1 passed** using an explicit OpenAI-compatible protocol fixture and temporary API/worker private-host grant `127.0.0.1:4552`. Covers dataset creation, real chat/conversation import, worker evaluation, publication gate block/pass, regression baseline and stale-dataset invalidation/tagged failures. No browser page errors. A textarea label mismatch found during the first run was fixed with explicit accessible names.
- Lint, type checks and production builds passed across all eight packages. Readiness returned PostgreSQL/Redis/storage/Temporal ready; web returned HTTP 200.
- Fixture results do not establish live-provider accuracy, live voice support or production scale. Remaining Phase 8 extensions are recorded in quality.md.

## Phase 9 initial S3 connector release (2026-10-10)

- Fetched the merged main and rebased onto merge commit `9717426`; Phase 9 is on `feat/enterprise-connectors` with no force push or changes to main.
- Migration 0011 and repeated migration execution passed; the new composite source identity constraint enforces tenant-scoped connector item references.
- Full backend suite: **127 passed, 0 failed**. The final targeted connector suite also passed **12/12** after the final edits. Coverage includes role/tenant boundaries, signed local S3 listing/download with spaces in prefixes, actual ingestion/retrieval provenance, unchanged/changed files, complete-listing limits, conditional download races, managed-only removals, fresh identifiers for deleted sources, schedules/listing-limit edits, pause with malformed credentials, cancellation, permissions, crash bounds and credential release on disconnect.
- Browser lifecycle: **1 passed** against local S3 with an explicit embedding protocol fixture and temporary private endpoint grants. Covers setup, source readiness/retrieval, incremental sync, schedule/listing-limit edits, pause/resume and disconnect retaining sources. No page errors. An initial run exposed missing dev-runner forwarding for connector grants; `globalPassThroughEnv` now includes both connector variables.
- Lint, type checks and production builds passed across all eight packages. Readiness reports PostgreSQL/Redis/storage/Temporal healthy, and normal dev settings are restored after fixture execution.
- Tests use separate connector/quality fixture client IPs and leave rate limits enabled. AWS production IAM/KMS, other provider adapters and broader production acceptance remain documented in connectors.md.

## Phase 9 — Google Drive connector extension

- Built on the unmerged S3 connector branch without pulling from main; Google Drive changes are on `feat/google-drive-connectors`.
- Migration 0012 applied successfully and repeated migration execution was a no-op.
- Backend suite: **138 passed, 0 failed**. Covers service-account JWT signature/read-only scope, token reuse, native Docs export without reported byte size, binary integrity checks, pagination cycles, incomplete searches, access denial, download races, bounded recursive inventory, durable native-document ingestion, unchanged files, managed removal and exact form-encoded OAuth transport. Existing S3/tenant/permission tests still pass.
- Browser connector suite: **2 passed**. S3 worker ingestion/incremental sync/configuration/pause/disconnect remains covered; Google Drive setup verifies sharing instructions, provider-specific fields, saved folder/recursive selection, immutable source settings, pause and disconnect. Google Drive browser setup does not call a live Google API.
- Lint, typecheck and builds passed across all eight packages. PostgreSQL, Redis, storage and Temporal readiness checks passed and the web returned HTTP 200.
- Google responses are explicit protocol fixtures; no Google credentials are configured. Live service-account, shared-drive and export acceptance remains pending. Per-user source ACL mirroring and interactive OAuth remain outside this slice.

## Phase 9 — OneDrive for Business connector extension

- Built on the existing Google Drive/S3 changes without pulling from main; this slice is on `feat/onedrive-connectors`.
- Migration 0013 applied successfully and repeat migration execution was a no-op.
- Backend suite: **156 passed, 0 failed**. The 17 OneDrive adapter tests cover form-encoded tenant application credentials, token reuse/renewal, recursive bounds, skipped remote shortcuts, personal-drive rejection, lost folder access, pagination loops/foreign endpoints, file races, checksums, download size limits, denied redirects, Graph credential isolation and refusal of additional redirects. Integration coverage validates encrypted provider credentials, endpoint grants, durable ingestion/readiness, unchanged files, permission failure preserving knowledge and managed-only removal.
- Browser connector suite: **3 passed**. Existing S3 worker and Google Drive setup lifecycles pass; OneDrive setup verifies provider instructions, required drive/folder IDs, saved recursive/schedule settings, immutable source selection, pause and disconnect. No OneDrive browser page errors.
- Lint, typecheck and builds passed across eight packages. API readiness reported PostgreSQL, Redis, storage and Temporal ready; the web returned HTTP 200.
- Microsoft responses are explicit protocol fixtures, not live Microsoft access. No Microsoft credentials are configured, and current cloud egress does not grant the Microsoft integration endpoints. Live Entra consent, business-drive reads, tenant download hosts and production acceptance remain pending. Personal/delegated sign-in, sovereign clouds, delta feeds and per-user ACL mirroring are outside this initial slice.

## Phase 9 — SharePoint site and document-library discovery

- Built on the existing OneDrive/Google Drive/S3 changes without pulling from main; this slice is on `feat/sharepoint-connectors`.
- Migration 0014 applied successfully and repeat migration execution was a no-op.
- Backend suite: **171 passed, 0 failed**. SharePoint discovery/adapter coverage includes direct site resolution, site/library membership, folder browsing, skipped shortcuts, credential isolation, token reuse, malformed URLs, foreign/looping pagination, bounded catalogs, invalid parents and fixed Graph credential destinations. API integration verifies administrator/tenant access, selected encrypted credentials and safe metadata responses. Durable sync verifies ingestion/readiness, provenance, unchanged/changed files, failed membership preserving sources and managed removal. Existing OneDrive tests pass after extracting the shared Graph client.
- Browser connector suite: **4 passed**. Existing S3, Google Drive and OneDrive flows pass. SharePoint confirms a browsed folder, clears stale choices on credential changes, persists site/library/folder IDs, locks source selection on edit and disconnects. No SharePoint page errors. Discovery responses are an explicit browser fixture; registration and secret/persistence operations use the real API. Server discovery uses protocol-backed integration tests.
- Lint, typecheck and builds passed across eight packages. API readiness reported PostgreSQL, Redis, storage and Temporal ready; the web returned HTTP 200.
- No Microsoft credentials or integration egress grants are configured in this cloud environment. Live `Sites.Selected` grants, site/library enumeration and actual tenant downloads remain pending acceptance. This slice covers document-library files; SharePoint lists/pages, broad tenant search, delegated sign-in, sovereign clouds, delta feeds and per-user ACL mirroring remain extensions.

## Teams / Slack and initial Phase 10 hardening — 2026-10-10

- `pnpm db:migrate`: migration 0015 applied; repeat invocation passed without reapplying migrations. The actual pgvector extension passed the release requirement.
- Full backend suite: **193 passed, zero failed/skipped** (`/tmp/agentconnect-teams-slack-final-backend.log`). Fifteen messaging protocol tests cover selected workspace/channel identity, permissions, messages/replies, fingerprints, bounded scans, pagination, cancellation, deleted Teams bodies and Slack thread broadcasts. The same suite exercises real local database/storage/embedding ingestion, edits and safe removals for both new adapters.
- After exempting operational health from the Redis-backed application rate limiter, the foundation suite was rerun: **12 passed**, including 305 successful liveness requests and actual infrastructure/schema readiness (`/tmp/agentconnect-hardening-health-route-final.log`). This is an additional targeted regression check after the full suite.
- Connector browser suite: **6 passed** (`/tmp/agentconnect-messaging-browser.log`). Teams/Slack registration, selected encrypted credentials, fixed source IDs, edit/pause/resume/disconnect and prerequisite guidance use the real local API. Provider transport is not exercised by these UI setup cases. S3 browser ingestion uses the real worker and local object store with an explicit embedding protocol fixture.
- Final lint/type checks and production build passed (`/tmp/agentconnect-hardening-health-lint.log`, `...-types.log`, `...-build.log`). Type/build targets: eight packages.
- `pnpm deployment:check --development` passed real schema/dependency checks. Default production preflight against the development environment correctly returned nonzero with `PRODUCTION_ENV_REQUIRED`. Production policy tests reject elevated/missing database roles and known credential placeholders.
- Readiness concurrency smoke: **40/40 passed**, concurrency eight, p50 5 ms / p95 49 ms (`/tmp/agentconnect-hardening-smoke.log`). This is a local probe measurement, not a throughput or production load certification. Timeout/coalescing/recovery tests use explicit injected checks; no production infrastructure was stopped for a failover experiment.

Salesforce, Zendesk and Zoho are deferred. Live Teams/Slack permission acceptance remains pending organization-managed credentials and allowed egress. Phase 10 penetration testing, production failover, measured backup/restore, comprehensive retention, release/on-premise packaging and accessibility acceptance remain tracked in hardening.md.

## Phase 10 tenant-isolation regressions — 2026-10-10

- `pnpm test:security`: **13 passed, zero failed/skipped** (`/tmp/agentconnect-isolation-security.log`). Three fixture workspaces across two organizations exercise sibling and unrelated-tenant access, 28 collection routes, 17 resource detail/history routes, all six connector providers, nested references, current membership/session/key permissions, scoped execution and public token binding. Real local storage holds generated artifacts and knowledge text; model output is an explicit protocol fixture.
- The initial adversarial artifact-grant test reproduced a widget origin-policy gap: a valid widget token without the conversation origin received a grant. The shared generative message-access helper now checks conversation channel/origin and current widget settings. Regression checks reject missing/unapproved/other-approved origins and disabled-widget grants/actions without writing a submission.
- Direct mixed-tenant connector credential/knowledge-base references fail PostgreSQL composite foreign keys; denied API mutations leave foreign resource state unchanged. Revoked queued connector work fails before constructing a provider adapter.
- Full backend suite: **207 passed, zero failed/skipped** (`/tmp/agentconnect-isolation-backend-final.log`). Existing hosted/private generative access, channel behavior, connector ingestion and worker recovery tests also passed.
- Lint, types and production build passed (`/tmp/agentconnect-isolation-lint.log`, `/tmp/agentconnect-isolation-types-final.log`, `/tmp/agentconnect-isolation-build.log`); type/build targets: eight packages.
- No database migration is required for this guard or regression suite. Normal development startup was restored after backend validation.

Coverage and material limits are documented in tenant-isolation.md. Already-issued artifact URLs remain bearer capabilities until their five-minute expiry. These checks concern new requests and queued connector authorization; they do not certify independent penetration testing, RLS, every possible race, or interruption of previously authorized streams. No live provider credential acceptance or production failover experiment was performed.

## Phase 10 backup/recovery verification — 2026-10-10

- `pnpm recovery:drill` passed with real local PostgreSQL custom-format dump/restore and S3 source/recovery buckets. All 15 migrations, pgvector/vector contents, two synthetic tenants, two tenant-prefixed objects and encrypted workspace secrets were verified. The encrypted in-memory archive was 191,939 bytes; restore and verification took 495 ms, with total pre-cleanup work of 1,233 ms. These are local synthetic measurements, not production RPO/RTO targets (`/tmp/agentconnect-recovery-drill.log`).
- Wrong archive keys and corrupted ciphertext failed authentication. Missing/changed objects failed hash checks. Recovered secrets failed with a different master key or another tenant's context. Mixed-tenant secret updates failed composite foreign keys. The original master key was restored in the drill process after the wrong-key check.
- A remote storage endpoint was rejected before resource creation (`/tmp/agentconnect-recovery-guard.log`). Cleanup left zero `ac_drill_*` PostgreSQL databases and zero `ac-drill-*` S3 buckets. Only this invocation's fresh buckets/keys are deleted; the configured application database and bucket are never restored or backed up by the drill.
- Full backend suite: **209 passed, zero failed/skipped** (`/tmp/agentconnect-recovery-tests.log`). Two new unit tests cover archive authentication, key/format rejection and object-integrity failures.
- Lint, type checks and build passed (`/tmp/agentconnect-recovery-lint.log`, `/tmp/agentconnect-recovery-types.log`, `/tmp/agentconnect-recovery-build.log`). No application schema migration or provider credentials are required. Normal development startup was restored; readiness passed all four dependencies and the web returned HTTP 200.

See [backup-recovery.md](backup-recovery.md) for prerequisites, cleanup and production acceptance. This slice verifies the recovery mechanism with synthetic data on the local services. Persistent backup scheduling, PITR, object versioning/replication, master-key escrow, production role/grant recovery and Temporal/infrastructure recovery remain open.

## Phase 10 workspace retention — 2026-10-10

- Migration 0016 applied; repeat migration invocation passed without reapplying it. Readiness requires all 16 release migrations and the actual supported pgvector version.
- Full backend suite: **219 passed, zero failed/skipped** (`/tmp/agentconnect-retention-backend-final.log`). Ten new retention integration scenarios use real PostgreSQL/S3 to cover disabled/indefinite defaults, administrator and sibling/unrelated-tenant boundaries, valid periods and stale revisions, non-destructive previews, policy change cancellation, revoked administrators, active runs/handoffs, workflow checkpoint cleanup, evaluation baseline protection, durable object retries and invalid-key rejection.
- Additional retention checks cover concurrent workers, rechecking conversation activity after waiting for a real writer lock, complete transaction/outbox rollback on an invalid object reference, bounded batches with more than 100 related files, accelerated follow-up scheduling and file-only expiry preserving message content.
- The first full run hit the shared default-IP request bucket in three existing tests after the retention scenarios added traffic. Retention fixtures now use their own randomized loopback source address; production rate limits are unchanged. The final full run passed.
- Tenant isolation regression coverage now includes the retention settings/history read route alongside the existing workspace collections. The broader suite still passes all 13 adversarial isolation scenarios.
- Browser retention acceptance: **2 passed** (`/tmp/agentconnect-retention-browser.log`). The administrator flow uses the real API/database and worker to save a policy, preview, acknowledge permanent deletion, queue a batch, observe completion/audit and verify saved settings after reload. The builder flow verifies read-only settings and no management controls. No page errors were observed in the administrator flow.
- Lint, type checks and builds passed (`/tmp/agentconnect-retention-lint-final.log`, `/tmp/agentconnect-retention-types.log`, `/tmp/agentconnect-retention-build.log`). Type/build targets: eight packages. The production build completed successfully; normal development startup was restored and readiness passed PostgreSQL, Redis, storage and Temporal. Web HTTP 200 passed.
- The existing isolated recovery drill also passed with all **16 migrations**, two synthetic tenants and two objects (`/tmp/agentconnect-retention-recovery.log`). The archive was 208,339 bytes; restore/verification took 1,003 ms under concurrent validation load. This is a local synthetic recovery measurement.

See [retention.md](retention.md) for supported categories, parent/child deletion semantics, queue monitoring and remaining privacy/compliance limits. Existing workspaces keep all data until an administrator configures and enables a policy. Raw audit, copied datasets/webhook payloads, knowledge, storage old versions, backups and legal holds require separate policies. No production workspace cleanup was enabled by this implementation or its fixture tests.

## Workspace UI polish

- Reviewed all 17 menu screens at 360, 768 and 1440 pixels using synthetic workspace data. No document overflow or browser errors occurred in the responsive audit. Inspected desktop forms, overview, agent editor, mobile models and navigation screenshots. Review previews are saved with [the UI notes](ui-polish.md).
- All **25 browser scenarios passed across the combined run and paced rechecks**, including registration/email verification, model lifecycle, agent chat/publication, attached knowledge/tools, hosted chat, generated content, visual workflows, source connectors, support/voice controls, operations, quality and retention. The combined run passed 20 scenarios; API rate limits affected four remaining scenarios, and the new logout test needed its fixture cleanup to remove the user-scoped logout audit. Those scenarios passed after pacing and cleanup fixes. The production limiter remains unchanged.
- Four new UI scenarios cover refresh/Back/workspace persistence, prerequisite navigation, keyboard skip navigation, mobile drawer and dialog focus, viewport fit, API outage/retry, readable non-JSON failures and sign-out cache clearing. Existing operations tests now open the mobile drawer; tool attachment naming and rate pacing match the current UI and a rate-limited API route.
- Lint, all eight package typechecks and all eight production build targets passed. Changes affect frontend presentation/client feedback; no schema migration is required. Temporary provider/connector fixture allowances were confined to the test runtime, synthetic UI records were removed, and normal development startup was restored.
