# Troubleshoot empty and invalid model responses

Deploy matching API and worker versions after updating. No migration or additional logging environment variable is required. Production failures emit an `Agent chat failed` structured warning with `runId`, `traceId`, provider/model, routing attempts, sampling/output settings and the fields below. Connection-test warnings also include stream diagnostics. These fields do not require Langfuse content capture.

## Empty provider response

`EMPTY_PROVIDER_RESPONSE` means a completed provider stream had no non-whitespace visible text. It does not mean knowledge was missing. Inspect `providerStream`:

- `modelId`, `provider`, `hostname`: actual failed stream's destination, including when model routing used a fallback. The old warning could describe only the primary model. `configuredModelRegistryId` and `modelRouting` identify the configuration and attempted models.
- `finishReason`: allowlisted termination reason (`length`, `stop`, etc.; unexpected values become `unknown`).
- `frameCount`, `responseFormat`, `responseStatus`: distinguish a real event stream from a JSON/non-stream response or a stream that ended before text arrived.
- `contentCharacters`, `reasoningCharacters`, `reasoningTokens`, `inputTokens`, `outputTokens`: content/usage evidence where the provider reports it. Unreported usage remains null. No reasoning text is logged.
- `refusalObserved`, `toolCallsObserved`, `nonTextContentObserved`: indicate an unsupported or non-text response without logging refusal text, tool arguments or response bodies.

A `length` finish with zero content and high reasoning-token usage suggests the model exhausted its budget before producing a visible answer. Confirm that evidence before changing limits. A completed stream with only tool calls, refusal, or non-string content needs a compatible provider/model/output configuration. A JSON response format from a streaming endpoint points to an API/proxy compatibility issue. Test a short plain-text request in Models; compare a new conversation after model changes because existing conversations retain snapshots. Register the exact provider model ID and correct base URL. Never infer that a model or credential works merely from a saved configuration.

## Rich-response failure

`INVALID_UI_RESPONSE` means rich-response processing rejected the generated result. Inspect `responseValidation`:

- `stage=json`: generated text was not valid JSON. `format=code_fence` identifies fenced output without revealing its contents.
- `stage=schema`: JSON did not match the rich-response envelope. `issueCodes` contains bounded schema issue codes, without field values or upstream error text.
- `stage=allowed_blocks`: a schema-valid block type was disabled for this agent.
- `stage=artifacts`: parsing passed, but generated-file/artifact preparation failed.

`outputCharacters` records the original size even though invalid output is discarded. A model that does not reliably produce the required envelope should be tested with Rich responses disabled or replaced with a model that supports structured output. This change does not fabricate content, append citations or accept invalid JSON.

## Where to find evidence

1. API container stdout/stderr: filter `Agent chat failed` by run/trace ID. Warning-level logs must be retained by the deployment's log collector.
2. Langfuse error observations: `provider.stream.*` and `response.validation.*` attributes are emitted even when content capture is disabled. Existing tracing credentials and export configuration still apply.
3. Authorized run/context inspection: `agent_runs.context_breakdown.failureDiagnostics` preserves the same safe details for failed chat runs. Existing data-retention rules apply.

Raw prompts, answers, reasoning, credentials, response headers and upstream bodies are excluded from these diagnostic fields. `LANGFUSE_CAPTURE_CONTENT=true` separately controls existing opt-in transcript capture; it is not needed to obtain the new diagnostics. Historical runs cannot be retroactively enriched; reproduce once after deployment.
