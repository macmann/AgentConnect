# Model routing and retrieval enhancements (priorities 11–12)

These settings extend the existing agent configuration. Existing agents keep their primary model and retrieval behavior until an enhancement is enabled. Apply migration 0027 with `pnpm db:migrate` and restart services.

## Model routing and controlled failover

In **Agent → Configure → Advanced → Model routing and failover**, select a lighter workspace model and enter approved query phrases, one per line. Matching is exact after trimming, collapsing spaces and ignoring capitalization. A short message alone does not qualify. Routing defaults to the first conversation turn only; later turns can be enabled explicitly. Choose phrases that the lighter model can handle reliably and verify them in Playground and Quality evaluations.

The primary model handles other queries. Each request gets the selected model's credentials, sampling capabilities and context/output limits. A lighter model that cannot fit the request uses the primary model without sending the oversized request. Attached knowledge, approved releases, grounding, citations and tool policies remain the same.

Configure up to two ordered fallback models, including another provider. Transient network errors, first-token timeouts and provider HTTP 5xx errors can trigger fallback **before any nonempty text token**. Rate-limit fallback is separately opt-in; known exhausted-account quota errors do not qualify. Authentication errors, missing credentials, invalid parameters, blocked responses, customer cancellation and failures after text starts do not trigger fallback. Partial output is never replayed. A lighter route may use primary first, then the configured fallback chain; there are no cycles or unlimited retries. The existing overall chat deadline still applies.

Saved drafts validate all selected models. Published versions, evaluations and new conversations freeze their model definitions, including alternatives. Changes in Models require a new agent version/new chat to take effect. Credentials remain encrypted workspace secrets; snapshots contain references, never API keys. Drafts referencing primary, lighter or fallback models prevent deletion of those models.

The same routing applies to model calls made during that agent run, including planning and retrieval enhancement calls. Tools and retrieval are not restarted when a model call falls back. Workflows and quality evaluations use the same execution path.

Private Playground **Token and context breakdown** shows selected model, attempt outcomes/error codes, per-model usage and retrieval enhancement status. Provider usage is used when supplied; otherwise token accounting conservatively estimates the attempted input and emitted output. Daily quotas reserve capacity for the configured fallback chain and extra retrieval calls, then settle all attempts. Reported costs use each attempted model's configured price, with blended rates for aggregate reports; missing prices remain unknown. Provider serialization/tokenizer differences and failed upstream billing make these estimates rather than invoices.

## Query rewriting and reranking

In **Agent → Configure → Knowledge → Advanced retrieval settings**:

- **Rewrite follow-up questions for search:** recent conversation turns help turn references such as “And its rate?” into standalone search queries. Both the rewrite and original query are searched and their bounded candidate pools are merged. The answer still uses the original question.
- **Rerank retrieved passages:** the configured chat model scores a candidate pool of 5–30 passages against the original question. The best candidates become the final configured number of retrieved passages. This is model-based reranking, not a dedicated cross-encoder service.

Each option adds a bounded model call and its usage is counted. Rewrite/ranking JSON is validated strictly. A malformed result or an enhancement-call failure falls back to the original query or existing retrieval order. Cancellation and access/retrieval errors propagate. Rankings cannot invent sources, expand access or bypass minimum similarity, approved-release, public-access or citation rules. Token budgets apply to enhancement calls even when general context optimization is disabled; oversized rerank inputs retain retrieval order. Auxiliary output limits are capped by the agent output limit.

## Table retrieval

Newly ingested CSV/XLSX tables keep column labels with each row. XLSX sparse cells retain column positions, and workbook relationships preserve sheet names. DOCX tables receive their own table sections; HTML tables retain labeled row content. Table chunks retain page/sheet/heading provenance and repeat a compact column header. Rows normally stay together; an individual row larger than the chunk size is split. The first row is treated as the column header; verify unusual spreadsheets or multi-level headers in source previews.

PDF text extraction preserves lines and noticeable column gaps using text positions. This improves table context but does not reconstruct every complex or merged-cell PDF table. Reindex existing sources to use the new parsing/chunking behavior. For approval-required knowledge, review and publish a new release; existing approved releases remain frozen.

## Optional scanned-PDF OCR

Enable **Recognize scanned PDF pages with OCR** in Knowledge creation/settings, then enable `OCR_ENABLED=true` on the worker. Install `poppler-utils`, `tesseract-ocr` and English language data on that machine. For the production worker image, build the `worker` Docker target with `--build-arg ENABLE_OCR=true`; the default image omits these optional packages.

OCR runs locally on PDF pages containing fewer than 20 non-whitespace extracted characters. It preserves page references and records which pages were recognized. No document is sent to an external OCR provider. Recognition is English-only in this iteration, capped at 20 scanned pages per document, with bounded rendering dimensions, file sizes and execution time. The ingestion job retains its existing overall deadline. Missing executables/server opt-in, recognition errors and limits produce explicit source failure codes. Mixed PDFs without OCR expose a warning for pages that may have unrecognized scanned content.

Reindex to apply changed OCR settings. Review recognition accuracy, numbers and tables before releasing knowledge. OCR does not guarantee complex table reconstruction and does not cover standalone image uploads.

## Validation

Regression coverage includes exact routing and workspace-scoped immutable snapshots, cross-provider transient fallback, blocked errors/partial output/cancellation, lightweight context checks, per-model cost calculations, retained original search evidence, strict reranking identities, sparse spreadsheet columns and scanned-PDF provenance/limits. A local OCR integration test runs when Poppler and Tesseract are installed. Browser coverage exercises the configuration controls alongside reviewed knowledge, grounded hosted chat and widget support handoff.

Verified in this implementation: 362 API tests passed, followed by 77 targeted regressions for routing, quotas, customer insights, quality, workflows and support triage. All 12 feature tests passed again after the OCR temporary-directory refinement, including actual Poppler/Tesseract recognition. The browser scenario verified persisted routing/OCR settings, successful rewriting/reranking diagnostics, grounded hosted responses and widget handoff. Production build, type checks, lint and repeat migrations passed.
