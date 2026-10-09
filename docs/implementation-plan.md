# Implementation plan

## Phase 0 — Foundation

- [x] pnpm / Turborepo / strict TypeScript monorepo.
- [x] Next.js shell and standalone Fastify API.
- [x] PostgreSQL migration, Redis, S3-compatible storage and Temporal development infrastructure.
- [x] Registration, login/logout, email verification, one-time reset, hashed sessions.
- [x] Organization creation, workspace creation/listing, member invitation/acceptance.
- [x] Explicit role capabilities, tenant-scoped API/database queries, audit infrastructure.
- [x] Envelope-encrypted workspace secrets; browser only receives metadata.
- [x] OpenTelemetry configuration and design system primitives.
- [x] Browser smoke coverage for registration, SMTP verification, workspaces, invitations, secrets, audit and responsive layout.
- [ ] Production deployment review and expanded browser coverage.
- [ ] Production mail provider delivery validation, production worker process management, cleanup/retention jobs and enterprise key management.

Verification status and current environment limitations are documented in README and the delivery report. Checkboxes describe implemented behavior, not production certification.

## Phase 1 — Single agent MVP

- [x] Tenant-owned model configurations, agents, immutable versions, conversations, messages, runs and deployments; composite tenant foreign keys.
- [x] Provider-neutral interfaces and OpenAI, OpenAI-compatible, Anthropic and Gemini HTTP streaming adapters with encrypted credential references.
- [x] Agent draft CRUD, structured/advanced prompts, optimistic revisions, publish and restore draft; published deployment snapshots stay fixed.
- [x] Runtime boundary, conversation persistence, SSE events, cancellation, single running response per conversation, trace IDs and provider-reported usage.
- [x] Model registry UI, agent editor, playground, conversation history and anonymous hosted chat with opaque continuation tokens.
- [x] API/provider tests and browser lifecycle coverage using explicit fixtures, including actual HTTP transport, cancellation and overlapping requests.
- [ ] Live provider acceptance using a securely configured workspace credential and enabled cloud egress.

Acceptance: a builder creates an agent, chats using a configured real model, publishes it and accesses the hosted deployment. The browser lifecycle passes with an explicit local protocol fixture; this does not establish live provider acceptance. Provider credentials are absent in this environment.

## Phase 2 — Knowledge / RAG

- [x] Knowledge bases and immutable embedding-space selection, relational migrations and tenant composite foreign keys.
- [x] Private S3 document uploads, manual text, curated Q&A CRUD/tags and CSV import/export.
- [x] Pluggable parsers for PDF, DOCX, PPTX, XLSX, CSV, TXT, Markdown, HTML and JSON with provenance and bounded extraction.
- [x] Durable ingestion worker with leases, restart recovery, bounded retries, revision checks and atomic chunk publication.
- [x] OpenAI/Gemini/compatible embedding adapters, dimension validation, per-base HNSW and full-text hybrid retrieval.
- [x] Same-origin website ingestion with depth/page/path limits, robots, destination restrictions and canonical provenance.
- [x] Knowledge management UI, retrieval playground, agent attachment, expandable/persisted citations and explicit public-knowledge policy.
- [x] Source removal and delayed, retryable raw-object purge.
- [ ] Live hosted embedding and grounded-generation acceptance with secure credentials and permitted provider egress.

Acceptance is exercised with explicit HTTP protocol fixtures: upload, background ingestion, retrieval, attachment and cited answers in playground/hosted chat. Live provider acceptance remains pending. Limits and parser/production extensions are described in rag.md; checkboxes do not certify enterprise production readiness.

## Subsequent phases

Follow product-spec.md phases 3–10: safe tools/MCP; LangGraph visual workflows; enterprise operations; generative experience; channels/voice; evaluations; enterprise connectors; hardening. Complete a compiling, tested, usable slice before starting the next.

## Risks and dependencies

- Model/OAuth/SMTP integrations require organization-managed credentials and live integration tests.
- pgvector must satisfy >=0.8.7; deployment checks must inspect the actual extension version, not the image tag.
- Temporal start-dev and local storage containers are development services, not HA deployment configurations.
- Production needs TLS termination, managed PostgreSQL/Redis/S3/Temporal, restricted API networking, backups, KMS rotation, SMTP delivery and monitoring.
- RLS, SCIM/SAML/OIDC, custom roles, retention and security penetration/load tests require dedicated later slices.
- Outbox delivery is at least once; an SMTP crash after send can deliver a duplicate message. Tokens remain one-time.
- No automatic owner transfer or member-role editing is exposed in Phase 0. This avoids premature privilege mutation paths.
