# Deploy Agent Connex on Coolify

Use the repository's **Docker Compose** build pack with [`compose.coolify.yaml`](../compose.coolify.yaml). After the one-time domain and SMTP setup, **Deploy** builds and starts the complete stack. Coolify can then deploy later commits through its Git integration. No manual database migration or bucket-creation command is needed for this deployment path.

This package prepares a Git-backed Coolify application. A Coolify marketplace/catalog entry requires separate publication; a live Coolify server has not been configured by this repository change.

## What is included

| Service  | Purpose                                                                          | Exposure                   |
| -------- | -------------------------------------------------------------------------------- | -------------------------- |
| web      | Next.js interface, hosted chat and widget assets                                 | HTTPS domain → 3000        |
| api      | API, integrations and MCP; startup initialization                                | HTTPS domain → 4000        |
| worker   | Ingestion, workflows, schedules, email and background jobs                       | Private                    |
| postgres | PostgreSQL 18 + pgvector; separate application and Temporal identities/databases | Private, persistent volume |
| redis    | Rate limits/cache with authentication and append-only persistence                | Private, persistent volume |
| storage  | S3-compatible RustFS object storage                                              | Private, persistent volume |
| temporal | SQL-backed Temporal server; schema initialization included                       | Private                    |

Application containers run unprivileged with read-only roots and bounded temporary/cache storage. The application database role has no superuser/BYPASSRLS privileges. PostgreSQL's administrator credential is kept out of application containers. Infrastructure images are digest-pinned; application images build from the selected repository commit.

This is a single-server deployment. Start with **4 CPU cores, 8 GB RAM and at least 30 GB free disk** for building plus space for your documents/database; 16 GB RAM provides more headroom. These are practical starting points, not measured capacity guarantees. Large document/vision workloads and production availability requirements need separate sizing.

## Initial setup

1. Point two DNS names at your Coolify server, for example `app.example.com` and `api.example.com`. Use sibling hostnames on the same parent domain so the UI/API session cookies remain same-site. Allow Coolify to manage HTTPS certificates. For the first deployment, use DNS-only records if an upstream proxy makes certificate issuance or debugging difficult.
2. In a Coolify project/environment, add this Git repository (or your fork) using the appropriate public/private repository connection. Select the intended branch or release commit.
3. Choose **Docker Compose** as the build strategy. Set **Base Directory** to `/` and **Docker Compose Location** to `/compose.coolify.yaml`. Use normal Coolify-managed Compose deployment, with its proxy integration.
4. Under **Domains**, route `https://app.example.com:3000` to **web**, and `https://api.example.com:4000` to **api**. The suffix identifies the internal container port; public users still connect over standard HTTPS. Verify the generated `SERVICE_URL_WEB_3000` and `SERVICE_URL_API_4000` values are HTTPS origins without a path, query or internal port suffix.
5. Set **SMTP_URL** and **MAIL_FROM** in Environment Variables. Use a working SMTP provider and verified sender. For example, `smtps://USER:URL_ENCODED_PASSWORD@smtp.example.com:465`. Production email verification remains enabled. Coolify generates the database, Redis, object-storage and encryption secrets referenced by `SERVICE_*` variables; keep these values stable.
6. Under **Advanced → Build**, choose **Build arguments → Managed manually in Dockerfile**. The Compose file supplies the public API URL and optional OCR build flags; private runtime credentials do not belong in build arguments. No source-file bind mounts or manual proxy labels are needed.
7. Select **Deploy**. Wait for every service to become healthy, then open the web domain and register. Confirm the verification email arrives, verify your account, create an organization/workspace, add a provider credential/model and test an agent.

