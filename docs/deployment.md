# Development deployment

Requires Node 24, pnpm 11.19.0 and Docker Compose. Run commands from the repository root. In the cloud machine, keep package-manager caches under /workspace using XDG_DATA_HOME=/workspace/.cache/data, XDG_CACHE_HOME=/workspace/.cache, PNPM_HOME=/workspace/.cache/pnpm.

1. `pnpm install --frozen-lockfile`
2. `pnpm local:init` generates .env only if absent. Never overwrite existing credentials.
3. `pnpm infra:up` starts isolated local infrastructure and waits for readiness.
4. `pnpm db:migrate` runs numbered migrations under a PostgreSQL advisory lock.
5. `pnpm storage:init`
6. `pnpm dev` starts API on 4000 and web on 3000.
7. `curl --fail http://localhost:4000/health/ready` verifies all infrastructure.

The local SMTP capture service (Mailpit) receives development email on port 1025; its private inbox UI listens on port 8025. The `pnpm dev` command also starts the real mail-outbox worker. No external email is sent by the default development configuration.

Local processes do not survive environment restoration; restart infrastructure and development processes. Use existing checkout; do not create a Git worktree.

## Email

Set SMTP_URL and MAIL_FROM in .env, then run `pnpm --filter @agentconnect/api mail:worker`. SMTP_URL is a credential: use secure environment settings. Local initialization configures Mailpit SMTP; existing .env files are preserved and may need SMTP_URL added. The encrypted mail_outbox holds pending messages. For local verification, use the terminal helper below; it prints email content containing one-time links intentionally, so run only privately, never capture output in shared logs.

`pnpm --filter @agentconnect/api mail:inspect you@example.com`

The helper refuses production mode. Configure real SMTP before production. Production config fails fast without SMTP and HTTPS WEB_ORIGIN. Core services are development containers; production topology remains a later deployment task.

## Validation

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Tests use the configured database, generate unique users/organizations, exercise real dependencies and clean up only their own resources. Never point tests at production. Fixture tests need no external provider credentials. Live Phase 1 acceptance requires a workspace credential and permitted provider egress.

Browser smoke test: `pnpm test:e2e`. Run it with local development services, Mailpit and PostgreSQL. The agent and knowledge scenarios start explicit HTTP protocol fixtures at 127.0.0.1:4545 and :4546; temporarily start the API with `MODEL_PRIVATE_HOSTS=127.0.0.1:4545,127.0.0.1:4546` for these tests and `KNOWLEDGE_PRIVATE_HOSTS=127.0.0.1:4546`. For example, run `MODEL_PRIVATE_HOSTS=127.0.0.1:4545,127.0.0.1:4546 KNOWLEDGE_PRIVATE_HOSTS=127.0.0.1:4546 pnpm dev`. Stop the test processes and restart the API without this exception afterward. Never enable this test endpoint in a production deployment. Chromium is expected at /usr/bin/chromium; set CHROMIUM_PATH to a compatible installed browser elsewhere. Test users and organizations are removed after execution; the local inbox may retain test messages.

Restart development processes after changing .env. Local SMTP uses 127.0.0.1 to avoid an IPv6-only localhost lookup against IPv4 Docker port bindings.

## Knowledge worker

The worker now runs independent SMTP, knowledge ingestion and raw-object cleanup loops. API and worker must share DATABASE_URL, S3 settings, MASTER_KEY, MODEL_ALLOWED_HOSTS and website destination settings. Restart both after configuration changes. Embedding credentials belong to encrypted workspace secrets, not a global provider-key fallback. Read rag.md for model dimensions, source formats, limits, job recovery and public-knowledge access.

Private host exceptions in browser tests are temporary and must be removed from normal startup. Source-processing API tests inject explicit embedding fixtures and should run with the ingestion worker stopped, preventing it from claiming those test jobs. Browser tests require the actual worker running.
