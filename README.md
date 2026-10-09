# AgentConnect

Enterprise AI agent platform, built in vertical slices from the supplied master specification. Phases 0–4 implement the development foundation, single-agent MVP and knowledge/RAG: model registry, provider adapters, agent editor, streaming playground, immutable versions, hosted chat, document ingestion, retrieval and citations. Read-only HTTP/database/search tools, MCP discovery and agent tool traces are implemented. Visual workflows now support versioned graphs, agent handoffs, conditional and parallel branches, human approval, and run inspection. Voice and enterprise connectors are later phases.

Start with [development deployment](docs/deployment.md), [architecture and ERD](docs/architecture.md), [implementation plan](docs/implementation-plan.md) and [security](docs/security.md). The complete [product specification](docs/product-spec.md) is retained.

```sh
pnpm install --frozen-lockfile
pnpm local:init
pnpm infra:up
pnpm db:migrate
pnpm storage:init
pnpm dev
```

Use Node 24 / pnpm 11.19.0. Cloud cache environment variables are documented in deployment.md. Local setup disables the verification gate with `REQUIRE_EMAIL_VERIFICATION=false`; see [email configuration](docs/deployment.md#local-email-verification) to enable it and configure SMTP. Register in the web app, create an organization/workspace, invite teammates, store secrets and inspect audit events. Then follow [model and agent setup](docs/agent-runtime.md) to connect a provider, create an agent, chat, publish and open a hosted deployment. Follow [visual workflow setup](docs/workflows.md) to orchestrate published agents and review paused runs. Follow [tool and MCP setup](docs/tools.md) to register integrations and attach them to agents. Follow [knowledge and RAG setup](docs/rag.md) to upload documents, test retrieval and attach cited knowledge to agents. Production code requires configured providers; it does not simulate AI responses or embeddings.

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. API health: `/health/live`, `/health/ready`. API discovery: `/openapi.json`.

[Validation results](docs/validation.md) record the checks actually executed. The cloud install/start instructions are saved in the environment draft; review and publish through environment settings. Phases 0–2 were delivered through the initial PR and merged to main. Phase 3 is merged to main. Phase 4 development is on `feat/visual-workflows`.
