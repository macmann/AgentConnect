import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest } from "../src/security.js";
import { processKnowledgeJob } from "../src/ingestion.js";
import { cleanupKnowledgeFixtures } from "./knowledge-cleanup.mjs";
import {
  ProviderError,
  type ProviderFactory,
} from "@agentconnect/provider-sdk";
import type { EmbeddingFactory } from "@agentconnect/provider-sdk/embeddings";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const foreignOrg = randomUUID(),
  foreignWorkspace = randomUUID(),
  foreignEmbedding = randomUUID(),
  foreignKb = randomUUID();
const org = randomUUID(),
  workspace = randomUUID(),
  owner = randomUUID(),
  session = randomUUID();
let kb = "",
  otherKb = "",
  agent = "",
  unpublished = "",
  version = "",
  tool = "",
  detailKey = "",
  basicKey = "",
  kbKey = "",
  address = "";
let waitingForAbort = false;
let generation = 0,
  rerankFails = false;
const vectors: EmbeddingFactory = () => ({
  async embed(texts) {
    return texts.map(() => [1, 0.2, 0.3]);
  },
});
const provider: ProviderFactory = () => ({
  async *stream(input) {
    if (input.system.startsWith("Rank reference passages")) {
      if (rerankFails) throw new ProviderError("RERANK_UNAVAILABLE");
      const data = JSON.parse(input.messages[0]!.content);
      yield {
        type: "token",
        text: JSON.stringify({
          scores: data.passages.map((p: { id: number }, i: number) => ({
            id: p.id,
            score: i ? 0.9 : 0.3,
          })),
        }),
      };
    } else if (input.system.startsWith("Choose useful")) {
      yield {
        type: "token",
        text: JSON.stringify({
          calls: [
            {
              toolId: tool,
              arguments: {
                operation: "sum",
                operands: [
                  { label: "One", value: "1", unit: "MMK" },
                  { label: "Two", value: "2", unit: "MMK" },
                ],
              },
            },
          ],
        }),
      };
    } else {
      if (input.messages.at(-1)?.content === "force failure")
        throw new ProviderError("AUTHENTICATION_FAILED");
      if (input.messages.at(-1)?.content === "wait until cancel") {
        waitingForAbort = true;
        if (!input.signal.aborted)
          await new Promise<void>((resolve) =>
            input.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
        throw new ProviderError("CANCELLED");
      }
      generation++;
      yield {
        type: "token",
        text: "Refunds within 30 days. The total is 3.00 [1].",
      };
    }
    yield { type: "usage", inputTokens: 40, outputTokens: 20 };
  },
});
const app = await buildApp({
  providerFactory: provider,
  embeddingFactory: vectors,
});
async function admin(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: {
      origin: config.WEB_ORIGIN,
      cookie: `session=${session}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    payload: body ? JSON.stringify(body) : undefined,
  });
}
async function create(url: string, body: unknown, status = 201) {
  const r = await admin("POST", url, body);
  assert.equal(r.statusCode, status, r.body);
  return r.json();
}
async function api(
  method: "GET" | "POST",
  path: string,
  key?: string,
  body?: unknown,
) {
  return app.inject({
    method,
    url: path,
    remoteAddress: "127.0.0.81",
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    payload: body ? JSON.stringify(body) : undefined,
  });
}
const keyPath = `/workspaces/${workspace}/operations/api-keys`;
before(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES (${foreignOrg},'Foreign API tenant')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${foreignWorkspace},${foreignOrg},'Foreign workspace')`;
    await tx`INSERT INTO embedding_models(id,organization_id,workspace_id,name,provider,model_id,base_url,dimensions) VALUES (${foreignEmbedding},${foreignOrg},${foreignWorkspace},'Foreign embedding','openai-compatible','fixture','https://api.openai.com/v1',3)`;
    await tx`INSERT INTO knowledge_bases(id,organization_id,workspace_id,name,description,embedding_model_id,dimensions,chunk_size,chunk_overlap,chunk_strategy) VALUES (${foreignKb},${foreignOrg},${foreignWorkspace},'Foreign knowledge','',${foreignEmbedding},3,1000,100,'recursive')`;
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${owner},${owner + "@example.com"},'Platform owner','unused-test-password',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(session)},${owner},now()+interval '1 hour')`;
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Platform tests')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'API workspace')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${owner},'owner')`;
  });
  await create(`/workspaces/${workspace}/secrets`, {
    name: "EMBEDDINGS",
    value: "fixture-only-secret",
  });
  const [secret] =
    await sql`SELECT id FROM secrets WHERE workspace_id=${workspace}`;
  const embedding = await create(`/workspaces/${workspace}/embedding-models`, {
    name: "Embedding",
    provider: "openai",
    modelId: "fixture",
    dimensions: 3,
    secretId: secret!.id,
  });
  kb = (
    await create(`/workspaces/${workspace}/knowledge-bases`, {
      name: "Policies",
      embeddingModelId: embedding.id,
    })
  ).id;
  otherKb = (
    await create(`/workspaces/${workspace}/knowledge-bases`, {
      name: "Other policies",
      embeddingModelId: embedding.id,
    })
  ).id;
  for (const text of [
    "Refunds are available within 30 days.",
    "Refund payment processing policy: the total is 3.00 MMK.",
  ]) {
    await create(`/knowledge-bases/${kb}/text`, { title: text, text }, 202);
    assert.equal(await processKnowledgeJob(vectors), true);
  }
  const model = await create(`/workspaces/${workspace}/models`, {
    name: "Fixture model",
    provider: "openai-compatible",
    modelId: "fixture",
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 32768,
    maxOutputTokens: 1024,
  });
  tool = (
    await create(`/workspaces/${workspace}/tools`, {
      name: "Calculator",
      description: "Sum values",
      config: { kind: "financial", requireEvidence: false },
      readOnlyAcknowledged: true,
    })
  ).id;
  agent = (
    await create(`/workspaces/${workspace}/agents`, {
      name: "Policy agent",
      config: {
        modelId: model.id,
        prompt: { instructions: "Answer refund questions with citations." },
        tools: { toolIds: [tool] },
        rag: {
          knowledgeBaseIds: [kb],
          usageMode: "always",
          minScore: 0,
          mode: "hybrid",
          topK: 1,
          candidateCount: 5,
          rerank: true,
        },
      },
    })
  ).id;
  version = (await create(`/agents/${agent}/publish`, { revision: 1 })).id;
  unpublished = (
    await create(`/workspaces/${workspace}/agents`, {
      name: "Unpublished",
      config: { modelId: model.id },
    })
  ).id;
  detailKey = (
    await create(keyPath, {
      label: "Details",
      agentId: agent,
      scope: "agent:invoke",
      detailsEnabled: true,
    })
  ).key;
  basicKey = (
    await create(keyPath, {
      label: "Answer only",
      agentId: agent,
      scope: "agent:invoke",
    })
  ).key;
  kbKey = (
    await create(keyPath, {
      label: "Knowledge",
      knowledgeBaseId: kb,
      detailsEnabled: true,
    })
  ).key;
  address = await app.listen({ host: "127.0.0.1", port: 0 });
});
after(async () => {
  await cleanupKnowledgeFixtures(sql, org);
  await sql.begin(async (tx) => {
    for (const table of [
      "workspace_api_keys",
      "tool_executions",
      "tools",
      "messages",
      "agent_runs",
      "conversations",
      "agent_versions",
      "agents",
      "model_configurations",
      "knowledge_jobs",
      "knowledge_documents",
      "knowledge_sources",
      "knowledge_bases",
      "embedding_models",
      "secrets",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
    await tx`DELETE FROM knowledge_bases WHERE id=${foreignKb}`;
    await tx`DELETE FROM embedding_models WHERE id=${foreignEmbedding}`;
    await tx`DELETE FROM workspaces WHERE id=${foreignWorkspace}`;
    await tx`DELETE FROM organizations WHERE id=${foreignOrg}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    await tx`DELETE FROM users WHERE id=${owner}`;
  });
  app.server.closeAllConnections();
  await app.close();
});
test("platform requests require a live scoped bearer, never browser cookies", async () => {
  assert.equal((await api("GET", "/api/v1/resources")).statusCode, 401);
  assert.equal((await admin("GET", "/api/v1/resources")).statusCode, 401);
  assert.equal(
    (await api("GET", "/api/v1/resources", "ac_invalid")).statusCode,
    401,
  );
  const resources = await api("GET", "/api/v1/resources", kbKey);
  assert.equal(resources.statusCode, 200, resources.body);
  assert.equal(resources.json().resource.id, kb);
  assert.equal(resources.json().scope, "knowledge:search");
  assert.ok(!resources.body.includes("token_hash"));
  assert.equal(
    (
      await api("POST", `/api/v1/knowledge-bases/${otherKb}/search`, kbKey, {
        query: "refund",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await api("POST", `/api/v1/knowledge-bases/${kb}/search`, detailKey, {
        query: "refund",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await api("POST", `/api/v1/agents/${agent}/invoke`, kbKey, {
        message: "Hi",
      })
    ).statusCode,
    403,
  );
});
test("raw semantic and hybrid search return chunks, scores, provenance and RRF diagnostics without generation", async () => {
  const calls = generation;
  for (const mode of ["semantic", "hybrid"]) {
    const r = await api("POST", `/api/v1/knowledge-bases/${kb}/search`, kbKey, {
      query: "refund policy",
      mode,
      includeDetails: true,
    });
    assert.equal(r.statusCode, 200, r.body);
    const result = r.json();
    assert.equal(result.results.length, 2);
    assert.ok(result.results[0].content);
    assert.equal(result.results[0].knowledgeBaseId, kb);
    assert.equal(typeof result.results[0].rankingScore, "number");
    assert.equal(result.stages.length, mode === "hybrid" ? 3 : 2);
    if (mode === "hybrid")
      assert.equal(typeof result.results[0].rrfScore, "number");
    assert.match(r.headers["cache-control"] as string, /no-store/);
  }
  assert.equal(generation, calls);
  assert.equal(
    (
      await api("POST", `/api/v1/knowledge-bases/${kb}/search`, kbKey, {
        query: "",
        topK: 31,
      })
    ).statusCode,
    400,
  );
});
test("published invocation returns answer, tool outputs and selected versus reranked RAG evidence", async () => {
  const r = await api("POST", `/api/v1/agents/${agent}/invoke`, detailKey, {
    message: "What are refund rules?",
    includeDetails: true,
  });
  assert.equal(r.statusCode, 200, r.body);
  const result = r.json();
  assert.equal(result.versionId, version);
  assert.equal(result.status, "completed");
  assert.match(result.output, /Refunds/);
  assert.equal(result.citations.length, 1);
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].result.result, "3.00");
  assert.equal(result.retrieval.chunks.length, 1);
  assert.equal(result.retrieval.details.candidates.length, 2);
  assert.equal(result.retrieval.details.reranked[0].rerankScore, 0.9);
  assert.equal(
    result.retrieval.chunks[0].chunkId,
    result.retrieval.details.reranked[0].chunkId,
  );
  assert.deepEqual(
    result.retrieval.stages.map((s: { stage: string }) => s.stage),
    ["vector_search", "lexical_search", "ranking_fusion"],
  );
  assert.ok(result.runId && result.traceId);
  assert.ok(result.usage.inputTokens > 0);
  const next = await api("POST", `/api/v1/agents/${agent}/invoke`, detailKey, {
    message: "And the time limit?",
    conversationId: result.conversationId,
  });
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().conversationId, result.conversationId);
  assert.equal(next.json().retrieval, undefined);
  assert.equal(next.json().tools, undefined);
  const history = await api(
    "GET",
    `/api/v1/agents/${agent}/conversations/${result.conversationId}`,
    detailKey,
  );
  assert.equal(history.json().messages.length, 4);
  assert.equal(
    (
      await api("POST", `/api/v1/agents/${agent}/invoke`, basicKey, {
        message: "Guess conversation",
        conversationId: result.conversationId,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await api(
        "GET",
        `/api/v1/agents/${agent}/conversations/${result.conversationId}`,
        basicKey,
      )
    ).statusCode,
    404,
  );
  const legacy = await app.inject({
    method: "POST",
    url: `/agents/${agent}/chat`,
    headers: {
      authorization: `Bearer ${detailKey}`,
      "content-type": "application/json",
    },
    payload: { message: "Bypass", conversationId: result.conversationId },
  });
  assert.equal(legacy.statusCode, 401);
});
test("detail grants, published version selection and runtime errors are explicit", async () => {
  assert.equal(
    (
      await api("POST", `/api/v1/agents/${agent}/invoke`, basicKey, {
        message: "Rules?",
        includeDetails: true,
      })
    ).statusCode,
    403,
  );
  const key = (
    await create(keyPath, { label: "No publication", agentId: unpublished })
  ).key;
  assert.equal(
    (
      await api("POST", `/api/v1/agents/${unpublished}/invoke`, key, {
        message: "Hi",
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await api("POST", `/api/v1/agents/${agent}/invoke`, detailKey, {
        message: "Hi",
        versionId: randomUUID(),
      })
    ).statusCode,
    409,
  );
  const failed = await api(
    "POST",
    `/api/v1/agents/${agent}/invoke`,
    detailKey,
    { message: "force failure", includeDetails: true },
  );
  assert.equal(failed.statusCode, 502, failed.body);
  assert.equal(failed.json().status, "failed");
  assert.equal(failed.json().output, null);
  assert.equal(failed.json().error.code, "AUTHENTICATION_FAILED");
  assert.equal(failed.json().tools.length, 1);
  rerankFails = true;
  const fallback = await api(
    "POST",
    `/api/v1/agents/${agent}/invoke`,
    detailKey,
    { message: "Refund", includeDetails: true },
  );
  rerankFails = false;
  assert.equal(fallback.statusCode, 200, fallback.body);
  assert.equal(
    fallback.json().retrieval.diagnostics.rerank,
    "retrieval_order_fallback",
  );
});
test("official MCP client discovers only the granted tool and calls both transports", async () => {
  for (const [key, name, args] of [
    [kbKey, "knowledge_search", { query: "refund", includeDetails: true }],
    [
      detailKey,
      "agent_invoke",
      { message: "Refund rules?", includeDetails: true },
    ],
  ] as const) {
    const client = new Client({ name: "regression-client", version: "1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(address + "/mcp"),
      { requestInit: { headers: { authorization: `Bearer ${key}` } } },
    );
    try {
      await client.connect(transport);
      const list = await client.listTools();
      assert.deepEqual(
        list.tools.map((t) => t.name),
        [name],
      );
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.ok(result.structuredContent);
      if (name === "knowledge_search")
        assert.equal(
          (result.structuredContent as { results: unknown[] }).results.length,
          2,
        );
      else
        assert.equal(
          (result.structuredContent as { tools: unknown[] }).tools.length,
          1,
        );
      const denied = await client.callTool({
        name: name === "knowledge_search" ? "agent_invoke" : "knowledge_search",
        arguments: args,
      });
      assert.equal(denied.isError, true);
    } finally {
      await client.close();
    }
  }
});
test("expiration, revocation, archived resources and issuer permission changes apply on every request", async () => {
  const made = await create(keyPath, {
    label: "Lifecycle",
    knowledgeBaseId: otherKb,
  });
  await sql`UPDATE workspace_api_keys SET expires_at=now()-interval '1 second' WHERE id=${made.id}`;
  assert.equal(
    (await api("GET", "/api/v1/resources", made.key)).statusCode,
    401,
  );
  await sql`UPDATE workspace_api_keys SET expires_at=now()+interval '1 hour' WHERE id=${made.id}`;
  await sql`UPDATE knowledge_bases SET archived_at=now() WHERE id=${otherKb}`;
  assert.equal(
    (await api("GET", "/api/v1/resources", made.key)).statusCode,
    404,
  );
  await sql`UPDATE knowledge_bases SET archived_at=NULL WHERE id=${otherKb}`;
  assert.equal(
    (await admin("DELETE", `${keyPath}/${made.id}`)).statusCode,
    200,
  );
  assert.equal(
    (await api("GET", "/api/v1/resources", made.key)).statusCode,
    401,
  );
  await sql`UPDATE memberships SET role='viewer',workspace_id=${workspace} WHERE organization_id=${org} AND user_id=${owner}`;
  try {
    assert.equal(
      (await api("GET", "/api/v1/resources", detailKey)).statusCode,
      403,
    );
  } finally {
    await sql`UPDATE memberships SET role='owner',workspace_id=NULL WHERE organization_id=${org} AND user_id=${owner}`;
  }
});

test("key issuance validates resource scope and unpublished or unapproved data cannot bypass policies", async () => {
  for (const body of [
    { label: "Missing" },
    { label: "Both", agentId: agent, knowledgeBaseId: kb },
    { label: "Mismatch", agentId: agent, scope: "knowledge:search" },
    { label: "Unknown", knowledgeBaseId: randomUUID() },
  ]) {
    assert.equal((await admin("POST", keyPath, body)).statusCode, 400);
  }
  await sql`UPDATE knowledge_bases SET approval_required=true WHERE id=${kb}`;
  try {
    const result = await api(
      "POST",
      `/api/v1/knowledge-bases/${kb}/search`,
      kbKey,
      { query: "refund", contentMode: "current" },
    );
    assert.equal(result.statusCode, 404, result.body);
    assert.equal(result.json().error, "KNOWLEDGE_RELEASE_UNAVAILABLE");
  } finally {
    await sql`UPDATE knowledge_bases SET approval_required=false WHERE id=${kb}`;
  }
  const historyBefore =
    await sql`SELECT count(*)::int AS n FROM conversations WHERE api_key_id=(SELECT id FROM workspace_api_keys WHERE token_hash=${digest(detailKey)})`;
  const noVersion = await api(
    "POST",
    `/api/v1/agents/${agent}/invoke`,
    detailKey,
    { message: "Refund", versionId: randomUUID() },
  );
  assert.equal(noVersion.statusCode, 409);
  const historyAfter =
    await sql`SELECT count(*)::int AS n FROM conversations WHERE api_key_id=(SELECT id FROM workspace_api_keys WHERE token_hash=${digest(detailKey)})`;
  assert.equal(historyBefore[0]!.n, historyAfter[0]!.n);
});

test("MCP authentication, method handling and detail denial do not leak execution data", async () => {
  const unauth = await app.inject({
    method: "POST",
    url: "/mcp",
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  assert.equal(unauth.statusCode, 401);
  const deniedOrigin = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: `Bearer ${kbKey}`,
      origin: "https://untrusted.example",
    },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  assert.equal(deniedOrigin.statusCode, 403);
  assert.equal((await api("GET", "/mcp", kbKey)).statusCode, 405);
  const client = new Client({ name: "basic-client", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(address + "/mcp"), {
        requestInit: { headers: { authorization: `Bearer ${basicKey}` } },
      }),
    );
    const calls = generation;
    const result = await client.callTool({
      name: "agent_invoke",
      arguments: { message: "Refund", includeDetails: true },
    });
    assert.equal(result.isError, true);
    assert.equal(generation, calls);
    assert.ok(!JSON.stringify(result).includes("fixture-only-secret"));
  } finally {
    await client.close();
  }
});

test("platform limits are per key and revoked keys cannot reuse an MCP connection", async () => {
  const made = await create(keyPath, { label: "Limits", knowledgeBaseId: kb });
  const client = new Client({ name: "revocation-client", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(address + "/mcp"), {
        requestInit: { headers: { authorization: `Bearer ${made.key}` } },
      }),
    );
    await admin("DELETE", `${keyPath}/${made.id}`);
    await assert.rejects(() => client.listTools(), /401|revoked|unauthorized/i);
  } finally {
    await client.close();
  }
  const limited = await create(keyPath, {
    label: "Rate fixture",
    knowledgeBaseId: kb,
  });
  for (let i = 0; i < 60; i++)
    assert.equal(
      (await api("GET", "/api/v1/resources", limited.key)).statusCode,
      200,
    );
  assert.equal(
    (await api("GET", "/api/v1/resources", limited.key)).statusCode,
    429,
  );
  assert.equal((await api("GET", "/api/v1/resources", kbKey)).statusCode, 200);
});

test("disconnect cancels JSON execution and concurrent calls cannot race one conversation", async () => {
  const first = await api("POST", `/api/v1/agents/${agent}/invoke`, detailKey, {
    message: "Start conversation",
  });
  assert.equal(first.statusCode, 200, first.body);
  const conversationId = first.json().conversationId,
    controller = new AbortController();
  waitingForAbort = false;
  const pending = fetch(address + `/api/v1/agents/${agent}/invoke`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${detailKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ message: "wait until cancel", conversationId }),
    signal: controller.signal,
  }).then(
    () => "unexpected response",
    () => "aborted",
  );
  try {
    for (let i = 0; i < 100 && !waitingForAbort; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(waitingForAbort, true);
    const racing = await api(
      "POST",
      `/api/v1/agents/${agent}/invoke`,
      detailKey,
      { message: "Race", conversationId },
    );
    assert.equal(racing.statusCode, 409, racing.body);
  } finally {
    controller.abort();
  }
  assert.equal(await pending, "aborted");
  let status = "running";
  for (let i = 0; i < 100 && status === "running"; i++) {
    const [run] =
      await sql`SELECT status FROM agent_runs WHERE conversation_id=${conversationId} ORDER BY started_at DESC LIMIT 1`;
    status = run!.status;
    if (status === "running")
      await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(status, "cancelled");
});

test("new calls use the latest publication while existing conversations retain their version", async () => {
  const first = await api("POST", `/api/v1/agents/${agent}/invoke`, basicKey, {
    message: "Start on v1",
  });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().versionId, version);
  const [a] = await sql`SELECT * FROM agents WHERE id=${agent}`;
  const changed = await admin("PUT", `/agents/${agent}`, {
    name: a!.name,
    revision: a!.revision,
    config: {
      ...a!.draft_config,
      prompt: { ...a!.draft_config.prompt, instructions: "New revision" },
    },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  const latest = await create(`/agents/${agent}/publish`, {
    revision: changed.json().revision,
  });
  const current = await api(
    "POST",
    `/api/v1/agents/${agent}/invoke`,
    basicKey,
    { message: "New conversation" },
  );
  assert.equal(current.statusCode, 200, current.body);
  assert.equal(current.json().versionId, latest.id);
  const resumed = await api(
    "POST",
    `/api/v1/agents/${agent}/invoke`,
    basicKey,
    { message: "Continue v1", conversationId: first.json().conversationId },
  );
  assert.equal(resumed.json().versionId, version);
  assert.equal(
    (
      await api("POST", `/api/v1/agents/${agent}/invoke`, basicKey, {
        message: "Switch",
        conversationId: first.json().conversationId,
        versionId: latest.id,
      })
    ).statusCode,
    409,
  );
  const explicit = await api(
    "POST",
    `/api/v1/agents/${agent}/invoke`,
    basicKey,
    { message: "Explicit old version", versionId: version },
  );
  assert.equal(explicit.statusCode, 200, explicit.body);
  assert.equal(explicit.json().versionId, version);
});

test("foreign tenant resources cannot be granted, searched or attached to keys", async () => {
  assert.equal(
    (
      await admin("POST", keyPath, {
        label: "Foreign grant",
        knowledgeBaseId: foreignKb,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await api("POST", `/api/v1/knowledge-bases/${foreignKb}/search`, kbKey, {
        query: "refund",
      })
    ).statusCode,
    403,
  );
  await assert.rejects(
    () =>
      sql`INSERT INTO workspace_api_keys(id,workspace_id,organization_id,knowledge_base_id,scope,label,token_hash,prefix,created_by,expires_at) VALUES (${randomUUID()},${workspace},${org},${foreignKb},'knowledge:search','Invalid foreign FK',${digest(randomUUID())},'ac_fixture',${owner},now()+interval '1 hour')`,
    (e: unknown) => (e as { code: string }).code === "23503",
  );
});