Coolify UI wording varies between versions. Follow its [Git Compose deployment guide](https://coolify.io/docs/applications/builds/docker-compose) and [generated-variable rules](https://coolify.io/docs/services/configuration/docker-compose#generated-service-values). This configuration uses the supported `SERVICE_PASSWORD_*`, `SERVICE_USER_*` and `SERVICE_HEX_64_*` generators, standard Compose builds and health-dependent startup.

The first build can take several minutes. The browser API origin is baked into the web bundle, so configure domains before building. Changing the API domain requires rebuilding the application images, not only restarting containers.

## Startup and redeployment

1. PostgreSQL initializes empty storage with separate application/Temporal roles and databases, and installs pgvector.
2. Redis, S3 storage and Temporal become healthy. Temporal uses PostgreSQL rather than the development SQLite server.
3. The API's Coolify-specific bootstrap runs ordered migrations under the existing advisory lock, creates the bucket if absent, performs production preflight and starts the HTTP server.
4. The worker and web start after API readiness passes. Worker readiness checks progress across all background loops.

Bootstrap runs on each API start. Applied migrations are skipped and an existing bucket is retained. A failed initialization prevents API readiness and downstream startup; logs identify a safe initialization stage. The normal image command and the separate [reviewed release rollout](releases.md) remain available for installations that manage migrations explicitly.

Before redeploying a schema-changing release, back up state and review compatibility. This stack does not provide zero-downtime migration coordination: stop worker processing during upgrades that cannot tolerate an older worker against the new schema. Do not reverse migrations automatically when rolling back code. Disable Git auto-deployment if releases require an operator-controlled maintenance window.

## Configuration

See [`environment.example`](../deploy/coolify/environment.example) for settings you can supply. Coolify's generated secrets persist across deployments. The shipped Compose environment is the source of which variables reach each container; adding an unrelated variable only to Coolify's UI does not automatically expose it to an application process.

- **Provider keys:** register encrypted workspace secrets and models in the application. Do not bake model API keys into images.
- **Website crawling/tools/connectors:** add the exact destination hosts to their corresponding allowlist. API and worker share these settings. Network/firewall policy must permit them too.
- **Multilingual AI extraction:** PDF rendering is included in the default worker build with `ENABLE_AI_EXTRACTION=true`. Select a vision model per knowledge base in the application. Provider usage can incur cost.
- **Local English OCR:** set `ENABLE_OCR=true` at build time and `OCR_ENABLED=true` at runtime, then rebuild the worker. This is separate from multilingual vision extraction.
- **Langfuse:** set all three connection values in Coolify; leave all empty to disable tracing. Content capture is disabled by default.
- **OAuth connector sign-in:** the API callback origin is configured automatically. To enable provider client credentials, add the documented optional environment references to both API and worker in your repository Compose file and supply the secrets in Coolify; see [connectors](connectors.md). Do not insert empty strings for optional client IDs/secrets that require nonempty values.
- **Public API/MCP and messaging:** use the HTTPS API domain. Keep long-lived streaming requests enabled in any upstream reverse proxy. Configure provider callbacks using the displayed API origin.

Only web/API receive domains. Leave PostgreSQL, Redis, storage, Temporal and worker health without public domains or host-port mappings. Restrict `/internal/*` operational endpoints and `/health/*` at your ingress as appropriate; the application does not expose private metrics without its monitoring token.

## Backups and recovery

Back up the PostgreSQL and object-storage volumes, plus Coolify's stored configuration/secrets. Redis has its own persistent volume. Temporal history is stored in PostgreSQL. Preserve the exact `SERVICE_HEX_64_MASTERKEY`: changing it makes existing encrypted workspace credentials unreadable.

Database/Redis/storage passwords are initialized into persistent services. Editing a generated password in Coolify alone does not rotate PostgreSQL roles or stored object-storage data consistently. Follow a coordinated credential-rotation procedure. Do not delete/recreate volumes to fix credentials unless intentionally discarding a disposable installation.

Restore databases, objects and their corresponding secrets together. Changing the resource/project identity or volume names can provision fresh volumes, which can look like data loss. Check Coolify's Persistent Storage view before recreating or renaming the application. Configure and test off-server backups separately; deployment does not create a backup schedule.

## Troubleshooting

| Symptom                              | Check                                                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Build fails before startup           | Repository access, disk/RAM, Node base image/package registry access, build arguments and deployment logs.                                   |
| HTTPS/verification startup failure   | Both generated origins must use HTTPS; SMTP_URL and MAIL_FROM must be valid.                                                                 |
| PostgreSQL never becomes ready       | Volume permissions, disk capacity and fresh-volume initialization logs. Existing unrelated PostgreSQL volumes are not automatically adopted. |
| Temporal is unhealthy                | Its PostgreSQL role/databases and server logs. Its first schema initialization can take time.                                                |
| Bootstrap stage `migration` fails    | Safe migration code/version, pgvector and database ownership. Earlier committed migrations remain recorded.                                  |
| Bootstrap stage `storage` fails      | RustFS health, matching credentials and bucket permissions.                                                                                  |
| Bootstrap stage `preflight` fails    | Required schema, dependency health, application-role privileges and production settings.                                                     |
| Web loads but API requests fail      | Baked API origin, the API domain/port, HTTPS certificates and CORS origin. Rebuild after changing domains.                                   |
| No email                             | SMTP provider delivery/logs, sender verification and worker readiness. Production does not bypass email verification.                        |
| Model/crawl/tool fails               | Test the selected workspace credential/model and review exact host approvals on both API/worker.                                             |
| A service says “No Available Server” | Correct domain's internal port, container health and Coolify proxy logs.                                                                     |

## Reproduce the container acceptance test

Build `api`, `worker`, `web` targets from the root Dockerfile with `NEXT_PUBLIC_API_URL=https://api.coolify.example`, tagging them `agentconnex-coolify-SERVICE:check`. Build `deploy/coolify/postgres.Dockerfile` as `agentconnex-coolify-postgres:check`. For the worker, also pass `ENABLE_AI_EXTRACTION=true` to include PDF rendering. Then run:

```sh
node scripts/coolify-smoke.mjs
```

The script creates a uniquely named disposable stack with no host ports and fixture-only secrets, runs real packaged production preflight/migration checks, verifies the web API origin and CORS, registers a fixture user, observes verification mail in a private capture inbox, restarts services and checks persistence. It removes only its own stack/volumes afterward. Never run backend fixtures against production. Acceptance on an actual Coolify server, DNS/TLS and delivery through your real SMTP/provider accounts must still be verified during your first deployment.
