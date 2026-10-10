# Phase 10: initial deployment hardening

Teams and Slack complete the currently scheduled Phase 9 provider scope. Salesforce, Zendesk and Zoho are deferred. Phase 10 starts with executable deployment checks and bounded readiness. This slice does not certify the platform for production.

## Readiness and service management

`GET /health/live` reports process liveness. `GET /health/ready` returns 200 only when PostgreSQL has every migration required by this release and pgvector >=0.8.7, Redis responds, the configured S3 bucket is accessible, and Temporal responds to system information. Missing schema, dependency failure or deadline expiry returns 503 with only the dependency name. Health routes bypass the Redis-backed application rate limiter so a Redis outage cannot prevent the probe handler from reporting status. Restrict operational health access at the ingress. Never use liveness as the traffic admission check.

Checks run concurrently with a five-second deadline per dependency, share concurrent requests and cache results for two seconds, including failures. PostgreSQL uses a separate one-connection probe pool with two-second connect/statement limits; Redis uses bounded commands without reconnect loops; S3 receives an abort signal; Temporal has connection/RPC deadlines. Probe resources are closed after checks, and the dedicated database pool closes with the API. Readiness does not prove worker progress, provider account access, SMTP delivery, storage write permissions, backup recoverability or HA topology. Monitor queue age, failed work and external integrations separately.

`node scripts/readiness-smoke.mjs [API_ORIGIN]` performs 40 read-only readiness requests with concurrency eight, reports median/p95 latency and fails on any unavailable response. Run it against local or explicitly selected staging infrastructure. This is a small probe concurrency smoke, **not an agent/workflow load test**. Deployment latency/throughput targets need representative datasets, approved model accounts and a production-like environment.

## Deployment preflight

1. Install the locked dependencies with Node 24 and pnpm 11.19.0.
2. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` against isolated test services. Stop the normal worker before backend tests so it cannot consume fixture jobs.
3. Back up PostgreSQL, the private object store and the encryption key before applying migrations. Use a separate migration identity; do not print credentials or include keys in build artifacts.
4. Apply `pnpm db:migrate` with that migration identity. Switch the API/worker to an application database role with only the required privileges; the runtime role must not be superuser or BYPASSRLS. This slice does not introduce RLS or automatically provision grants. Knowledge-base HNSW creation still needs its documented DDL privileges.
5. Run `pnpm deployment:check` with the production service environment before admitting traffic. It requires NODE_ENV=production, existing email verification/SMTP/HTTPS config checks, release schema, the actual pgvector extension, live infrastructure, a non-superuser/non-BYPASSRLS database identity and no known default storage/master-key placeholders. It performs no migration, registration, message send or storage mutation. Success is a preflight result, not a security certificate.
6. Start API/web/worker under a service manager, gate traffic on readiness, verify a representative authorized agent/knowledge/workflow path, then observe queue progress. A failed application rollout should use a compatible previous build; do not automatically undo database migrations.

For local development only, `pnpm deployment:check --development` checks the real schema/dependencies while explicitly omitting production environment/role/default-credential requirements. Never treat that result as production acceptance. The CLI prints safe status/check names or a failure code and returns nonzero on failure; it does not print credentials or provider error bodies.

## Tenant isolation regressions

`pnpm test:security` exercises real API/database/storage boundaries across sibling workspaces and unrelated organizations, with explicit model protocol fixtures. It covers scoped registries, histories, attachments, all six connector providers, nested references, API keys, widget tokens, session/membership revocation and composite database constraints. Widget artifact grants and actions now enforce the originating conversation site and current widget access policy. See [coverage and limits](tenant-isolation.md), including the existing five-minute bearer lifetime of already-issued artifact links.

## Remaining Phase 10 acceptance

- Independent penetration testing and expanded concurrency/race assessment beyond the implemented tenant-isolation regressions.
- Measured agent/ingestion/workflow throughput and p95 targets; worker crash/lease recovery under load; database/Redis/S3/Temporal failover with real infrastructure.
- Encrypted PostgreSQL point-in-time recovery, object versioning/replication and secure master-key backups. Restore all three into an isolated environment, check tenant data and decryptability, and measure RPO/RTO. A database-only backup cannot restore encrypted objects and secrets.
- Organization-approved retention periods covering messages, runs, generated artifacts, evaluations, connector history, raw objects and audit events. Current source deletion/purge does not provide comprehensive retention policy enforcement.
- Reproducible release images, infrastructure provisioning, automated deployment/rollback, on-premise packaging, secrets/KMS rotation, SMTP delivery and worker monitoring.
- Accessibility review with keyboard/screen reader testing, representative performance profiling and operator/customer documentation.

Live Teams and Slack acceptance also remains pending until administrator-configured credentials and approved egress are available. Protocol fixtures exercise the adapters and actual local ingestion; they do not establish live account permission acceptance.

## Backup and recovery verification

Run `pnpm recovery:drill` to restore a synthetic encrypted PostgreSQL/object backup into uniquely named local targets and verify tenant data, vectors, object integrity and master-key decryptability. See [backup-recovery.md](backup-recovery.md) for prerequisites, cleanup, measured scope and production recovery acceptance. Scheduled backups, PITR, independent object replication and key escrow remain pending.

## Workspace retention

Migration 0016 adds disabled-by-default workspace retention, administrator settings/preview, daily and manual cleanup batches, tenant-bound generated-object deletion with retries and audit counts. See [retention.md](retention.md) for deletion scope, scheduling, active-work protection, operational monitoring and remaining compliance obligations. Raw audit, knowledge/dataset copies, webhooks, backups and storage old versions require separate policies.
