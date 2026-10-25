# Conversational retrieval and bounded context

The knowledge planner still decides whether retrieval is needed. Once selected,
the runtime now follows this flow for agent chat and workflow agent steps:

1. **Contextual rewrite:** resolve follow-ups using at most six recent messages,
   each capped at 2,000 characters. Use strict JSON `{"query":"..."}` with
   temperature zero, at most 512 output tokens (also bounded by the agent output
   limit), and a five-second deadline. The rewriter must not answer, invent a
   full name or add unsupported scope. Any rewrite failure searches the original
   query; user cancellation still cancels the request.
2. **Hybrid search:** embed the effective query and search its lexical terms.
   Normal-language lexical queries use a bounded OR of meaningful terms so every
   filler word in a rewritten sentence need not occur in the document. Explicit
   quoted/negative/web-search expressions keep their existing syntax.
3. **RRF fusion:** retain both vector and lexical candidate lanes, with the
   existing RRF constant and approved-Q&A policy. Pass the candidate pool through
   optional reranking before selecting seeds. Rerank against the contextual query.
4. **Expansion:** comprehensive requests such as tasks, lists, responsibilities,
   history and summaries can fetch a bounded previous/next window around seeds.
   A question about one numbered week stays narrow unless it explicitly requests
   all weeks. Existing knowledge-base parent-context expansion remains supported.
5. **Context assembly:** deduplicate identities and identical/contained text,
   fit whole passages within the chunk/token budget, group selected chunks in
   document order, and remove only substantial exact suffix/prefix overlap.
   Emit stable reference numbers into the existing `<reference_passages>` prompt.
   Never summarize away facts or invent the missing parts of a timeline.

## Configuration

Defaults in `.env.example` and the Coolify stack:

```dotenv
QUERY_REWRITE_ENABLED=true
RAG_NEIGHBOR_EXPANSION_ENABLED=true
RAG_NEIGHBOR_PREVIOUS=1
RAG_NEIGHBOR_NEXT=1
RAG_MAX_CONTEXT_CHUNKS=6
```

Previous/next counts range from 0–3; the context cap ranges from 1–20. Restart API
and worker after changing their environment. These values do not change any
minimum-score setting.

Existing per-agent settings remain authoritative for the retrieval mode,
`rag.topK` seed limit (default 5), `rag.candidateCount` candidate pool (default 15),
reranker, source filters, release pins and Q&A policy. Neighbors are additional
context within the final cap. Specific requests do not expand neighbors. Existing
tokenizer/context-window and knowledge budgets further bound selected content.

`rag.contextualRewrite` optionally disables conversational rewriting per agent;
when absent it is enabled. The Configure → Knowledge advanced setting exposes
this control. Existing `rag.queryRewrite` enables rewriting standalone questions
as well. The environment switch disables both types. Original messages stored in
the conversation are never replaced by search rewrites.

**The configured `rag.minScore` and `rag.qaMinScore` values and their semantic
eligibility rules are unchanged.** A direct lexical candidate below the semantic
minimum still has `eligible:false`; operators can see both raw scores and tune
the existing threshold themselves. A neighbor is authorized surrounding context,
not an independently scored search hit: it carries `neighborOf`, a real ordinal,
and zero independent similarity scores rather than fabricated evidence scores.

## Version and access safety

Live ingestion already records `knowledge_chunks.ordinal`. Migration **0042**
adds the ordinal to immutable `knowledge_release_chunks` snapshots, an index,
and a conservative backfill from surviving identical live chunks. New releases
copy ordering automatically. No chunker rewrite or routine reingestion is needed.

Historical release chunks that cannot be matched safely retain a null ordinal.
They remain searchable and citable, but neighbor expansion skips them. Publish a
new reviewed release to capture order when those older snapshots need expansion.
Never guess historical ordering from UUIDs.

Neighbor lookup anchors on the actual seed chunk and checks tenant/workspace,
knowledge base, source, document, revision, release status/pins, public access,
metadata filters and source availability. It cannot cross into another logical
document even when both documents belong to the same source. Edited/deleted
sources and unavailable releases are not used as an expansion shortcut.

Apply migration 0042 before starting the updated API/worker:

```sh
pnpm db:migrate
```

The Coolify bootstrap runs migrations automatically.

## Langfuse example

For `how about Waing`, when the recent transcript establishes the task question
and the full name **Waing Maw Oo**:

```text
agent.chat / workflow.agent
├── knowledge.planning
├── knowledge.query_rewrite
│   input:  originalQuery="how about Waing", bounded history
│   output: rewrittenQuery="What are all tasks assigned to Waing Maw Oo across all weeks?"
│   model, query.rewrite_used=true, query.rewrite_fallback=false,
│   query.rewrite_latency_ms
├── knowledge.search
│   └── knowledge.retrieval
│       ├── knowledge.embedding       effective query
│       ├── knowledge.vector_search   chunk IDs, ranks, scores
│       ├── knowledge.lexical_search  chunk IDs, ranks, scores
│       └── knowledge.ranking_fusion
│           chunkId, vectorRank, vectorScore, lexicalRank, lexicalScore,
│           rrfScore, final score, eligible
├── knowledge.reranking               when enabled
├── knowledge.neighbor_expansion
│   seedChunkIds, expandedChunkIds, sourceIds, reason=comprehensive_query
├── knowledge.context_selection
│   candidateCount, selectedCount, selectedChunkIds,
│   estimatedContextTokens, breadth, maxChunks
└── model.generate
    reference passages include the earlier and later week chunks
```

Counts, identifiers and timing metadata are exported without conversation text.
Set `LANGFUSE_CAPTURE_CONTENT=true` only when content export is intended to see
original/rewritten query values and passage content. Existing bounded/redacted
content-export behavior is preserved. The rewrite span reports fallback as an
expected outcome; retrieval continues rather than failing the answer.

Tests in `apps/api/test/conversational-rag.test.ts` cover contextual entity/week
follow-ups, malformed/failed rewriting, bounded history and trace content,
Weeks 9–16 context construction, narrow Week 14 queries, access/revision/release
isolation, unchanged thresholds, budgets and overlap deduplication.
