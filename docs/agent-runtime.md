# Single-agent runtime

Phase 1 implements model registration, agent CRUD, structured or advanced prompts, streaming playground, conversations, immutable publication and hosted chat. The runtime and provider SDK are separate packages; the single-agent runtime does not yet use LangGraph. Graph workflows are Phase 4.

## Connect a provider and deploy

1. Register, verify your email, and create an organization/workspace.
2. In **Secrets**, save a provider API key as an encrypted workspace secret. Never paste credentials into chat or commit them. Values are not returned to the browser.
3. In **Models**, register OpenAI, Anthropic, Google Gemini or an approved OpenAI-compatible endpoint. Select the encrypted secret and enter a model identifier available to your account. Set its actual context/output limits and supported temperature/top-p parameters; these are operator declarations, not automatic model discovery. Hosted providers require a secret; compatible local servers may omit it.
4. Test the connection. In **Agents**, create an agent, configure its model, prompt and settings, then save the draft.
5. Open **playground** and send a message. New chats snapshot the saved draft; continuing chats retain their original settings. Unsaved changes must be saved before opening playground or publication.
6. **Publish** the saved draft, create a hosted deployment from that version, then open hosted chat. Publication freezes prompt, model configuration and credential reference. Restore draft changes the editable draft and leaves deployed versions intact. Disable deployment to remove public access; archiving an agent disables its deployments.

Workspace administrators manage models and credentials. Builders create, execute and publish agents. Operators can inspect conversations. Viewers can read agent definitions but cannot execute them. Authorization is enforced in API code, independently of model output.

## Provider transport

Adapters stream real HTTP responses from OpenAI chat completions, Anthropic messages and Gemini streamGenerateContent. Compatible providers use the chat-completions protocol. Unsupported declared sampling parameters are omitted. A provider API/model that rejects this protocol requires an adapter change; reasoning-only and non-streaming models are not universally supported.

`MODEL_ALLOWED_HOSTS` defaults to the three official provider API hosts. Compatible endpoints require explicit server approval. HTTPS, exact hostname/port checks, private-address rejection, direct DNS pinning and no redirects prevent arbitrary outbound fetches. `MODEL_PRIVATE_HOSTS` is an explicit host:port exception for trusted private model servers, empty by default. Hosted traffic honors the cloud outbound proxy. Cloud egress must also permit the destination. Requests include secret values only in provider authorization headers.

## Streaming and persistence

POST chat returns SSE protocol version 1: `meta` (conversation/run/trace IDs), `token`, then `done` or `error`. Anonymous hosted conversations also receive an opaque token in `meta`; continuation requires it in Authorization Bearer. Tokens remain in page memory, are hashed in storage and disappear on reload. Public deployment metadata omits prompts, provider settings and credential references.

Runs store user input before provider execution and save assistant output, status and available provider-reported token counts afterward. Missing usage remains null; no token counts or pricing are invented. Provider error bodies and credentials are not exposed. Abort on disconnect and a 90-second timeout cancel upstream work. Concurrent responses in one conversation return 409. Interrupted processes leave no guaranteed final output; startup and minute-by-minute recovery mark runs older than five minutes failed and release their conversation locks.

History is bounded by configured message count and a conservative UTF-8 byte budget. This is not a model-specific tokenizer. Trace spans include tenant/resource IDs and provider/model identity, without explicit message content or authorization headers. Configure an OTLP collector for external traces.

## Validation limits

API tests inject an explicit provider fixture; adapter tests use protocol fixtures and actual local HTTP transport. Browser tests exercise editing, chat, cancellation, conflicting requests, publication and anonymous continuation through an explicit local HTTP fixture. Production code has no fixture mode. No live provider credential is available in this environment, so external provider acceptance and billing behavior remain unverified.

Public chat currently has per-IP rate limits. Organization spending caps, bot protection, moderation, retention jobs, production observability review and enterprise KMS are later hardening work. Avoid exposing an unrestricted paid deployment before those controls match your requirements.

## OpenAI request compatibility and connection diagnostics

The OpenAI provider uses the fixed `https://api.openai.com/v1` base URL and Chat Completions API with `max_completion_tokens`. OpenAI-compatible providers retain `max_tokens`. Selecting OpenAI does not select a model or prove that a model ID is available to the API project attached to your selected workspace credential. Use the exact provider API identifier and confirmed account access; model names exposed in other products are not an API availability guarantee.

Connection tests request at most 1,024 completion tokens, bounded by the registered model limit, rather than the registry's entire maximum. This provides room for models whose completion budget includes reasoning tokens. A test that returns no visible text is reported as `EMPTY_PROVIDER_RESPONSE`, not Connected. Generative chat and ordinary agent execution still use the agent's separately configured output budget.

If a provider rejects the request, the UI includes the HTTP status and recognized provider error code/parameter when available. `model_not_found` indicates an unavailable identifier or account/project access; a rejected `temperature` or `top_p` parameter requires checking the corresponding model capability and disabling it if unsupported. Supported sampling behavior remains configurable rather than being guessed from a model-name prefix.

The API terminal emits **Model connection test failed** with status, recognized code/parameter and request configuration metadata. Chat failure logs include the same recognized details. Provider response messages/bodies, credentials, prompts and arbitrary provider error fields are excluded. Diagnostics read at most 16 KB and retain only fixed allowlisted identifiers. Embedding HTTP errors also preserve status and the same safe structured metadata. Protocol tests do not establish live-provider acceptance.

## Tool and knowledge usage policies

Configure → Tools and Configure → Knowledge each provide **Usage policy** and **Usage instructions**. Both are saved in the existing agent draft (`tools.usageMode` / `rag.usageMode`, and `usageInstructions`), then snapshotted through the normal publication and conversation lifecycle. Start a new Playground chat after saving to test the updated policy; published channels and workflow agents use their published snapshots.

- **Automatic:** a model decides relevance before using attachments. Tool planning may return no calls. Knowledge planning uses the bounded conversation history, Agent prompt, attached knowledge names/descriptions and knowledge usage instructions; a skipped search performs no embedding or retrieval.
- **Always:** attached knowledge is retrieved for every message. Tools require at least one relevant, valid call within the existing call limit; they do not execute every attachment blindly. If no safe call is selected, the run fails with `TOOL_REQUIRED`.
- **Disabled:** attachments remain saved but no tool planner, execution, knowledge planner or retrieval runs for that attachment type.

Example knowledge instructions: “Search knowledge for product policies and procedures. Skip greetings, thanks and general conversation.” Example tool instructions: “Use web search for current information; skip questions answerable from approved knowledge.” Automatic decisions are model-guided, not deterministic keyword rules. They do not change tenant permissions, public access rules, tool schemas or read-only restrictions. Tools and knowledge have separate decisions; this does not implement a knowledge-first fallback chain.

Existing configurations retain **Automatic tools** and **Always knowledge**, with empty usage instructions. No database migration is required. Automatic knowledge adds a small provider call and its actual token usage is included in run totals. Invalid knowledge decisions fail with `KNOWLEDGE_PLAN_INVALID`; required retrieval still enforces relevant sources and citations. Private operator copilot requests remain explicit operator actions with their own grounding behavior.
