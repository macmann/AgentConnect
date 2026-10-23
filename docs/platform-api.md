# Platform API and MCP

Applications can invoke a published Agent Connex agent or retrieve raw knowledge matches using the REST API or the MCP Streamable HTTP server. Both interfaces use the same scoped key registry, authorization and runtime. No additional service, provider credential or MCP package installation is required on the platform server.

Install migration **0038** with `pnpm db:migrate`, then restart the API and worker.

## Create a key

Open **Operations → API keys** as a workspace administrator:

1. Select **Agent invocation** or **Knowledge search** and choose one resource.
2. Set a label and expiry (1–365 days).
3. Optionally enable **Allow execution details**. This authorizes requests for tool inputs/outputs and retrieval diagnostics. Treat it as access to private workspace evidence, including uncited passages.
4. Create the key and copy its one-time value into your application’s server-side secret store.

The UI creates `agent:invoke` keys for published agent execution or `knowledge:search` keys for one knowledge base. Keys are hashed at rest, inherit their issuer’s current permissions, expire and can be revoked. Neither a browser session cookie nor a widget/customer token authorizes these routes. Clients cannot select a different workspace, resource, system prompt, model or tool list through request fields.

REST clients use `Authorization: Bearer <key>`. Do not put keys in URLs, frontend bundles, public widgets or logs. Use HTTPS outside local development. Requests with an Origin header must match the configured console origin; server clients normally omit Origin. Publish an agent version before invoking it. Private knowledge does not need to be enabled for public hosted chat to be used by an explicitly authorized integration key.

### Existing integrations

Existing `agent:execute` keys and `POST /agents/:agentId/chat` retain their streaming draft-chat behavior. Those legacy keys also work with the new published-agent API and MCP, subject to their detail grant. New `agent:invoke` keys cannot call the legacy draft endpoint. When issuing a key programmatically through `POST /workspaces/:workspaceId/operations/api-keys`, explicitly set `scope: "agent:invoke"` for published-only access; omitting scope with `agentId` retains the legacy default for compatibility. Supply exactly one of `agentId` or `knowledgeBaseId`.

## REST endpoints

| Endpoint                                               | Purpose                                                   |
| ------------------------------------------------------ | --------------------------------------------------------- |
| `GET /api/v1/resources`                                | Describe the single resource and scope granted by the key |
| `POST /api/v1/knowledge-bases/:id/search`              | Return raw semantic or hybrid matches                     |
| `POST /api/v1/agents/:id/invoke`                       | Invoke a published agent and return JSON                  |
| `GET /api/v1/agents/:id/conversations/:conversationId` | Read this key’s conversation messages                     |

Requests are bounded to 60 per minute per key, with an additional shared IP limit. A `429` includes normal rate-limit headers. MCP initialization and discovery count as requests. Agent quotas and context controls also apply, with usage attributed to the key’s issuer. Resource access is rechecked on each HTTP request, including requests over an existing MCP client connection. Revocation blocks subsequent requests; an already executing request may finish.

See `/openapi.json` for REST request schemas. Responses are marked `Cache-Control: no-store`.

### Raw knowledge search

```sh
curl "$AGENT_CONNEX_URL/api/v1/knowledge-bases/$KNOWLEDGE_BASE_ID/search" \
  -H "Authorization: Bearer $KNOWLEDGE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"query":"What are the refund conditions?","mode":"hybrid","topK":5,"minScore":0,"includeDetails":true}'
```

Supported fields:

| Field            | Default / limit                                                                   |
| ---------------- | --------------------------------------------------------------------------------- |
| `query`          | Required; 1–4,000 characters                                                      |
| `mode`           | `hybrid`; `semantic` (alias for `vector`) or `vector`                             |
| `topK`           | 5; 1–30 matches                                                                   |
| `minScore`       | 0; 0–1 minimum semantic similarity, also applied to hybrid candidates             |
| `sourceIds`      | Optional; at most 100 source IDs within this knowledge base                       |
| `contentMode`    | `current` or `approved`; approval-required bases always enforce reviewed releases |
| `includeDetails` | `false`; requires the key’s details grant                                         |

