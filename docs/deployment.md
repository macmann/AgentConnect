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

## Read-only tools and MCP

See tools.md. Tool destinations default to denied: TOOL_ALLOWED_HOSTS for HTTPS, TOOL_PRIVATE_HOSTS for trusted private host:port exceptions, TOOL_DATABASE_HOSTS for explicit PostgreSQL host:port grants. Store integration credentials in encrypted workspace secrets. Restart the API after changing server grants. Cloud outbound access must also permit the destination.

The new browser tooling scenario uses an explicit fixture on 127.0.0.1:4547. For all four browser scenarios, temporarily start the API with MODEL_PRIVATE_HOSTS=127.0.0.1:4545,127.0.0.1:4546,127.0.0.1:4547, KNOWLEDGE_PRIVATE_HOSTS=127.0.0.1:4546 and TOOL_PRIVATE_HOSTS=127.0.0.1:4547. The worker needs the model/knowledge fixture exceptions only. Restart normal processes without these grants after testing.

Phase 4 requires migration 0005 and a running worker for workflows. The PostgreSQL role must be able to initialize the workflow_checkpoints schema on first execution; production deployments can provision it ahead of time and restrict the runtime role afterward. Restart workers with each runtime release. Approval waiting is persisted, and the next approved attempt resumes the checkpoint. Reads can repeat after a crash before checkpoint commit; this is not an exactly-once workflow engine.

The fifth browser scenario uses a workflow provider fixture on 127.0.0.1:4548. Include that exact host:port in temporary MODEL_PRIVATE_HOSTS for both API and worker when running the browser suite, and remove the fixture grants afterward. Stop the worker for the API test suite so it cannot claim fixture jobs or runs.

## Local email verification

For development without an inbox, set `REQUIRE_EMAIL_VERIFICATION=false` in the repository-root `.env`, restart `pnpm dev`, and refresh the browser. This permits organization creation and email-bound invitation acceptance for existing unverified accounts; it does not mark their email addresses verified. Newly generated local `.env` files use this setting. Existing `.env` files are preserved by `pnpm local:init`, so add the setting yourself if needed. The API defaults to requiring verification when the setting is absent, and refuses to start in production with it disabled.

To enable verification, set `REQUIRE_EMAIL_VERIFICATION=true`, configure `SMTP_URL` and `MAIL_FROM` in `.env` (or your deployment's secure environment settings), and restart both API and worker. The worker delivers the persisted email outbox. The default development SMTP service is Mailpit: messages appear in its local capture inbox rather than your personal mailbox. On your own machine, open `http://localhost:8025` to read captured verification emails. Real SMTP credentials belong in secure environment settings and must not be committed. SMTP administration through the product UI is not implemented yet.

API tests that exercise the required-verification flow can be run with `REQUIRE_EMAIL_VERIFICATION=true pnpm test`. Browser foundation tests still verify the real SMTP capture and verification flow even when local bypass is enabled.

## After pulling a new phase

Stop `pnpm dev`, pull the intended branch, run `pnpm install --frozen-lockfile` and `pnpm db:migrate`, then restart `pnpm dev`. Phase 4 adds workflow tables in migration 0005. Older database schemas can produce repeated workflow worker failures even when API health reports ready. Worker diagnostics now print sanitized error codes and a migration hint for missing tables/columns, with bounded backoff during repeated failures.

Create agent requires a registered model in the selected workspace. Administrators register it under Models; builders can then create agents. Store hosted-provider credentials under Secrets and select the credential in the model configuration. Model registration does not itself verify that the provider accepts the credential: test the connection before chatting.

## Custom hosted models such as DeepSeek

Select OpenAI-compatible in Models and use the provider's supported base URL and exact model identifier. DeepSeek's `https://api.deepseek.com` base URL is compatible with the adapter, which appends `/chat/completions`; adding `/v1` is not required by this application. Check the identifier against the models available to your provider account.

Append `api.deepseek.com` to `MODEL_ALLOWED_HOSTS` in the repository-root `.env`, preserving the existing hosts, then restart both API and worker. With the default host list, the resulting setting is `MODEL_ALLOWED_HOSTS=api.openai.com,api.anthropic.com,generativelanguage.googleapis.com,api.deepseek.com`. If developing in the managed cloud, its outbound network policy must also permit the destination; local server approval does not change cloud egress policy.

Store the DeepSeek API key under Secrets in the same workspace, then explicitly select that secret in Workspace credential. The success message for saving a secret does not mean it is selected in the model form. Leave None selected only for providers that require no authentication. Save the model and test its connection before creating an agent.
