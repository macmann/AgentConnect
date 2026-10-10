# AgentConnect

Enterprise AI agent platform, built in vertical slices from the supplied master specification. Phases 0–9 implement the development foundation, single-agent MVP and knowledge/RAG: model registry, provider adapters, agent editor, streaming playground, immutable versions, hosted chat, document ingestion, retrieval and citations. Read-only HTTP/database/search tools, MCP discovery and agent tool traces are implemented. Visual workflows now support versioned graphs, agent handoffs, conditional and parallel branches, human approval, and run inspection. An initial enterprise operations release adds conversation review, usage/cost reports, API keys, signed webhooks, protected role editing and deployment environment labels. An initial generative experience adds validated response components, confirmed collection forms, charts and private generated downloads. An initial channels release adds a domain-restricted website widget, browser voice controls and human support inbox. An initial quality lab adds versioned datasets, durable offline agent evaluation, optional LLM judging, retrieval/cost metrics, regression comparisons and administrator-controlled publication gates. An initial enterprise connector release adds approved S3, Google Drive, OneDrive for Business, SharePoint, Teams and Slack knowledge sources with incremental and scheduled sync. Provider real-time voice, messaging adapters and additional enterprise providers remain extensions.

Start with [development deployment](docs/deployment.md), [architecture and ERD](docs/architecture.md), [implementation plan](docs/implementation-plan.md) and [security](docs/security.md). The complete [product specification](docs/product-spec.md) is retained.

```sh
pnpm install --frozen-lockfile
pnpm local:init
pnpm infra:up
pnpm db:migrate
pnpm storage:init
pnpm dev
```

Use Node 24 / pnpm 11.19.0. Cloud cache environment variables are documented in deployment.md. Local setup disables the verification gate with `REQUIRE_EMAIL_VERIFICATION=false`; see [email configuration](docs/deployment.md#local-email-verification) to enable it and configure SMTP. Register in the web app, create an organization/workspace, invite teammates, store secrets and inspect audit events. Then follow [model and agent setup](docs/agent-runtime.md) to connect a provider, create an agent, chat, publish and open a hosted deployment. Follow [enterprise connector setup](docs/connectors.md) to sync approved S3, Google Drive, OneDrive, SharePoint, Teams or Slack sources into knowledge bases. Follow [quality lab setup](docs/quality.md) to evaluate saved drafts and configure publication gates. Follow [channels, voice and human support setup](docs/channels-voice.md) to embed an agent and handle support requests. Follow [generative experience setup](docs/generative-experience.md) to enable rich responses and confirmed forms. Follow [enterprise operations setup](docs/operations.md) to review conversations, configure pricing and manage API access, webhooks and releases. Follow [visual workflow setup](docs/workflows.md) to orchestrate published agents and review paused runs. Follow [tool and MCP setup](docs/tools.md) to register integrations and attach them to agents. Follow [knowledge and RAG setup](docs/rag.md) to upload documents, test retrieval and attach cited knowledge to agents. Production code requires configured providers; it does not simulate AI responses or embeddings.

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. API health: `/health/live`, `/health/ready`. API discovery: `/openapi.json`.

[Validation results](docs/validation.md) record the checks actually executed. The cloud install/start instructions are saved in the environment draft; review and publish through environment settings. Phases 0–2 were delivered through the initial PR and merged to main. Phase 3 is merged to main. Phase 4 and its usability fixes are merged to main. Phases 5 and 6 are merged to main. Phase 7, Phase 8 and the OpenAI compatibility fixes are merged in main. Phase 9 adds S3 connectors on `feat/enterprise-connectors`; Google Drive builds on it on `feat/google-drive-connectors`, OneDrive extends those changes on `feat/onedrive-connectors`, and guided SharePoint library setup builds on them on `feat/sharepoint-connectors`.

Teams and Slack channel ingestion builds on all unmerged Phase 9 changes on `feat/teams-slack-connectors`. Salesforce, Zendesk and Zoho are deferred. The first Phase 10 slice adds bounded schema-aware readiness and `pnpm deployment:check`; see [hardening](docs/hardening.md) for checks and outstanding production acceptance.

The next Phase 10 slice on `feat/tenant-isolation-hardening` adds `pnpm test:security` and closes the widget artifact/action origin-policy gap. See [tenant isolation coverage](docs/tenant-isolation.md).

Run `pnpm recovery:drill` for the isolated local database/object/secret recovery check. See [backup and recovery verification](docs/backup-recovery.md) for prerequisites and production limits.

Workspace administrators can configure retention, preview eligible data and track cleanup under **Retention**. See [workspace retention](docs/retention.md) for scope and worker behavior; migration 0016 is required.

## Human support enrichment

The next product roadmap is [Human Support, Intelligent Handoff and AI Copilot](docs/human-support.md), delivered in phases A–G. Phase A adds durable cases, manual queues and exclusive assignments while keeping existing channel clients compatible. Apply migration 0017. Deployment automation and additional monitoring are paused.

## Human Support console

Apply migration 0018, then open **Human Support** to filter cases, assign/claim, inspect a unified timeline, add private notes and resolve back to AI. See [the support guide](docs/human-support.md).

Human Support Phase C adds optional operator profiles, fresh presence, reserved capacity, skills/languages, queue membership and deterministic routing. Run `pnpm db:migrate` (migration **0019**) and restart API/worker. Configure profiles and queues under **Human Support → Operators & routing**; operators must choose Available before automatic assignment. See [human-support.md](docs/human-support.md) for strategies, recommendations, capacity and compatibility limits.

Human Support Phase D adds policy-controlled customer offers, strict AI triage and private handoff briefs. Apply migration **0020** and restart API/worker. Configure **Human Support → Handoff policy**; customer requests default to an offer after two explicit asks, with confirmation required. AI failure preserves manual support and the default queue.

Human Support Phase E adds a private operator copilot for reviewed reply drafts, cached summaries, attached knowledge citations and approved tool recommendations. Apply migration **0021** and restart services. Open an active assigned case in Human Support; **Use draft** copies text into the composer and never sends it automatically. Configure its model and budget in Handoff policy.