Response shape:

```json
{
  "protocolVersion": 1,
  "knowledgeBaseId": "<uuid>",
  "query": "What are the refund conditions?",
  "mode": "hybrid",
  "results": [
    {
      "id": 1,
      "chunkId": "<uuid>",
      "documentId": "<uuid>",
      "sourceId": "<uuid>",
      "knowledgeBaseId": "<uuid>",
      "title": "Refund policy",
      "content": "Refunds are available within 30 days.",
      "page": 2,
      "heading": "Eligibility",
      "sourceUrl": null,
      "score": 0.86,
      "vectorScore": 0.86,
      "lexicalScore": 0.12,
      "rankingScore": 0.0328,
      "rrfScore": 0.0328
    }
  ],
  "durationMs": 120,
  "stages": []
}
```

Values above are illustrative. `score` and `vectorScore` are semantic similarity, not hybrid ordering. `rankingScore` is the value used for retrieval ordering; hybrid uses reciprocal rank fusion (plus the existing small Q&A preference). `rrfScore` is present for hybrid matches. Parent-context expansion follows the knowledge base’s existing settings and is indicated by `contextExpanded` when applicable.

With details enabled, `stages` includes `vector_search`, `lexical_search` (hybrid only) and `ranking_fusion`, with query, base identity, chunk/source IDs, ranks and scores. These stages precede final top-K selection. Raw KB search calls the embedding model but **does not call a chat model**, rewrite the question, rerank with an LLM or synthesize an answer. Ready-source, deletion and approved-release rules are identical to normal retrieval. Empty matches return an empty `results` array.

### Agent invocation

```sh
curl "$AGENT_CONNEX_URL/api/v1/agents/$AGENT_ID/invoke" \
  -H "Authorization: Bearer $AGENT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"message":"What are the refund conditions?","includeDetails":true}'
```

Fields: `message` (required, at most 16,000 characters), optional `versionId`, optional `conversationId`, and `includeDetails` (default false). Unrecognized configuration overrides are not supported.

A new conversation snapshots the latest published version, or the specified published `versionId` belonging to this agent. Pass the returned `conversationId` on later calls to retain context. It stays pinned to that version even after a new publication. A conflicting version on an existing conversation is rejected. Conversations are isolated by API key, including keys issued by the same person; rotating a key starts a new conversation namespace. Runtime state is durable, but there is no automatic replay or idempotency guarantee for agent invocations—check history before retrying an ambiguous lost response.

Responses contain:

- `protocolVersion`, `agentId`, `versionId`, `conversationId`, `messageId`, `runId`, `traceId` and `status`.
- `output`, `citations`, rich-response `blocks`, provider-reported `usage` and `retrievalMs`.
- `support` when the normal runtime explicitly starts a handoff; a conversation under human control rejects further AI invocations until normal support policy permits them. This API does not add human-operator messaging endpoints.
- With details enabled: `tools` and `retrieval`.

`tools` contains recorded execution IDs, tool IDs/names, inputs, sanitized results, status, error codes and timing. The tool runtime’s existing credential redaction and output bounds apply. Failures remain explicit rather than being represented as successful empty outputs.

`retrieval` contains:

- `diagnostics`: knowledge-use decision, rewrite/rerank outcomes and fallback codes.
- `stages`: vector, lexical and RRF records for every retrieval query, including original-query retrieval when rewriting is applied.
- `details.originalQuery`, `effectiveQuery` and `candidates`: the query and candidates entering reranking.
- `details.reranked`: ranked candidates with `rerankScore` when reranking succeeded; otherwise `null`.
- `chunks`: the final passages retained for answer generation after top-K and context-budget selection. Compare `chunkId` across stages; bracket-reference `id` values are local to their lists.

