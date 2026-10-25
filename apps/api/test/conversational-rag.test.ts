import { capturedSpans } from "./tracing-fixture.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { agentConfig } from "@agentconnect/schemas/agents";
import type { Citation, RagTool } from "@agentconnect/rag/tool";
import { groundedPrompt } from "@agentconnect/rag/tool";
import {
  retrievalBreadth,
  selectContext,
  lexicalSearchQuery,
} from "@agentconnect/rag/context-selection";
import type { ChatProvider, ChatMessage } from "@agentconnect/provider-sdk";
import { enhancedRetrieval } from "../src/rag-enhancements.js";
import { PostgresRagTool } from "../src/knowledge-core.js";
import { sql, closeDb } from "../src/db.js";
import { config } from "../src/config.js";
import { knowledgeContextBudget } from "../src/context-control.js";
import { modelSnapshotSchema } from "../src/agent-models.js";

if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  workspace = randomUUID(),
  foreign = randomUUID(),
  model = randomUUID(),
  kb = randomUUID(),
  source = randomUUID(),
  otherSource = randomUUID(),
  document = randomUUID(),
  otherDocument = randomUUID(),
  sameSourceDocument = randomUUID(),
  previous = randomUUID(),
  seed = randomUUID(),
  outsider = randomUUID(),
  sameSourceChunk = randomUUID(),
  release = randomUUID(),
  author = randomUUID();
const context = {
  workspaceId: workspace,
  organizationId: org,
  publicAccess: false,
  rewriteModel: "fixture-rewriter",
};
const signal = () => new AbortController().signal;
const options = () => ({
  ...agentConfig.parse({ modelId: model }).rag,
  knowledgeBaseIds: [kb],
});
const citation = (id: string, text: string, chunkIndex = 0): Citation => ({
  id: 1,
  chunkId: id,
  documentId: document,
  sourceId: source,
  knowledgeBaseId: kb,
  title: "ML Learning Sequence",
  page: null,
  sourceUrl: null,
  heading: null,
  content: text,
  score: 0.9,
  vectorScore: 0.9,
  lexicalScore: 0.2,
  sourceRevision: 1,
  chunkIndex,
});
const head =
  "Week 9: Build data extraction from RAM document pipeline (Waing Maw Oo)\nWeek 10: Learning Google ADK version 2 (Waing Maw Oo)\nWeek 11: Build ADK2 agents and testing (Waing Maw Oo)\nWeek 12: LLM and model host testing (Waing Maw Oo)";
const tail =
  "Week 12: LLM and model host testing (Waing Maw Oo)\nWeek 13: Research Web Search tools and presentation (Waing Maw Oo)\nWeek 14: Research BrowserUse and Computer Use (Waing Maw Oo)\nWeek 15: BrowserUse integration with ADK and Agent S3 research (Waing Maw Oo)\nWeek 16: Browser Use integrated; Computer Use dropped (Waing Maw Oo)";

