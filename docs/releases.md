# Release packaging and deployment

This release adds locked Docker images, GitHub validation/release workflows and a Compose rollout command for a single managed host. PostgreSQL, Redis, S3, Temporal, SMTP and TLS ingress remain externally provisioned services. No live registry publication or deployment occurs while developing this change.

## Build and review

The `Validate` workflow runs lint, type checks, the API regression files against disposable infrastructure, rollout tests, the production build and real container smoke checks. Its isolated Redis instance is reset between API test files to preserve real rate limiting without cross-file fixture interference. No application worker competes with backend fixture leases.

Run **Build release images** manually on main, with the deployment's HTTPS public API URL. The workflow first runs validation, then publishes separate API/worker/web images to GHCR and uploads `release.json`. Actions and the Node base image are pinned; dependencies use the frozen lockfile. The manifest records image digests, the source commit and the public API URL. SBOM and minimal provenance attestations accompany the images. Configure the GitHub `release` environment and package visibility as appropriate for the organization.

The browser API URL is baked into the web bundle. A release for one public API URL must not be reused for another without rebuilding the web image. Images contain no runtime `.env` or session CA; the API and worker receive runtime configuration on startup. Production service dependencies are packaged with pnpm's explicit legacy deploy mode and frozen lockfile; startup performs no dependency install. The initial workflow builds Linux images for the hosted runner's architecture, not a certified multi-architecture appliance.

The image smoke script runs migrations twice in a uniquely created local database with a non-superuser role, verifies production preflight, starts all three protected containers against the existing development infrastructure, checks their probes/authenticated metrics and removes only its fixture database/role/containers. After building all three `agentconnect-release-SERVICE:test` images, run `node --env-file=.env scripts/release-smoke.mjs`. It refuses production mode and non-loopback database hosts.

For a local image check, use `docker build --target api --build-arg NEXT_PUBLIC_API_URL=https://api.example.com -t agentconnect-api:check .` and repeat for `worker` and `web`. Managed-cloud builds must supply the session CA as the `proxy_ca` BuildKit secret and retain the inherited proxy settings. See the cloud runtime instructions; TLS verification must stay enabled.

## Host configuration

Install Docker Compose v2.30 or newer with `up --wait` and raw environment-file support. Configure private GHCR authentication through the host's credential store. Provision the documented dependencies and a protected runtime environment file outside the checkout, e.g. `/etc/agentconnect/runtime.env`, mode 0600. Its values are raw, unquoted strings: Compose does not interpolate `$` or strip quotes from secrets. Use actual production configuration, email verification, HTTPS `WEB_ORIGIN`, a non-superuser/non-BYPASSRLS application database identity, SMTP and independent encrypted credentials. API/worker share encryption, storage and provider destination settings. If the host injects HTTP proxies, configure both `NO_PROXY` and `no_proxy` for the private dependency hostnames, including Temporal, while preserving proxies for external traffic. Container connection addresses must resolve from the deployment network; host `localhost` addresses do not refer to external infrastructure.

`deploy/compose.yaml` runs services as the unprivileged image user, drops capabilities, uses read-only roots, bounds writable caches and binds host ports to loopback. Place a TLS ingress on the host in front of web/API. Keep `/health/*`, `/internal/*` and worker port 4100 private; allow operational probes only. Defaults expose web 3000, API 4000 and worker health 4100 on the host's loopback. Override the host port variables if needed. This topology is single-host and does not provide HA or zero-downtime rollout.

## Migrate, check and deploy

Review backups of PostgreSQL, private objects and the master key before migrations. Use a separate protected migration environment file with the migration database identity; SMTP/HTTPS requirements still apply to the production command environment. Migrations use the existing advisory lock and required release schema. They are never run automatically during application startup or rollback.

```sh
RELEASE_BACKUP_CONFIRMED=yes node scripts/release.mjs migrate /srv/releases/release.json /etc/agentconnect/migration.env /srv/agentconnect-state
node scripts/release.mjs check /srv/releases/release.json /etc/agentconnect/runtime.env /srv/agentconnect-state
node scripts/release.mjs deploy /srv/releases/release.json /etc/agentconnect/runtime.env /srv/agentconnect-state
```

Run from the checked-out release repository root. The commands require immutable image digests and a private runtime file. `check` quietly validates Compose, pulls images and runs read-only production preflight. `deploy` does the same checks, then uses Compose readiness to wait for all three services. API readiness verifies release migrations, pgvector, PostgreSQL, Redis, storage and Temporal. Worker readiness verifies progress across every worker loop; web readiness checks the real HTTP server. A successful rollout records `current.json` and the prior `previous.json` in the state directory.

A failed preflight leaves the running services alone. A failure during Compose startup can leave some services updated; the command exits nonzero and does not claim success or automatically roll back. Check the running image digests and health, then explicitly deploy a compatible prior manifest. The recorded current manifest changes only after startup succeeds. Use a single operator/workflow at a time; the CLI does not implement a distributed rollout lock. GitHub deployment concurrency serializes its production workflow.

After readiness, perform a representative authorized login/agent/knowledge/workflow smoke test and observe processing. Infrastructure readiness cannot certify provider account access, external source permissions, SMTP delivery or business correctness.

## Rollback

Review compatibility with the database's current schema and runtime settings first. Do not reverse migrations automatically. With an explicitly selected compatible manifest:

```sh
RELEASE_ROLLBACK_COMPATIBLE=yes node scripts/release.mjs rollback /srv/agentconnect-state/previous.json /etc/agentconnect/runtime.env /srv/agentconnect-state
```

The command uses the same production preflight and readiness gate as deployment. The compatibility flag records the operator's decision, not an automated proof of backward compatibility.

## Optional GitHub deployment runner

The **Deploy reviewed release** workflow targets a dedicated `self-hosted, agentconnect-deploy` runner and the `production` environment. Configure environment protection/review rules, `RUNTIME_ENV_FILE` and `RELEASE_STATE_DIRECTORY` variables, private registry access and a reviewed manifest already placed on that runner. Never expose this privileged runner to pull-request jobs. The workflow accepts the manifest's path and invokes the same tested rollout CLI; it performs no migrations. A deployment target, these bindings and credentials have not been configured by this implementation.

Infrastructure provisioning, Kubernetes/HA orchestration, automatic traffic switching, scheduled backups/PITR, KMS rotation and measured production failover remain separate acceptance work. See [hardening](hardening.md) and [monitoring](monitoring.md).
