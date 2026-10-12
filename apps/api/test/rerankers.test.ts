import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { agentConfig } from "@agentconnect/schemas/agents";
import {
  ProviderError,
  type ProviderFactory,
} from "@agentconnect/provider-sdk";
import type { Citation } from "@agentconnect/rag/tool";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest, encrypt } from "../src/security.js";
import { agentReranker, cohereScores } from "../src/agent-reranking.js";
import { modelSnapshot } from "../src/agents.js";
import { routedProvider } from "../src/model-routing.js";
import { enhancedRetrieval } from "../src/rag-enhancements.js";
import { qualityFingerprint } from "../src/quality-gate.js";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  ws = randomUUID(),
  foreign = randomUUID(),
  model = randomUUID(),
  rankingModel = randomUUID(),
  foreignModel = randomUUID(),
  secret = randomUUID(),
  admin = randomUUID(),
  builder = randomUUID(),
  adminToken = randomUUID(),
  builderToken = randomUUID();
const app = await buildApp();
const originals = [config.RERANK_ALLOWED_HOSTS, config.MODEL_PRIVATE_HOSTS];
let mode = "ok",
  seen: unknown,
  nativeId = "",
  llmId = "";
const server = createServer(async (req, res) => {
  assert.equal(req.url, "/v2/rerank");
  assert.equal(req.headers.authorization, "Bearer fixture-cohere");
  let body = "";
  for await (const chunk of req) body += chunk;
  seen = JSON.parse(body);
  res.writeHead(mode === "http" ? 401 : 200, {
    "content-type": "application/json",
  });
  res.end(
    mode === "http"
      ? "secret provider body"
      : mode === "bad"
        ? "{}"
        : JSON.stringify({
            results: [
              { index: 1, relevance_score: 0.9 },
              { index: 0, relevance_score: 0.1 },
            ],
            meta: { billed_units: { search_units: 1 } },
          }),
  );
});
const factory: ProviderFactory = () => ({
  async *stream(input) {
    assert.equal(input.maxOutputTokens, 2048);
    yield {
      type: "token",
      text: '{"scores":[{"id":1,"score":0.2},{"id":2,"score":0.9}]}',
    };
    yield { type: "usage", inputTokens: 100, outputTokens: 20 };
  },
});
const sources: Citation[] = [1, 2].map((id) => ({
  id,
  chunkId: randomUUID(),
  documentId: randomUUID(),
  sourceId: randomUUID(),
  knowledgeBaseId: randomUUID(),
  content: "Authorized passage " + id,
  page: null,
  heading: null,
  title: "Fixture",
  sourceUrl: null,
  score: 0.8,
  vectorScore: 0.8,
  lexicalScore: 0.2,
}));
const draft = () =>
  agentConfig.parse({
    modelId: model,
    prompt: { instructions: "Answer" },
    rag: { rerank: true, rerankMaxOutputTokens: 2048 },
  });