before(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash) VALUES(${author},${author + "@example.invalid"},'Context test','unused')`;
    await tx`INSERT INTO organizations(id,name) VALUES(${org},'Conversational retrieval test')`;
    for (const id of [workspace, foreign])
      await tx`INSERT INTO workspaces(id,organization_id,name) VALUES(${id},${org},'Retrieval test')`;
    await tx`INSERT INTO embedding_models(id,organization_id,workspace_id,name,provider,model_id,base_url,dimensions) VALUES(${model},${org},${workspace},'Fixture','openai-compatible','fixture','https://embedding.example.test',2)`;
    await tx`INSERT INTO knowledge_bases(id,organization_id,workspace_id,name,description,embedding_model_id,dimensions,chunk_size,chunk_overlap,chunk_strategy) VALUES(${kb},${org},${workspace},'ML Learning Sequence','Tasks across weeks',${model},2,500,50,'recursive')`;
    for (const id of [source, otherSource])
      await tx`INSERT INTO knowledge_sources(id,knowledge_base_id,organization_id,workspace_id,kind,title,status,metadata) VALUES(${id},${kb},${org},${workspace},'text','ML sequence','ready',${tx.json({ tags: ["learning"], attributes: { department: "training" } })})`;
    for (const [id, sid] of [
      [document, source],
      [otherDocument, otherSource],
      [sameSourceDocument, source],
    ])
      await tx`INSERT INTO knowledge_documents(id,source_id,knowledge_base_id,organization_id,workspace_id,title,metadata,page_count,content_hash,revision) VALUES(${id!},${sid!},${kb},${org},${workspace},'ML sequence','{}',1,'fixture',1)`;
    for (const [id, doc, sid, ordinal, content, vector] of [
      [previous, document, source, 0, head, "[0.1,0.99]"],
      [seed, document, source, 1, tail, "[1,0]"],
      [
        outsider,
        otherDocument,
        otherSource,
        0,
        "Unrelated private document",
        "[0,1]",
      ],
      [
        sameSourceChunk,
        sameSourceDocument,
        source,
        0,
        "Another logical document in the same source",
        "[0,1]",
      ],
    ] as const)
      await tx`INSERT INTO knowledge_chunks(id,document_id,source_id,knowledge_base_id,workspace_id,organization_id,embedding_model_id,dimensions,ordinal,content,metadata,embedding) VALUES(${id},${doc},${sid},${kb},${workspace},${org},${model},2,${ordinal},${content},'{}',${vector}::vector)`;
    await tx`INSERT INTO knowledge_releases(id,knowledge_base_id,workspace_id,organization_id,version,name,status,author_id) VALUES(${release},${kb},${workspace},${org},1,'Approved sequence','published',${author})`;
    await tx`INSERT INTO knowledge_release_chunks(release_id,id,document_id,source_id,knowledge_base_id,workspace_id,organization_id,source_revision,ordinal,content,page,heading,title,kind,dimensions,embedding,metadata) SELECT ${release},c.id,c.document_id,c.source_id,c.knowledge_base_id,c.workspace_id,c.organization_id,1,c.ordinal,c.content,c.page,c.heading,'ML sequence','text',c.dimensions,c.embedding,'{}' FROM knowledge_chunks c WHERE c.knowledge_base_id=${kb}`;
  });
});
after(async () => {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM knowledge_releases WHERE organization_id=${org}`;
    await tx`DELETE FROM knowledge_documents WHERE organization_id=${org}`;
    await tx`DELETE FROM knowledge_sources WHERE organization_id=${org}`;
    await tx`DELETE FROM knowledge_bases WHERE organization_id=${org}`;
    await tx`DELETE FROM embedding_models WHERE organization_id=${org}`;
    await tx`DELETE FROM workspaces WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    await tx`DELETE FROM users WHERE id=${author}`;
  });
  await closeDb();
});

test("rewrite tracing records original/effective queries only with content capture enabled", async () => {
  const previousSetting = process.env.LANGFUSE_CAPTURE_CONTENT;
  process.env.LANGFUSE_CAPTURE_CONTENT = "true";
  try {
    const provider: ChatProvider = {
      async *stream(request) {
        const input = JSON.parse(request.messages[0]!.content);
        assert.equal(input.history.length, 6);
        assert(!JSON.stringify(input).includes("Excluded old conversation"));
        yield { type: "token", text: '{"query":"Week 7 study plan"}' };
      },
    };
    const messages: ChatMessage[] = [
      { role: "user", content: "Excluded old conversation" },
      ...Array.from({ length: 6 }, (_, i) => ({
        role: i % 2 ? ("assistant" as const) : ("user" as const),
        content: "Week 6 study plan",
      })),
      { role: "user", content: "how about week 7" },
    ];
    await enhancedRetrieval(
      { execute: async () => [] },
      provider,
      messages,
      "how about week 7",
      [],
      options(),
      context,
      signal(),
    );
    const span = capturedSpans()
      .filter((s) => s.name === "knowledge.query_rewrite")
      .at(-1)!;
    const output = JSON.parse(
      String(span.attributes["langfuse.observation.output"]),
    );
    assert.equal(output.originalQuery, "how about week 7");
    assert.equal(output.rewrittenQuery, "Week 7 study plan");
    assert.equal(span.attributes["query.rewrite_fallback"], false);
    assert.equal(span.attributes["query.rewrite_used"], true);
    assert.equal(
      span.attributes["langfuse.observation.model.name"],
      "fixture-rewriter",
    );
    assert.equal(typeof span.attributes["query.rewrite_latency_ms"], "number");
  } finally {
    if (previousSetting === undefined)
      delete process.env.LANGFUSE_CAPTURE_CONTENT;
    else process.env.LANGFUSE_CAPTURE_CONTENT = previousSetting;
  }
});

test("entity and week follow-ups search only a contextual query, retaining original history", async () => {
  for (const [prior, answer, latest, expected] of [
    [
      "List all tasks of Pyei Pyei across all weeks",
      "Participants are Pyei Pyei and Waing Maw Oo. Here are Pyei Pyei's tasks.",
      "how about Waing",
      "What are all tasks assigned to Waing Maw Oo across all weeks?",
    ],
    [
      "what is week 6 study plan",
      "Week 6 covers agent development.",
      "how about week 7",
      "What is the Week 7 study plan in the knowledge base?",
    ],
  ]) {
    const messages: ChatMessage[] = [
      { role: "user", content: prior! },
      { role: "assistant", content: answer! },
      { role: "user", content: latest! },
    ];
    const unchanged = JSON.stringify(messages);
    let searches = 0;
    const provider: ChatProvider = {
      async *stream(request) {
        assert.equal(request.temperature, 0);
        assert(request.maxOutputTokens <= 512);
        const input = JSON.parse(request.messages[0]!.content);
        assert.equal(input.query, latest);
        assert.equal(input.history[0].content, prior);
        yield { type: "token", text: JSON.stringify({ query: expected }) };
      },
    };
    const rag: RagTool = {
      async execute(query, _ids, opts) {
        assert.equal(query, expected);
        assert.equal(opts.minScore, 0.2);
        searches++;
        return [citation(seed, tail)];
      },
    };
    const result = await enhancedRetrieval(
      rag,
      provider,
      messages,
      latest!,
      [kb],
      options(),
      context,
      signal(),
    );
    assert.equal(searches, 1);
    assert.equal(result.diagnostics.queryRewrite, "applied");
    assert.equal(JSON.stringify(messages), unchanged);
  }
});

test("rewrite failure, invalid JSON or an unsupported shape falls back and retrieval continues", async () => {
  for (const response of [
    null,
    "not JSON",
    '{"query":"valid","extra":true}',
    '{"query":"first","query":"second"}',
    '{"query":""}',
  ]) {
    const provider: ChatProvider = {
      async *stream() {
        if (response === null) throw new Error("fixture failure");
        yield { type: "token", text: response };
      },
    };
    const rag: RagTool = {
      async execute(query) {
        assert.equal(query, "how about Waing");
        return [citation(seed, tail)];
      },
    };
    const result = await enhancedRetrieval(
      rag,
      provider,
      [
        { role: "user", content: "List tasks" },
        { role: "assistant", content: "Prior tasks" },
        { role: "user", content: "how about Waing" },
      ],
      "how about Waing",
      [kb],
      options(),
      context,
      signal(),
    );
    assert.equal(result.diagnostics.queryRewrite, "original_query_fallback");
    assert.equal(result.sources.length, 1);
  }
});

const postgresRag = new PostgresRagTool(() => ({
  async embed(texts) {
    return texts.map(() => [1, 0]);
  },
}));
const noRewrite: ChatProvider = {
  async *stream() {
    throw new Error("No model call expected");
  },
};

test("comprehensive retrieval expands Weeks 9–16 from one seed and preserves chronological citations", async () => {
  const opts = { ...options(), topK: 1 };
  const first = await postgresRag.execute(
    "What are all tasks of Waing Maw Oo?",
    [kb],
    opts,
    context,
    signal(),
  );
  assert.deepEqual(
    first.map((s) => s.chunkId),
    [seed],
  );
  const rag: RagTool = {
    execute: async () => first,
    expandNeighbors: postgresRag.expandNeighbors,
  };
  const result = await enhancedRetrieval(
    rag,
    noRewrite,
    [],
    "What are all tasks of Waing Maw Oo?",
    [kb],
    opts,
    context,
    signal(),
  );
  assert.deepEqual(
    result.sources.map((s) => s.chunkId),
    [previous, seed],
  );
  assert.equal(result.sources[0]!.id, 1);
  assert.equal(result.sources[1]!.id, 2);
  const prompt = groundedPrompt(result.sources);
  for (let week = 9; week <= 16; week++)
    assert(prompt.includes(`Week ${week}`));
  assert.equal(prompt.match(/Week 12: LLM and model host testing/g)?.length, 1);
  assert(
    !result.sources.some((s) =>
      new Set<string>([outsider, sameSourceChunk]).has(s.chunkId),
    ),
  );
  const span = capturedSpans()
    .filter((s) => s.name === "knowledge.context_selection")
    .at(-1)!;
  const details = JSON.parse(
    String(span.attributes["langfuse.observation.metadata"]),
  );
  assert.equal(details.selectedCount, 2);
  assert(details.estimatedContextTokens > 0);
});

test("specific Week 14 query does not expand its document", async () => {
  let expanded = false;
  const rag: RagTool = {
    execute: async () => [citation(seed, tail, 1)],
    expandNeighbors: async () => {
      expanded = true;
      return [citation(previous, head)];
    },
  };
  const result = await enhancedRetrieval(
    rag,
    noRewrite,
    [],
    "What did Waing Maw Oo do in Week 14?",
    [kb],
    { ...options(), topK: 1 },
    context,
    signal(),
  );
  assert.equal(expanded, false);
  assert.deepEqual(
    result.sources.map((s) => s.chunkId),
    [seed],
  );
});

test("follow-up rewriting can be disabled per agent without preventing retrieval", async () => {
  let calls = 0;
  const rag: RagTool = {
    execute: async (query) => {
      assert.equal(query, "how about week 7");
      calls++;
      return [citation(seed, tail, 1)];
    },
  };
  const result = await enhancedRetrieval(
    rag,
    noRewrite,
    [
      { role: "user", content: "Week 6 plan" },
      { role: "assistant", content: "Prior answer" },
      { role: "user", content: "how about week 7" },
    ],
    "how about week 7",
    [kb],
    { ...options(), contextualRewrite: false },
    context,
    signal(),
  );
  assert.equal(calls, 1);
  assert.equal(result.diagnostics.queryRewrite, "disabled");
});

test("neighbors are scoped to source/document/revision, tenant, public access and release", async () => {
  const base = citation(seed, tail, 1);
  const expand = (item: Citation, ctx = context) =>
    postgresRag.expandNeighbors(
      [item],
      { ...options(), previous: 1, next: 1 },
      ctx,
      signal(),
    );
  assert.deepEqual(
    (await expand(base)).map((s) => s.chunkId),
    [previous],
  );
  assert.deepEqual(await expand({ ...base, sourceRevision: 2 }), []);
  assert.deepEqual(await expand({ ...base, documentId: otherDocument }), []);
  await assert.rejects(() =>
    expand(base, { ...context, workspaceId: foreign }),
  );
  await assert.rejects(() => expand(base, { ...context, publicAccess: true }));
  assert.deepEqual(
    await postgresRag.expandNeighbors(
      [base],
      {
        ...options(),
        previous: 1,
        next: 1,
        metadataFilter: { tagsAll: ["not-present"], attributes: {} },
      },
      context,
      signal(),
    ),
    [],
  );
  const approved = await expand({
    ...base,
    releaseId: release,
    reviewStatus: "approved",
  });
  assert.deepEqual(
    approved.map((s) => s.chunkId),
    [previous],
  );
  assert.equal(approved[0]!.releaseId, release);
  assert.deepEqual(
    await expand({
      ...base,
      releaseId: randomUUID(),
      reviewStatus: "approved",
    }),
    [],
  );
  assert.deepEqual(
    await expand({ ...base, chunkIndex: undefined, releaseId: release }),
    [],
  );
});

test("context selection deduplicates safely, retains multiple seeds and obeys token/chunk budgets", () => {
  const a = citation(previous, head, 0),
    b = citation(seed, tail, 1);
  const selected = selectContext([b, a, b, a], 6, 10000, (s) => s.length);
  assert.deepEqual(
    selected.sources.map((s) => s.chunkId),
    [previous, seed],
  );
  assert.equal(
    selected.sources
      .map((s) => s.content)
      .join("\n")
      .match(/Week 12: LLM and model host testing/g)?.length,
    1,
  );
  const only = selectContext([b, a], 1, 10000, (s) => s.length);
  assert.deepEqual(
    only.sources.map((s) => s.chunkId),
    [seed],
  );
  assert(
    only.sources[0]!.content.includes("Week 12"),
    "Must not trim overlap against an excluded chunk",
  );
  assert.equal(selectContext([a, b], 6, 10, (s) => s.length).sources.length, 0);
  assert.equal(
    retrievalBreadth("List all tasks across all weeks"),
    "comprehensive",
  );
  assert.equal(retrievalBreadth("List tasks in Week 14"), "specific");
  assert.match(
    lexicalSearchQuery("What are all tasks assigned to Waing Maw Oo?"),
    /Waing OR Maw OR Oo/,
  );
  assert.equal(
    lexicalSearchQuery('"Waing Maw Oo" -Pyei'),
    '"Waing Maw Oo" -Pyei',
  );
});

test("model/output limits always apply while disabled custom context budgets stay disabled", () => {
  const modelSnapshot = modelSnapshotSchema.parse({
    id: model,
    provider: "openai-compatible",
    modelId: "fixture",
    baseUrl: "https://example.test",
    secretId: null,
    contextWindow: 32768,
    maxOutputTokens: 4096,
    capabilities: { streaming: true, temperature: true, topP: true },
  });
  const disabled = agentConfig.parse({
    modelId: model,
    contextControls: { enabled: false, inputBudget: 128, knowledgeBudget: 64 },
  });
  assert(knowledgeContextBudget(disabled, modelSnapshot, []) > 128);
  const enabled = {
    ...disabled,
    contextControls: { ...disabled.contextControls, enabled: true },
  };
  assert(knowledgeContextBudget(enabled, modelSnapshot, []) <= 64);
  assert.equal(
    knowledgeContextBudget(disabled, { ...modelSnapshot, contextWindow: 256 }, [
      { role: "user", content: "x".repeat(2000) },
    ]),
    0,
  );
});

test("hybrid traces retain both lanes, raw scores and eligibility without changing the minimum score", async () => {
  const results = await postgresRag.execute(
    "What are all tasks assigned to Waing Maw Oo?",
    [kb],
    { ...options(), topK: 6 },
    context,
    signal(),
  );
  assert(results.some((s) => s.chunkId === seed));
  assert(
    !results.some((s) => s.chunkId === previous),
    "Semantic minimum remains unchanged for direct candidates",
  );
  const fusion = capturedSpans()
    .filter((s) => s.name === "knowledge.ranking_fusion")
    .at(-1)!;
  const rows = JSON.parse(String(fusion.attributes["retrieval.matches"]));
  const row = rows.find((r: { chunkId: string }) => r.chunkId === previous);
  assert(row.lexicalRank > 0);
  assert.equal(row.eligible, false);
  assert.equal(typeof row.vectorScore, "number");
  assert.equal(typeof row.lexicalScore, "number");
  assert(row.rrfScore > 0);
});

test("release ordering migration backfills only identical scoped historical chunks", async () => {
  const migration = await readFile(
    new URL(
      "../../../packages/db/migrations/0042_release_chunk_order.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await sql.begin(async (tx) => {
    // Temp tables shadow only this connection and disappear on commit.
    await tx`CREATE TEMP TABLE knowledge_chunks (id uuid,document_id uuid,source_id uuid,knowledge_base_id uuid,workspace_id uuid,organization_id uuid,content text,ordinal integer) ON COMMIT DROP`;
    await tx`CREATE TEMP TABLE knowledge_release_chunks (id uuid,document_id uuid,source_id uuid,knowledge_base_id uuid,workspace_id uuid,organization_id uuid,content text,release_id uuid) ON COMMIT DROP`;
    await tx`INSERT INTO knowledge_chunks VALUES(${seed},${document},${source},${kb},${workspace},${org},'Original content',7)`;
    await tx`INSERT INTO knowledge_release_chunks VALUES(${seed},${document},${source},${kb},${workspace},${org},'Original content'),(${previous},${document},${source},${kb},${workspace},${org},'Old unknown chunk'),(${seed},${otherDocument},${source},${kb},${workspace},${org},'Original content')`;
    await tx.unsafe(migration);
    const rows =
      await tx`SELECT id,document_id,ordinal FROM knowledge_release_chunks`;
    assert.equal(
      rows.find((r) => r.id === seed && r.document_id === document)!.ordinal,
      7,
    );
    assert.equal(rows.find((r) => r.id === previous)!.ordinal, null);
    assert.equal(
      rows.find((r) => r.document_id === otherDocument)!.ordinal,
      null,
    );
  });
});
