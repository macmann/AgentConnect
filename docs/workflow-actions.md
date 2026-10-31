# Deterministic Actions and webhook triggers

AgentConnect continues to manage Agents, Knowledge/RAG, Tools/MCP, model providers, workspaces, authentication, Secrets and administration independently. Workflows orchestrate these resources. A Tool is available for an Agent/LLM to choose; an Action is explicitly invoked by a workflow. The two execution paths coexist and reuse security/transport infrastructure without sharing invocation policy.

## Definition and canvas

V2 Action nodes reference an entry in `execution.actions`. Existing read-only `agentconnect.tool/execute` and `agentconnect.mcp/execute` entries remain compatible. New connectors are `agentconnect.http` (operation is GET, POST, PUT, PATCH or DELETE) and `agentconnect.mcp-operation` (operation is a discovered MCP operation name). They use the existing runtime, queue, retries, leases and PostgreSQL checkpoints.

The Action drawer offers HTTP request, MCP operation or existing Agent Tool. Configure static inputs and mapped inputs, then map HTTP URL/headers/query/body from literals, previous steps, trigger/input or the resolved `arguments` object. Node mappings override Action defaults. Input and optional expected output schemas are bounded JSON Schema assertions. MCP input and output schemas are additionally enforced from discovered metadata and rechecked against live server metadata before every call.

Metadata includes operation, description, schemas, connection ID, timeout, retry, side effect (`read`, `write`, `delete`), risk (`low`, `medium`, `high`), idempotency, required permissions and configured scopes. Scope requirements must be a subset of connection/grant scopes. These administrator declarations do not independently prove a third-party OAuth token has those scopes.

## Connections and security

HTTP connections are workspace/organization scoped, configured under the canvas's saved connections controls by users with `tool:manage`. They reference existing encrypted Secrets; workflows never copy credential values. Supported authentication is none, bearer, API-key header or basic (the Secret contains `username:password`). The connection constrains the origin, base path and methods. Only compatible enabled connections appear for a selected HTTP method. Configuring a connection does not change existing Tools/MCP configuration.

HTTP endpoints retain existing private-host allowlists, DNS pinning, protocol/credential validation and redirect blocking. Private deployment endpoints must be explicitly allowed by existing deployment settings. Connection credentials cannot be mapped into URLs, headers, query or workflow data; credential/transport header names are rejected in user-configured headers. Auth is injected after request construction. Responses and failures pass through existing redaction with the actual credential and encoded variants. External response bodies and raw transport errors are not included in failure codes. Workflow payloads should never contain secrets.

MCP connections are the existing MCP server registrations and discovery results. Read-only discovered operations can be selected directly. Writes require an explicit administrator operation grant bound to its schema/annotation fingerprint, side effect, minimum risk and optional idempotency argument/scopes. Destructive operations require delete/high classification. Workflow authors also acknowledge side effects. Disabled grants, changed capabilities, revoked connections and cross-workspace references fail closed. A write grant does not make that operation available to Agents; Agent MCP Tool registration still rejects non-read-only operations.

Database integration uses friendly MCP operations such as `insert_invoice`, `read_invoice` or `update_invoice`, configured with field mappings. AgentConnect does not expose an unrestricted destructive SQL editor or add a second database client in this phase.

## Retries, replay and audit

Actions have a durable execution row unique to run/node and a row for each attempt. Inputs/configuration are fingerprinted, not recorded as raw request arguments. Completion and attempt status commit together. A completed Action returns its stored redacted output on worker replay; changed input/configuration conflicts rather than repeating it.

Reads may retry. Writes/delete default to one attempt and require explicit medium/high risk and side-effect acknowledgement. Automatic write retries require a connection declaring remote idempotency support or an MCP grant naming a string idempotency argument. A stable scoped hashed key is injected as HTTP `Idempotency-Key` or that MCP argument. The default key includes run/node identity; an explicit typed key can deduplicate across invocations of the same workflow/Action/connection/operation/URL. Only declare idempotency when the remote operation actually honors it. The workflow cannot provide an exactly-once guarantee for a non-idempotent remote system.

If a write without remote idempotency is interrupted after invocation, its outcome is recorded as `uncertain` with `ACTION_OUTCOME_UNKNOWN`. Worker recovery stops rather than repeating the side effect. Inspect the remote system and use an explicit recovery flow/new run after reconciliation. Retryable HTTP responses are 429 and 5xx; schema, connection-policy and capability errors do not become blind retries. Idempotent errors can still route via node `onError`.

Run details expose workflow/run, node, Action ID, connector, operation, connection ID, side effect, risk, idempotency classification, attempts, duration, status and sanitized error codes. Attempt history is independent of Agent Tool traces. Action outputs and audits follow existing run-retention policy; Action execution/attempt rows cascade with run deletion. Metadata contains no credentials or raw external error messages.

Limits reuse existing workflow budgets: 100–15,000 ms Action timeout, at most 3 attempts, 100–10,000 ms retry delay, at most 30 mapped inputs and 30 headers/query entries, 16 KB schema documents, 128 KB Action input/body/output budgets, existing bounded HTTP response size and workflow cancellation/deadlines. HTTP body is JSON; multipart/binary streaming and provider-specific OAuth refresh are outside this increment.

## Webhook triggers

The Input node's trigger section and existing workflow settings configure named webhook endpoints for a published immutable version, with request schema/sample, enablement and 1–365 day token expiry (90 days default). `POST /workflows/:id/webhooks` creates a token shown once; only its hash is stored. GET lists safe metadata. Configuration uses revision checks; rotation immediately invalidates the old token. Token responses are `Cache-Control: no-store`.

Call the generated `POST /workflow-webhooks/:id` endpoint with `Authorization: Bearer <token>` and a JSON body. Browser session cookies alone cannot invoke it. The issuer must retain current workspace execution permission and required verification; disabled/expired triggers and archived workflows reject calls. Queued/resumed webhook runs recheck trigger validity. Existing API keys, manual runs and schedules remain available.

V2 context includes `trigger.type = "webhook"`, `trigger.webhookId`, `trigger.test`, `trigger.body`, redacted `trigger.query` and only a normalized content-type header. Authorization, cookies and arbitrary request headers never enter workflow data. `input` also contains the normalized body. Payload schemas are checked before and after redaction.

Optional `Idempotency-Key` deduplicates requests per webhook; using the same key for different version/body returns 409. Enqueue is serialized by the webhook row lock. Workspace active-run limits and existing request rate/body limits apply. The authenticated Test sample control queues the selected published version with `trigger.test = true`, including while a trigger is disabled; it runs real workflow operations and should use safe test connections. Test runs are manual authorized runs, not bearer calls.

## Acceptance and deployment

`apps/api/test/workflow-v2.test.ts` contains a real durable acceptance graph: API input → Structured AI → Human Review/Edit → explicitly granted MCP database write → database read → typed total comparison → Complete or Human Error Review. A mock MCP server persists invoices and can return stale data. Both Actions can succeed while business validation takes the failure branch. Approvals survive saver restarts. No workflow-specific runtime logic is used.

Apply migration **0046** after existing **0045**, and deploy matching API/worker/web versions. It adds saved HTTP connections, MCP Action grants, Action execution/attempt audit tables, webhook configuration and webhook run identity. It does not rewrite published V1/V2 workflow JSON or Agent/KB/Tool/MCP configuration. Existing PostgreSQL, Redis, secret encryption, self-hosted endpoint policy and worker services remain sufficient.