async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
  isBuilder = false,
) {
  return app.inject({
    method,
    url,
    headers: {
      origin: config.WEB_ORIGIN,
      cookie: `session=${isBuilder ? builderToken : adminToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
}
const base = `/workspaces/${ws}/rerankers`;
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  config.RERANK_ALLOWED_HOSTS += ",127.0.0.1";
  config.MODEL_PRIVATE_HOSTS += `,127.0.0.1:${(server.address() as { port: number }).port}`;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES(${org},'Reranker fixture')`;
    for (const w of [ws, foreign])
      await tx`INSERT INTO workspaces(id,organization_id,name) VALUES(${w},${org},'Reranker fixture')`;
    for (const [user, token, role] of [
      [admin, adminToken, "workspace_admin"],
      [builder, builderToken, "builder"],
    ]) {
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES(${user!},${user + "@example.com"},'Fixture','unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(${digest(token!)},${user!},now()+interval '1 hour')`;
      await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES(${randomUUID()},${org},${ws},${user!},${role!})`;
    }
    await tx`INSERT INTO secrets(id,organization_id,workspace_id,name,ciphertext,created_by) VALUES(${secret},${org},${ws},'COHERE_FIXTURE',${tx.json(encrypt("fixture-cohere", `${org}:${ws}:COHERE_FIXTURE`))},${admin})`;
    for (const [id, scope] of [
      [model, ws],
      [rankingModel, ws],
      [foreignModel, foreign],
    ])
      await tx`INSERT INTO model_configurations(id,workspace_id,organization_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES(${id!},${scope!},${org},'Fixture','openai-compatible','fixture','https://api.openai.com',32768,8192,${tx.json({ streaming: true, temperature: true, topP: true })})`;
  });
});
after(async () => {
  [config.RERANK_ALLOWED_HOSTS, config.MODEL_PRIVATE_HOSTS] = originals as [
    string,
    string,
  ];
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await sql.begin(async (tx) => {
    for (const table of [
      "rerankers",
      "audit_events",
      "model_configurations",
      "secrets",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    for (const user of [admin, builder]) {
      await tx`DELETE FROM sessions WHERE user_id=${user}`;
      await tx`DELETE FROM users WHERE id=${user}`;
    }
  });
  await app.close();
});
test("Registry enforces admin writes, scoped models and credentials, and safe builder metadata", async () => {
  const body = {
    name: "Ranking LLM",
    provider: "llm",
    modelConfigurationId: rankingModel,
  };
  assert.equal((await call("POST", base, body, true)).statusCode, 403);
  assert.equal(
    (await call("POST", base, { ...body, modelConfigurationId: foreignModel }))
      .statusCode,
    400,
  );
  const llm = await call("POST", base, body);
  assert.equal(llm.statusCode, 201, llm.body);
  llmId = llm.json().id;
  const native = await call("POST", base, {
    name: "Cohere",
    provider: "cohere",
    modelId: "rerank-v3.5",
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    secretId: secret,
  });
  assert.equal(native.statusCode, 201, native.body);
  nativeId = native.json().id;
  assert.equal(
    (await call("DELETE", `/workspaces/${ws}/secrets/${secret}`)).statusCode,
    409,
  );
  const list = await call("GET", base, undefined, true);
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 2);
  assert.ok(!list.body.includes("secret_id"));
  assert.ok(!list.body.includes("fixture-cohere"));
  assert.equal(
    (await call("GET", `${base}/${nativeId}`, undefined, true)).statusCode,
    403,
  );
  assert.equal(
    (await call("GET", `/workspaces/${foreign}/rerankers`)).statusCode,
    403,
  );
});
test("Separate LLM honors configured budget and counts auxiliary usage; limits are validated", async () => {
  const c = draft();
  c.rag.rerankerId = llmId;
  const snapshot = await modelSnapshot(model, ws, c),
    meter = routedProvider(c, snapshot, "question", 0, ws, org, factory);
  await agentReranker(c, snapshot, ws, org, factory, meter)!(
    "question",
    sources,
    AbortSignal.timeout(5000),
  );
  assert.equal(meter.usage().inputTokens, 100);
  assert.equal(meter.usage().outputTokens, 20);
  assert.equal(meter.usage().modelUsage[0]?.modelId, rankingModel);
  c.rag.rerankMaxOutputTokens = 9000;
  await assert.rejects(modelSnapshot(model, ws, c), /limits/);
});
test("Native reranker receives authorized candidates, preserves citations and fails safely", async () => {
  const c = draft();
  c.rag.rerankerId = nativeId;
  const snapshot = await modelSnapshot(model, ws, c),
    meter = routedProvider(c, snapshot, "question", 0, ws, org, factory),
    rank = agentReranker(c, snapshot, ws, org, factory, meter)!;
  const retrieve = () =>
    enhancedRetrieval(
      { execute: async () => sources },
      meter.provider,
      [],
      "question",
      [],
      c.rag,
      { workspaceId: ws, organizationId: org, publicAccess: false },
      AbortSignal.timeout(5000),
      4096,
      rank,
    );
  const result = await retrieve();
  assert.equal(result.sources[0]!.chunkId, sources[1]!.chunkId);
  assert.deepEqual(
    (seen as { documents: unknown }).documents,
    sources.map((s) => s.content),
  );
  assert.equal(meter.usage().calls, 0);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(rank("question", sources, cancelled.signal));
  mode = "http";
  await assert.rejects(
    rank("question", sources, AbortSignal.timeout(5000)),
    (e) =>
      e instanceof ProviderError &&
      e.httpStatus === 401 &&
      e.code === "RERANK_PROVIDER_ERROR" &&
      !e.message.includes("secret"),
  );
  mode = "bad";
  const bad = await retrieve();
  assert.equal(bad.diagnostics.rerankError, "RERANK_INVALID_RESPONSE");
  assert.equal(bad.sources[0]!.chunkId, sources[0]!.chunkId);
  mode = "ok";
  for (const results of [
    [
      { index: 0, relevance_score: 0.5 },
      { index: 0, relevance_score: 0.3 },
    ],
    [
      { index: 0, relevance_score: 2 },
      { index: 1, relevance_score: 0.3 },
    ],
    [
      { index: 2, relevance_score: 0.5 },
      { index: 1, relevance_score: 0.3 },
    ],
  ])
    assert.throws(
      () => cohereScores({ results }, 2),
      (e: unknown) =>
        e instanceof ProviderError && e.code === "RERANK_INVALID_RESPONSE",
    );
});
test("Changed rerankers invalidate quality results; unavailable snapshots fall back without calls", async () => {
  const c = draft();
  c.rag.rerankerId = llmId;
  const snapshot = await modelSnapshot(model, ws, c),
    before = await qualityFingerprint(c, snapshot, ws);
  const body = {
    name: "Ranking LLM",
    provider: "llm",
    modelConfigurationId: rankingModel,
    enabled: false,
    revision: 1,
  };
  assert.equal((await call("PUT", `${base}/${llmId}`, body)).statusCode, 200);
  assert.notEqual(await qualityFingerprint(c, snapshot, ws), before);
  assert.equal((await call("PUT", `${base}/${llmId}`, body)).statusCode, 409);
  await assert.rejects(modelSnapshot(model, ws, c), /unavailable/);
  const meter = routedProvider(c, snapshot, "question", 0, ws, org, factory);
  const result = await enhancedRetrieval(
    { execute: async () => sources },
    meter.provider,
    [],
    "question",
    [],
    c.rag,
    { workspaceId: ws, organizationId: org, publicAccess: false },
    AbortSignal.timeout(5000),
    4096,
    agentReranker(c, snapshot, ws, org, factory, meter),
  );
  assert.equal(result.diagnostics.rerankError, "RERANK_UNAVAILABLE");
  assert.equal(meter.usage().calls, 0);
  assert.equal((await call("DELETE", `${base}/${nativeId}`)).statusCode, 200);
});
