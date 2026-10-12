# Langfuse tracing

Agent Connex exports agent and workflow observations through the official `@langfuse/otel` processor. The existing generic OpenTelemetry exporter can run alongside it. Langfuse is optional: without configuration, requests and workers keep their existing behavior.

## Connect your project

Set these **server-side** variables in both the API and worker environment, using keys from the same Langfuse project and region:

```dotenv
LANGFUSE_SECRET_KEY=sk-lf-your-project-key
LANGFUSE_PUBLIC_KEY=pk-lf-your-project-key
LANGFUSE_BASE_URL=https://jp.cloud.langfuse.com
```

Use the instance root URL, not an ingestion API path. The SDK supplies `/api/public/otel/v1/traces`. Self-hosted instances can use their own base URL. Keep credentials in the environment or secret manager; never use `NEXT_PUBLIC_` variables or pass them to the browser. No workspace model secret is needed for telemetry.

Run `pnpm install` after updating, then restart **both** services (`pnpm dev` locally). No migration is required. Each configured process logs `Langfuse tracing enabled` with its content-capture setting, without key values. Incomplete or invalid configuration produces a safe diagnostic and disables Langfuse; it does not prevent application startup.

Optional SDK settings:

```dotenv
LANGFUSE_CAPTURE_CONTENT=false
LANGFUSE_TRACING_ENVIRONMENT=development
LANGFUSE_RELEASE=your-release-version
```

Environment/release help distinguish deployments. The API and worker use distinct service names; `OTEL_SERVICE_NAME` can explicitly override the process name. Generic `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` continues to work independently.

## What appears in Langfuse

Run a Playground chat with an attached ready knowledge base or tool, or run a configured workflow. Observations are batched, so allow a few seconds before refreshing Langfuse Traces.

An agent turn contains:

- `agent.run`: actual application run ID, conversation/session, agent/version, organization/workspace, model, status and aggregate token counts. Its trace ID matches the stored run and SSE `meta.traceId`.
- `knowledge.planning`: decision diagnostics, skipped retrieval and raw-query fallback when applicable; the planning model call is nested beneath it.
- `knowledge.query_rewrite` and `knowledge.reranking`: optional advanced retrieval stages and their model calls.
- `knowledge.search` → `knowledge.retrieval`: mode, thresholds, result count and chunk/source/base IDs with relevance scores; nested embedding, vector search, lexical search (hybrid mode) and ranking fusion.
- `tools.planning`: usage policy, attachment count, planned-call count and planning generation; `tool.execute` identifies each actual execution, type, timing and safe failure code. Automatic mode records available/skipped counts and unavailable-attachment events; it continues without skipped tools. Required-tool mode remains strict.
- `model.generate`: **each actual provider attempt**, model/provider, sampling/token parameters, first-token time, reported input/output tokens, completion/cancellation/error state. Controlled fallback attempts remain separate observations; no partial response is replayed by tracing.

A workflow contains `workflow.run` → `workflow.node.<kind>` → agent/tool/retrieval/generation observations. Parallel branches retain their own parents. Durable recovery and human-approval resumes share a stable trace ID derived from the workflow run ID; each execution attempt has its own observation. Approval pauses are marked waiting rather than failed. Queue wait time and human approval time remain available in application run records, outside the measured execution spans.

Search by the trace ID or filter observation metadata by run/workspace IDs. Conversation IDs group agent turns as sessions; workflow run IDs group workflow attempts. Snapshot agent execution is also observed when called by evaluations or messaging, although this integration does not synchronize Quality datasets, customer feedback scores or prompt-management records into Langfuse.

## Inspect prompts, retrieved text and tool results

Metadata-only export is the default. To inspect content, explicitly enable:

```dotenv
LANGFUSE_CAPTURE_CONTENT=true
```

Restart both services. Model observations then include prompts/messages and streamed responses; retrieval observations include queries and selected passages; tools include sanitized arguments/results; workflows include redacted inputs/outputs. Content is bounded and can be truncated. Embedding vectors, model connections, HTTP authorization headers, cookies, database connection strings and stored secrets are never intentionally captured.

Credential-shaped structured fields and `sk-`/`pk-` strings are masked; tools also use their existing exact credential-value redaction. This is **not** comprehensive personal-data detection: free-text prompts, passages and results can contain customer information. Enable content only for an appropriate Langfuse project and retention/access policy. This setting applies to all workspaces handled by the process. If a generic OTLP destination is also configured, it receives the same content-bearing spans. Do not paste keys into chats for testing.

Langfuse receives explicit AI runtime observations only. Generic HTTP/database/filesystem auto-instrumentation is not sent to Langfuse, even when a separate generic OTLP destination is configured. Public chat behavior and attachment permissions remain unchanged.

## Troubleshooting

1. Confirm **both** terminal processes report enabled tracing. Missing environment configuration means no Langfuse exports. Updating `.env` requires a restart.
2. Confirm both project keys and the Japan instance URL match. Allow outbound HTTPS from API and worker to `jp.cloud.langfuse.com` (or your self-hosted instance).
3. Produce a new actual AI turn or workflow run, wait for batching, and clear Langfuse environment/date filters. Disabled knowledge/tools are intentionally skipped; human-only replies do not generate a model call.
4. For missing content, enable `LANGFUSE_CAPTURE_CONTENT=true`. Old metadata-only traces cannot acquire content retrospectively.
5. For missing worker traces, ensure the worker is running and has the same project configuration. A working API export does not establish worker connectivity.

Trace export is asynchronous; collector errors do not change customer answers or fail durable jobs. Graceful shutdown flushes pending observations. An abrupt kill or a prolonged collector outage can lose traces; application PostgreSQL run histories remain the durable record. Token usage is reported when the provider supplies it. Langfuse pricing depends on its recognized model catalogue; this integration does not invent token counts or provider prices.

Validation uses a local authenticated Langfuse-compatible OTLP collector and actual agent/tool/workflow fixtures. A live Langfuse project requires configured keys and outbound access.
