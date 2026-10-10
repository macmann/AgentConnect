# Enterprise operations — Phase 5 initial release

After pulling this release, run `pnpm db:migrate` and restart API, web and worker. Migration 0007 adds operations tables and deployment environments. No email or provider account is required to open the operations screens; usage appears after real runs.

## Workspace operations

Select **Operations** in the main menu. Reports cover the last 7, 30 or 90 days. Builders, operators and analysts can read reports; owner, organization administrator and workspace administrator can manage prices, API keys, webhooks and deployments. Analysts now have read-only conversation access. Viewers have no operational data access.

- **Analytics** shows conversation/run counts, completion/failure counts, provider-reported tokens, latency, feedback totals, per-agent usage and workflow outcomes.
- **Pricing** accepts explicit USD input/output rates per million tokens. Rates are copied to agent runs when they finish. Later price changes do not recalculate saved estimates. Missing prices or token counts remain unavailable; the report identifies excluded runs. Estimates cover priced agent runs, including usage reported by their tool planning. They exclude workflow agents, embeddings, tool service fees and provider invoice adjustments.
- **Members** changes workspace-scoped built-in roles. Organization roles remain inherited. Self changes are blocked. Only organization owners/admins can change or grant workspace administrators; workspace administrators can change lower workspace roles. Changes take effect on subsequent requests, including API key execution. Custom roles and ownership transfer are not implemented.
- **Deployments** assigns development/staging/production and promotes an immutable published agent version. Existing conversations retain their snapshots. Promotion rechecks public knowledge/tool access. Environment names are release labels, not infrastructure separation or additional authentication; hosted chat remains public with opaque continuation tokens.
- **Audit** displays the latest 100 matching workspace events, with an exact action filter. The API supports a `(before,beforeId)` cursor for older records. Review text, credentials and signing secrets are omitted from audit metadata.

## Conversation review

Open **Conversations**, filter by agent, last-run status, rating, playground/hosted channel and period, then select a thread. Pagination uses a timestamp/ID cursor. Rating filters match recorded reviews, not a computed latest consensus. Original messages and citations remain visible.

Builders, operators and administrators can select **Review response** on an assistant message. Add like/dislike, a classification, a comment or an expected response. Corrections require a reason and are stored as separate, append-only API records with reviewer and timestamp; they never rewrite the original answer or change runtime behavior. Analysts can read reviews but cannot create them. Up to 500 review records are returned per conversation. Public guest feedback, evaluation dataset export and applying corrections to knowledge are later extensions.

## Agent API keys

An administrator can create a key for one active agent, name it and choose a 1–365 day lifetime. Copy the plaintext from its one-time display. Metadata lists only a short prefix, scope, expiry, revocation and last use; the database stores SHA-256 of a random token. The key has only `agent:execute`, is bound to the selected agent/workspace and uses its issuer's current role. It executes the saved draft, not a published deployment. Keep the issuing account authorized or revoke/reissue under another administrator.

Send a server-side request to `POST /agents/{agentId}/chat` with `Authorization: Bearer <key>` and JSON `{"message":"Hello"}`. The response is SSE; HTTP 200 does not guarantee a completed provider response. Read the terminal `done` or `error` event. Continue using its `conversationId`. API keys cannot access model/secret registries, operations APIs or another agent. Cookie requests still require the trusted browser origin. Bearer authentication bypasses that requirement only on this exact chat endpoint, and invalid/revoked keys do not fall back to cookies.

Execution is limited to 30 requests/minute per key, in addition to the server-wide per-IP limiter. Revoke keys in Operations; expiry, revocation and loss of issuer execution privileges block new requests. Already running requests are not forcibly cancelled. This slice does not provide workspace-wide arbitrary scopes or publishable workflow API keys.

## Webhook delivery

An administrator can register an HTTPS endpoint after adding its exact hostname to `WEBHOOK_ALLOWED_HOSTS` in the API and worker environment and restarting them. Preserve existing allowed hosts. Query strings, URL credentials, fragments, private destinations and redirects are rejected. No host is approved automatically.

This release emits `agent.run.finished` for agent chat terminal outcomes persisted by the chat runtime. The transaction saving the run also queues delivery records. Payloads contain event ID, run ID, status and trace ID, without messages, feedback text or credentials. Interrupted-run recovery and workflows do not emit this event in this slice. Other product webhook event types remain future extensions.

The worker claims deliveries with PostgreSQL leases, sends with a 10-second deadline and records status, attempts, HTTP status and sanitized errors. A successful 2xx marks delivered. Network failures, 429 and 5xx retry with backoff for up to five attempts; other HTTP errors fail immediately. Expired leases are recovered, including a failed record after a crash on the fifth attempt. Failed deliveries can be manually retried when their webhook is enabled. Disabling prevents new queueing and claims; an in-flight request may finish. Re-enabling resumes pending deliveries.

The signing secret is encrypted and displayed only on creation or explicit rotation. Receivers must verify the exact raw body:

```text
X-AgentConnect-Id: <delivery UUID>
X-AgentConnect-Timestamp: <Unix seconds>
X-AgentConnect-Signature: sha256=<hex HMAC-SHA256>

signed bytes = timestamp + "." + raw JSON request body
```

Use a timing-safe comparison, reject stale timestamps, and deduplicate event IDs. Delivery is at least once: a crash or timeout after receiver acceptance can send the event again. A manual retry reuses the event ID. Rotation affects future sends, including retries; update the receiver before continuing delivery. This phase implements outbound signing, not an inbound webhook receiver or OAuth.

## Local acceptance scenario

1. Create a workspace model and agent, save it and chat in the playground.
2. Open Operations → Pricing and enter your provider's USD rates. Start a new chat, then check Analytics. The earlier unpriced run remains unpriced.
3. Open Conversations, inspect the new thread, record a dislike and expected response with a reason. Confirm the original answer remains intact and the correction appears separately.
4. Create an API key, copy it once, execute the selected agent from a server client, revoke it and confirm the next execution returns 401.
5. Publish the agent, create a hosted deployment and assign staging in Operations. Promote a published version to production; existing conversations keep their snapshots.
6. If an approved HTTPS receiver is available, register a webhook, verify its HMAC, run the agent and inspect delivery status. Registration alone does not establish live delivery.

Backend/browser tests use explicit fixtures. Live external receiver acceptance remains unverified. Production retention, custom roles, budget enforcement, broader filters/channels, public end-user feedback, workflow cost estimates and additional event types require later operations slices.


## Support enrichment roadmap

The [support roadmap](human-support.md) prioritizes product enrichment over deployment automation and additional monitoring. Phase A supports manual queues, exclusive claims and case histories through tenant-scoped APIs; the dedicated console and intelligent routing follow in B/C. No guaranteed staffing or notification is implied.
