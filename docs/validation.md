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
