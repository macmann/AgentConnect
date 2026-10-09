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