Optional stages that were skipped produce no fabricated data. If no retrieval occurred, `details` is null and `chunks` is empty. The runtime uses the agent’s configured usage policies, reranker (including configured Cohere/LLM providers), routing, failover, token budgets and tool restrictions. Requesting details does not invoke extra retrieval or model calls. Langfuse/OpenTelemetry tracing continues through the same runtime. System prompts, credentials, model connection settings and hidden security instructions are not returned.

Runtime failures return `output: null`, an explicit `error.code`, and the run/trace identity. Enabled details can show the tool or retrieval work completed before failure. Normal error statuses include `400` for invalid input, `401` for invalid credentials, `403` for scope/detail denial, `404` for inaccessible resources/conversations, `409` for missing publication/version conflict or an occupied conversation, `429` for limits, `502` for provider/runtime failure, `503` for response persistence failure and `504` for cancelled/timed-out generation. A grounding policy can validly return a no-answer message with completed status.

Agent generation uses the existing 90-second runtime deadline; raw search uses 30 seconds. Configure client and reverse-proxy timeouts accordingly. Closing a request cancels generation; completed work remains subject to the runtime’s persistence and quota rules.

## MCP

Connect a Streamable HTTP MCP client to:

```text
https://<your-api-host>/mcp
```

Configure the same Bearer header used for REST. The server is stateless at the transport layer; application conversation state is kept in PostgreSQL. No sticky sessions or process-local session IDs are needed. GET event streams and DELETE sessions are unsupported (405). POST initialize, notifications, tool discovery and tool calls follow the MCP SDK protocol.

Only the tool granted by the key is advertised:

| Key scope                                  | MCP tool           | Arguments                                 |
| ------------------------------------------ | ------------------ | ----------------------------------------- |
| `agent:invoke` (or legacy `agent:execute`) | `agent_invoke`     | Same JSON fields as REST agent invocation |
| `knowledge:search`                         | `knowledge_search` | Same JSON fields as REST knowledge search |

The resource ID is bound by the key, so MCP callers do not need to supply it. Results are returned in `structuredContent` and as JSON text content. Operational failures set `isError: true`. Returned agent messages, tool outputs and document text are untrusted reference data, not client instructions.

Example with the official TypeScript MCP client:

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "my-application", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(
  new URL(`${process.env.AGENT_CONNEX_URL}/mcp`),
  {
    requestInit: {
      headers: {
        Authorization: `Bearer ${process.env.AGENT_CONNEX_API_KEY}`,
      },
    },
  },
);
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const answer = await client.callTool(
    {
      name: "agent_invoke",
      arguments: {
        message: "What are the refund rules?",
        includeDetails: true,
      },
    },
    undefined,
    { timeout: 120000 },
  );
  console.log(answer.structuredContent);
} finally {
  await client.close();
}
```

For a knowledge key, call `knowledge_search` with `{ query, mode: "hybrid", topK: 5 }`. Use `conversationId` on subsequent `agent_invoke` calls to retain context. Clients supporting header-based Streamable HTTP connections can connect directly; OAuth discovery/sign-in, stdio transport and workspace-wide wildcard keys are not part of this implementation.

### Metadata-filtered knowledge search

Both REST KB search and the MCP `knowledge_search` tool accept `metadataFilter: { tagsAll: ["policy"], attributes: { product: "loans" } }`. All tags and string attributes must match, case-sensitively. Filters run before candidate ranking and combine with source IDs, release rules and key permissions. Raw chunks return `tags` and `attributes`. Published knowledge searches use the release's metadata snapshot; older snapshots without tags do not match nonempty filters. Agent invocation uses the filters saved in its published configuration. See [Source tags and metadata filters](rag.md#source-tags-and-metadata-filters) for limits and examples. Apply all migrations through 0040 and restart the API and worker when upgrading to the metadata-tagging release. See the [metadata tagging guide](metadata-tagging.md).

Metadata management and suggestion-review endpoints require an authenticated workspace session with knowledge-management permissions. Resource API keys and MCP search tools grant retrieval access, not metadata editing.
