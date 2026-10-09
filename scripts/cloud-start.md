# AgentConnect development startup

Use the existing checkout at /workspace/AgentConnect. Each cloud task is already isolated; do not create a Git worktree unless explicitly requested. Read docs/deployment.md and docs/security.md.

Installed dependencies, source files, .env, and build artifacts may be retained in the snapshot. Live processes and Docker service state must be checked and restarted. Preserve .env; never print its values or email action tokens.

In a shell:
export XDG_DATA_HOME=/workspace/.cache/data
export XDG_CACHE_HOME=/workspace/.cache
export PNPM_HOME=/workspace/.cache/pnpm
export npm_config_cache=/workspace/.cache/npm
cd /workspace/AgentConnect
docker compose up -d --wait
pnpm db:migrate
pnpm storage:init

If dependencies or artifacts are missing, run ./scripts/cloud-install.sh. It uses the frozen lockfile and preserves existing local credentials.

Start pnpm dev in a persistent terminal session. It launches the Next.js web application on port 3000, Fastify API on port 4000, and worker with independent SMTP outbox, knowledge ingestion and delayed raw-object cleanup loops. Avoid a second copy if these processes are already running. Restart development processes after changing .env.

Readiness:
curl --fail --silent http://localhost:4000/health/ready
curl --fail --silent http://localhost:3000/ -o /tmp/agentconnect-web.html
The API must report ready with PostgreSQL, Redis, storage, and Temporal. UI registration and email verification use the local Mailpit capture service on port 8025; no external email is sent by default. SMTP uses 127.0.0.1:1025. Do not publish loopback preview links in onboarding.

Validation when needed: pnpm lint; pnpm typecheck; pnpm test; pnpm build. With development services running, pnpm test:e2e exercises foundation and agent lifecycle flows using installed Chromium. For the agent and knowledge browser tests only, start API and worker with MODEL_PRIVATE_HOSTS=127.0.0.1:4545,127.0.0.1:4546 and KNOWLEDGE_PRIVATE_HOSTS=127.0.0.1:4546. Tests start explicit HTTP chat/embedding/website fixtures there. Stop test processes and restart without this private-host exception afterward. Test responses do not validate live hosted providers. Tests refuse production mode and clean up their own database records. Never point tests at production.

Phases 0–2 are implemented. Read docs/agent-runtime.md for model setup, streaming, publication and hosted chat, and docs/rag.md for knowledge ingestion, embeddings, retrieval and citations. Live model use requires an encrypted workspace credential under Secrets, a registered model under Models and permitted provider egress. Never paste keys into chat. Fixture tests require no external credential. RAG, tools, visual workflows and later phases are tracked in docs/implementation-plan.md. Production deployment requires external SMTP, HTTPS, managed infrastructure and the documented security review.

Knowledge startup: embedding credentials are encrypted workspace secrets; register the embedding model and exact output dimension in Knowledge. No fallback vectors or fake model responses exist. Website destinations are opt-in through KNOWLEDGE_ALLOWED_HOSTS plus cloud egress approval; never use wildcard destinations. KNOWLEDGE_PRIVATE_HOSTS stays empty during normal startup.

Stop the ingestion worker before pnpm test: those API tests explicitly process their own jobs with injected embedding fixtures, and a separate live worker must not claim them. Restart the real worker for browser tests and normal development. Browser tests clean up their own SQL, HNSW indexes and S3 artifacts. Published agent settings are fixed but attached knowledge uses current ready documents; public knowledge is an explicit opt-in.
