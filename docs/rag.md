# Knowledge and RAG

Phase 2 implements knowledge bases, document upload, manual text, curated Q&A, bounded website crawling, durable ingestion, hosted/custom embeddings, pgvector retrieval, citations, a retrieval playground and knowledge attached to agents.

## Use it

1. Save an embedding-provider key under workspace **Secrets**. OpenAI and Gemini embedding adapters are supported; an approved OpenAI-compatible embedding server may omit a key.
2. Open **Knowledge**, register an embedding model, select its actual dimensions and test the connection. Dimensions are limited to 1–2000 for the current HNSW vector index. OpenAI text-embedding-3 and Gemini requests include the declared output dimensions; compatible models must already return that dimension. Other OpenAI embedding models must use their native dimension.
3. Create a knowledge base with that model and character-based chunk size/overlap. The embedding model, dimension and chunk configuration are fixed; create a new base to change them. This avoids mixing incompatible vectors.
4. Upload a source or add manual text/Q&A. Source status moves through queued, processing and ready. Failures show a sanitized error code and allow reingestion. Only ready sources participate in retrieval.
5. Use **Retrieval playground** to inspect passages, cosine similarities, original query, context-size estimate and latency. Hybrid mode fuses semantic and PostgreSQL full-text candidates using reciprocal rank fusion; vector mode uses cosine distance. Curated Q&A receives a small hybrid tie-break preference.
6. In **Agents**, select knowledge bases, passage count, minimum similarity and retrieval mode. Save, chat, publish and inspect expandable citation passages in playground, conversation history and hosted chat.

Knowledge defaults to internal use. Public deployments require every attached base to explicitly enable public hosted chat access. That setting permits retrieved passages to be shown anonymously. Turning it off blocks subsequent public retrieval. Agents keep their published configuration but retrieve the current ready knowledge; publication does not freeze document contents.

## Sources and parsers

The parser registry supports PDF, DOCX, PPTX, XLSX, CSV, TXT, Markdown, HTML and JSON. TXT must be UTF-8. Markdown headings, PDF pages, slide numbers and sheet identifiers are retained. Office tables are represented as flattened text/rows; the current parsers do not reconstruct rich document layout. HTML drops active script/style/iframe content. Extracted text and generated responses render as text in the UI.

Limits: 10 MB per uploaded file, 2 million extracted characters, 500 chunks per ingestion job, 200 PDF pages/slides, 100 sheets, 30 MB expanded Office archives, and 2000 archive entries. Empty/scanned PDF text fails explicitly; OCR, image/audio/video extraction and richer layout preservation remain future parser extensions. XML entity declarations are rejected. Parsing occurs in the separate ingestion worker process; enterprise parser sandboxing and broader malicious-file validation remain hardening work.

Q&A supports create/edit/delete, tags and CSV import/export. CSV columns are `question,answer,tags`; `|` separates tags. Imports validate all rows first and accept at most 100 rows. Storage/transaction failure can leave a partially created import; successful rows remain individually visible. Export escapes spreadsheet formula prefixes. Source reingestion replaces its documents/chunks in one database transaction after all embeddings are ready. Previous chunks are excluded while a source is queued or processing.

## Website ingestion

Single-page and same-origin recursive crawling are supported, bounded to 20 pages and depth 3 with allowed/blocked path prefixes. Canonical URLs remain same-origin and preserve source provenance. The crawler respects robots.txt, uses `AgentConnectKnowledge/1.0`, rejects redirects, requires HTML, and caps page/robots response sizes. A robots 404 permits crawling; other HTTP errors fail the job. This is a static HTML crawler; browser rendering, scheduled refresh and connector synchronization are later extensions. Manual reingestion refreshes the source.

Website hosts are empty by default. Set exact `KNOWLEDGE_ALLOWED_HOSTS` in the API/worker environment and permit those domains in cloud network settings. Private servers require an explicit `KNOWLEDGE_PRIVATE_HOSTS=host:port` exception, empty by default. Provider traffic separately uses `MODEL_ALLOWED_HOSTS`. HTTPS, private-address rejection, direct DNS pinning, exact destination approval and the inherited cloud proxy constrain requests. Do not broaden access to arbitrary destinations to make a crawl succeed.

## Durable worker and storage

Original inputs and fetched pages use tenant-prefixed private S3-compatible object keys. PostgreSQL stores sources, document revisions/provenance, chunks, embedding spaces and jobs. Each knowledge base has a dimension-specific partial HNSW cosine index; full-text search has a GIN index. Composite foreign keys enforce tenant and embedding-space identity.

The worker runs independent mail, ingestion and object-cleanup loops. Ingestion claims jobs using `FOR UPDATE SKIP LOCKED`, stores a unique lease token, renews a two-minute lease, and stops at a five-minute deadline. Expired leases recover; retryable provider/website failures use persisted backoff with at most three attempts. A transaction checks lease, source revision and archive state before publishing results. Superseded jobs cannot replace a newer source revision.

Deleting sources or archiving a base immediately removes searchable chunks and cancels pending jobs. Durable source tombstones queue all raw source objects for purge after a ten-minute grace period, allowing in-flight jobs to stop. Purge failure leaves the tombstone pending for retry. Old revisions of an active source remain in its object prefix until deletion; configurable retention/version cleanup belongs to the operations phase. This queue is a tested PostgreSQL outbox implementation, not a Temporal ingestion workflow.

## RAG tool and citations

`packages/rag` defines the built-in RagTool interface and source/citation structures. `PostgresRagTool` enforces the workspace/public boundary, embeds queries using the base's fixed model, retrieves ready chunks and assembles bounded passages. Existing agents retrieve before generation whenever knowledge is attached. Configure → Knowledge now supports Automatic (a relevance decision before retrieval), Always (required retrieval), and Disabled (retain attachments without retrieval), with usage instructions. See [usage policy details](agent-runtime.md#tool-and-knowledge-usage-policies).

Reference passages are framed as untrusted data with explicit grounding instructions. SSE sends retrieved sources, then tokens and terminal results. Completed responses must include valid `[n]` references by default; only actually referenced retrieved chunks become persisted/displayed citations. Unknown references and required-but-missing citations fail the run. No relevant passages fail before generation. A citation includes chunk/document/source/base identity, title, available page, canonical URL, passage text and relevance score.

Reference validation does not prove that every generated claim is entailed by its source. A failed streamed answer may already have displayed partial text; the terminal error marks it unsuccessful. Automated faithfulness checks, query rewriting, semantic/token-aware chunking, reranking and citation-quality evaluation are later extensions. Context tokens are estimates, not tokenizer measurements. Dataset-scale latency/load and recall benchmarks are not yet established.

## Validation

Fixture-backed tests exercise actual PostgreSQL/pgvector, S3 objects, PDF/Office extraction, lease recovery/backoff, dimension rejection, tenancy, robots/redirect restrictions, citation persistence and public access revocation. Browser tests use explicit local HTTP embedding/chat protocol fixtures and the actual compiled ingestion worker. No production mock mode or deterministic embedding fallback exists. Live hosted embedding/generation acceptance remains unverified because provider credentials are absent and the cloud egress changes are a draft.
