import { executeAgentSnapshot } from "../src/workflow-agents.js";
import { modelSnapshotSchema } from "../src/agent-models.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest, hashPassword } from "../src/security.js";
import { cleanupKnowledgeFixtures } from "./knowledge-cleanup.mjs";
import {
  processKnowledgeJob,
  claimKnowledgeJob,
  purgeDeletedKnowledge,
} from "../src/ingestion.js";
import type { EmbeddingFactory } from "@agentconnect/provider-sdk/embeddings";
import type { ProviderFactory } from "@agentconnect/provider-sdk";
import { ProviderError } from "@agentconnect/provider-sdk";
import { agentConfig } from "@agentconnect/schemas/agents";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production mode");
const org = randomUUID(),
  workspace = randomUUID(),
  owner = randomUUID(),
  viewer = randomUUID(),
  outsider = randomUUID();
const sessions = { owner: "", viewer: "", outsider: "" };
let modelId = "",
  kbId = "",
  qaId = "",
  agentId = "",
  chatModel = "",
  deploymentId = "";
let generationCalls = 0;
let wrongDimension = false,
  omitCitation = false,
  retryEmbedding = false,
  receivedKey = false,
  receivedGrounding = false;
const vector = (text: string) => [
  text.toLowerCase().includes("refund") ? 1 : 0.1,
  text.toLowerCase().includes("30") ? 1 : 0.1,
  0.3,
];
const embedding: EmbeddingFactory = (c) => ({
  async embed(texts) {
    if (c.apiKey === "fixture-embedding-key") receivedKey = true;
    if (retryEmbedding) throw new ProviderError("RATE_LIMITED", true);
    return texts.map((text) => (wrongDimension ? [1, 2] : vector(text)));
  },
});
const chat: ProviderFactory = () => ({
  async *stream(input) {
    if (input.system.startsWith("Decide whether")) {
      yield {
        type: "token",
        text: JSON.stringify({
          retrieve: input.messages.at(-1)?.content !== "hi",
        }),
      };
      yield { type: "usage", inputTokens: 3, outputTokens: 2 };
      return;
    }
    generationCalls++;
    receivedGrounding =
      input.system.includes("<reference_passages>") &&
      input.system.includes("30 days");
    yield {
      type: "token",
      text: omitCitation
        ? "Unsupported answer"
        : "Refunds are available within 30 days [1].",
    };
    yield { type: "usage", inputTokens: 12, outputTokens: 9 };
  },
});
const app = await buildApp({
  embeddingFactory: embedding,
  providerFactory: chat,
});
async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
  session = sessions.owner,
) {
  return app.inject({
    method,
    url,
    headers: {
      origin: config.WEB_ORIGIN,
      ...(session ? { cookie: session } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    payload: body ? JSON.stringify(body) : undefined,
  });
}
function frames(body: string) {
  return body
    .split("\n\n")
    .filter((s) => s.startsWith("event:"))
    .map((s) => ({
      event: s.split("\n")[0]!.slice(7),
      data: JSON.parse(s.split("\n")[1]!.slice(6)),
    }));
}
before(async () => {
  await sql.begin(async (tx) => {
    const password = await hashPassword("fixture-password-only");
    for (const [name, user] of Object.entries({ owner, viewer, outsider })) {
      const raw = randomUUID();
      sessions[name as keyof typeof sessions] = "session=" + raw;
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${user},${user + "@example.com"},${name},${password},now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(raw)},${user},now()+interval '1 hour')`;
    }
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Knowledge fixtures')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Knowledge fixtures')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${owner},'owner')`;
    await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${workspace},${viewer},'viewer')`;
  });
});
after(async () => {
  await cleanupKnowledgeFixtures(sql, org);
  await sql.begin(async (tx) => {
    for (const table of [
      "messages",
      "agent_runs",
      "conversations",
      "deployments",
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
    await tx`DELETE FROM organizations WHERE id=${org}`;
    await tx`DELETE FROM users WHERE id=ANY(${[owner, viewer, outsider]})`;
  });
  await app.close();
});
test("Embedding registry enforces role and tenant credential ownership", async () => {
  assert.equal(
    (
      await call("POST", `/workspaces/${workspace}/embedding-models`, {
        name: "Invalid compatible model",
        provider: "openai-compatible",
        modelId: "fixture",
        dimensions: 3,
      })
    ).statusCode,
    400,
  );
  const secret = await call("POST", `/workspaces/${workspace}/secrets`, {
    name: "EMBED_FIXTURE",
    value: "fixture-embedding-key",
  });
  assert.equal(secret.statusCode, 201);
  const [s] = await sql`SELECT id FROM secrets WHERE workspace_id=${workspace}`;
  const body = {
    name: "Fixture embeddings",
    provider: "openai",
    modelId: "text-embedding-3-small",
    secretId: s!.id,
    dimensions: 3,
  };
  assert.equal(
    (
      await call(
        "POST",
        `/workspaces/${workspace}/embedding-models`,
        body,
        sessions.viewer,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call("POST", `/workspaces/${workspace}/embedding-models`, {
        ...body,
        secretId: randomUUID(),
      })
    ).statusCode,
    400,
  );
  const registered = await call(
    "POST",
    `/workspaces/${workspace}/embedding-models`,
    body,
  );
  assert.equal(registered.statusCode, 201);
  modelId = registered.json().id;
  assert.equal(
    (
      await call(
        "POST",
        `/workspaces/${workspace}/embedding-models/${modelId}/test`,
      )
    ).json().dimensions,
    3,
  );
  assert.ok(receivedKey);
  assert.equal(
    (
      await call(
        "GET",
        `/workspaces/${workspace}/embedding-models`,
        undefined,
        sessions.outsider,
      )
    ).statusCode,
    403,
  );
});
test("Knowledge creation validates embedding space, permissions and HNSW index", async () => {
  const body = { name: "Policies", embeddingModelId: modelId };
  assert.equal(
    (
      await call(
        "POST",
        `/workspaces/${workspace}/knowledge-bases`,
        body,
        sessions.viewer,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call("POST", `/workspaces/${workspace}/knowledge-bases`, {
        ...body,
        embeddingModelId: randomUUID(),
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call("POST", `/workspaces/${workspace}/knowledge-bases`, {
        ...body,
        chunkSize: 200,
        chunkOverlap: 200,
      })
    ).statusCode,
    400,
  );
  const created = await call(
    "POST",
    `/workspaces/${workspace}/knowledge-bases`,
    body,
  );
  assert.equal(created.statusCode, 201, created.body);
  kbId = created.json().id;
  const [index] =
    await sql`SELECT indexdef FROM pg_indexes WHERE indexname=${"kb_" + kbId.replaceAll("-", "")}`;
  assert.match(index!.indexdef, /hnsw/);
  assert.equal(
    (
      await call(
        "GET",
        `/knowledge-bases/${kbId}`,
        undefined,
        sessions.outsider,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await call("GET", `/knowledge-bases/${kbId}`, undefined, sessions.viewer))
      .statusCode,
    403,
  );
});
test("Manual Q&A is queued durably, ingested to vectors and retrieved with provenance", async () => {
  const added = await call("POST", `/knowledge-bases/${kbId}/qa`, {
    question: "What is the refund policy?",
    answer: "Customers can request a refund within 30 days.",
    tags: ["policy"],
  });
  assert.equal(added.statusCode, 202);
  qaId = added.json().id;
  const [pending] =
    await sql`SELECT status FROM knowledge_jobs WHERE source_id=${qaId}`;
  assert.equal(pending!.status, "queued");
  assert.equal(await processKnowledgeJob(embedding), true);
  const sources = (
    await call("GET", `/knowledge-bases/${kbId}/sources`)
  ).json();
  assert.equal(sources[0].status, "ready");
  assert.equal(sources[0].chunk_count, 1);
  const search = await call("POST", `/knowledge-bases/${kbId}/search`, {
    query: "refund within 30 days",
    mode: "hybrid",
  });
  assert.equal(search.statusCode, 200, search.body);
  const results = search.json().results;
  assert.equal(results.length, 1);
  assert.equal(results[0].sourceId, qaId);
  assert.equal(results[0].title, "What is the refund policy?");
  assert.match(results[0].content, /30 days/);
  assert.equal(results[0].knowledgeBaseId, kbId);
  assert.ok(results[0].vectorScore > 0.99);
  assert.ok(search.json().latencyMs >= 0);
  assert.equal(
    (
      await call(
        "POST",
        `/knowledge-bases/${kbId}/search`,
        { query: "refund" },
        sessions.viewer,
      )
    ).statusCode,
    403,
  );
  const exportCSV = await call("GET", `/knowledge-bases/${kbId}/qa/export`);
  assert.match(exportCSV.body, /question,answer,tags/);
});
test("Dimension mismatches fail ingestion without storing incompatible chunks", async () => {
  const added = await call("POST", `/knowledge-bases/${kbId}/text`, {
    title: "Invalid vector fixture",
    text: "A different source",
  });
  wrongDimension = true;
  try {
    await processKnowledgeJob(embedding);
  } finally {
    wrongDimension = false;
  }
  const [source] =
    await sql`SELECT status,error_code FROM knowledge_sources WHERE id=${added.json().id}`;
  assert.equal(source!.status, "failed");
  assert.equal(source!.error_code, "EMBEDDING_DIMENSION_MISMATCH");
  const [count] =
    await sql`SELECT count(*)::int AS n FROM knowledge_chunks WHERE source_id=${added.json().id}`;
  assert.equal(count!.n, 0);
  assert.equal(
    (
      await call(
        "POST",
        `/knowledge-bases/${kbId}/sources/${added.json().id}/reingest`,
      )
    ).statusCode,
    200,
  );
  await processKnowledgeJob(embedding);
  const [ready] =
    await sql`SELECT status FROM knowledge_sources WHERE id=${added.json().id}`;
  assert.equal(ready!.status, "ready");
});
test("Rate-limited embedding jobs retry with a persisted backoff and recover worker leases", async () => {
  const added = await call("POST", `/knowledge-bases/${kbId}/text`, {
    title: "Retry fixture",
    text: "Refund guide",
  });
  retryEmbedding = true;
  try {
    await processKnowledgeJob(embedding);
  } finally {
    retryEmbedding = false;
  }
  const [job] =
    await sql`SELECT * FROM knowledge_jobs WHERE source_id=${added.json().id}`;
  assert.equal(job!.status, "queued");
  assert.equal(job!.attempts, 1);
  assert.equal(job!.error_code, "RATE_LIMITED");
  assert.ok(job!.available_at > job!.created_at);
  await sql`UPDATE knowledge_jobs SET available_at=now() WHERE id=${job!.id}`;
  const claimed = await claimKnowledgeJob();
  assert.equal(claimed!.id, job!.id);
  await sql`UPDATE knowledge_jobs SET locked_until=now()-interval '1 second' WHERE id=${job!.id}`;
  await processKnowledgeJob(embedding);
  const [completed] =
    await sql`SELECT status,attempts FROM knowledge_jobs WHERE id=${job!.id}`;
  assert.equal(completed!.status, "completed");
  assert.equal(completed!.attempts, 3);
});
test("Agent attachment rejects foreign knowledge and public deployment requires explicit knowledge access", async () => {
  const model = await call("POST", `/workspaces/${workspace}/models`, {
    name: "Chat fixture",
    provider: "openai",
    modelId: "fixture",
    secretId: (
      await sql`SELECT id FROM secrets WHERE workspace_id=${workspace}`
    )[0]!.id,
  });
  chatModel = model.json().id;
  const config = agentConfig.parse({
    modelId: chatModel,
    rag: { knowledgeBaseIds: [kbId], topK: 1, minScore: 0.1 },
  });
  assert.equal(
    (
      await call("POST", `/workspaces/${workspace}/agents`, {
        name: "Bad knowledge",
        config: {
          ...config,
          rag: { ...config.rag, knowledgeBaseIds: [randomUUID()] },
        },
      })
    ).statusCode,
    404,
  );
  const created = await call("POST", `/workspaces/${workspace}/agents`, {
    name: "Policy assistant",
    config,
  });
  assert.equal(created.statusCode, 201);
  agentId = created.json().id;
  const version = (
    await call("POST", `/agents/${agentId}/publish`, { revision: 1 })
  ).json();
  assert.equal(
    (
      await call("POST", `/agents/${agentId}/deployments`, {
        versionId: version.id,
        name: "Policies",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call("PUT", `/knowledge-bases/${kbId}`, {
        name: "Policies",
        publicAccess: true,
        revision: 1,
      })
    ).statusCode,
    200,
  );
  const deployment = await call("POST", `/agents/${agentId}/deployments`, {
    versionId: version.id,
    name: "Policies",
  });
  assert.equal(deployment.statusCode, 201);
  deploymentId = deployment.json().id;
});
test("RAG assembles untrusted passages and persists actual cited references with the response", async () => {
  const response = await call("POST", `/agents/${agentId}/chat`, {
    message: "What is the refund policy within 30 days?",
  });
  const events = frames(response.body);
  assert.equal(events.at(-1)!.event, "done", response.body);
  assert.ok(events.some((e) => e.event === "sources"));
  assert.ok(receivedGrounding);
  assert.equal(events.at(-1)!.data.citations.length, 1);
  const [message] =
    await sql`SELECT citations FROM messages WHERE run_id=${events[0]!.data.runId} AND role='assistant'`;
  assert.equal(message!.citations[0].sourceId, qaId);
  const [run] =
    await sql`SELECT retrieval,retrieval_ms FROM agent_runs WHERE id=${events[0]!.data.runId}`;
  assert.equal(run!.retrieval.length, 1);
  assert.ok(run!.retrieval_ms >= 0);
  const publicChat = await call(
    "POST",
    `/public/deployments/${deploymentId}/chat`,
    { message: "refund within 30 days" },
    "",
  );
  assert.equal(frames(publicChat.body).at(-1)!.data.citations.length, 1);
});
test("Knowledge automatic skips greetings, retrieves policies and persists usage; disabled skips retrieval", async () => {
  const original = (await call("GET", `/agents/${agentId}`)).json();
  let revision = original.revision;
  const update = async (usageMode: string) => {
    const result = await call("PUT", `/agents/${agentId}`, {
      name: original.name,
      description: original.description,
      publicDescription: original.public_description,
      config: {
        ...original.draft_config,
        rag: {
          ...original.draft_config.rag,
          usageMode,
          usageInstructions: "Skip greetings; search policies",
        },
      },
      revision,
    });
    assert.equal(result.statusCode, 200, result.body);
    revision++;
  };
  try {
    await update("automatic");
    const greeting = await call("POST", `/agents/${agentId}/chat`, {
      message: "hi",
    });
    assert.equal(frames(greeting.body).at(-1)!.event, "done", greeting.body);
    assert(!greeting.body.includes("event: sources"));
    assert.equal(receivedGrounding, false);
    const policy = await call("POST", `/agents/${agentId}/chat`, {
      message: "refund within 30 days",
    });
    assert.equal(frames(policy.body).at(-1)!.event, "done", policy.body);
    assert(receivedGrounding);
    const [run] =
      await sql`SELECT input_tokens,output_tokens FROM agent_runs WHERE id=${frames(policy.body)[0]!.data.runId}`;
    assert.equal(run!.input_tokens, 15);
    assert.equal(run!.output_tokens, 11);
    await update("disabled");
    const disabled = await call("POST", `/agents/${agentId}/chat`, {
      message: "refund within 30 days",
    });
    assert.equal(frames(disabled.body).at(-1)!.event, "done", disabled.body);
    assert.equal(receivedGrounding, false);
    assert(!disabled.body.includes("event: sources"));
  } finally {
    await update("always");
  }
});
test("Workflow agent snapshots honor knowledge skip, retrieval and disabled policies", async () => {
  const [version] =
    await sql`SELECT * FROM agent_versions WHERE agent_id=${agentId} ORDER BY version DESC LIMIT 1`;
  const c = agentConfig.parse(version!.config);
  const model = modelSnapshotSchema.parse(version!.model_snapshot);
  const ctx = { workspaceId: workspace, organizationId: org };
  const signal = new AbortController().signal;
  c.rag.usageMode = "automatic";
  const greeting = await executeAgentSnapshot(
    c,
    model,
    "hi",
    ctx,
    signal,
    chat,
    embedding,
  );
  assert.equal(greeting.citations.length, 0);
  assert.equal(receivedGrounding, false);
  const policy = await executeAgentSnapshot(
    c,
    model,
    "refund within 30 days",
    ctx,
    signal,
    chat,
    embedding,
  );
  assert.equal(policy.citations.length, 1);
  assert.equal(receivedGrounding, true);
  c.rag.usageMode = "disabled";
  const disabled = await executeAgentSnapshot(
    c,
    model,
    "refund within 30 days",
    ctx,
    signal,
    chat,
    embedding,
  );
  assert.equal(disabled.citations.length, 0);
  assert.equal(receivedGrounding, false);
});
test("Missing citations and revoked public knowledge access are explicit failed runs", async () => {
  omitCitation = true;
  try {
    const response = await call("POST", `/agents/${agentId}/chat`, {
      message: "refund within 30 days",
    });
    assert.equal(frames(response.body).at(-1)!.data.code, "CITATION_REQUIRED");
  } finally {
    omitCitation = false;
  }
  await call("PUT", `/knowledge-bases/${kbId}`, {
    name: "Policies",
    publicAccess: false,
    revision: 2,
  });
  const response = await call(
    "POST",
    `/public/deployments/${deploymentId}/chat`,
    { message: "refund within 30 days" },
    "",
  );
  assert.equal(frames(response.body).at(-1)!.data.code, "KNOWLEDGE_NOT_PUBLIC");
});
test("Empty knowledge fails before generation and records NO_RELEVANT_SOURCES", async () => {
  const empty = await call("POST", `/workspaces/${workspace}/knowledge-bases`, {
    name: "Empty knowledge",
    embeddingModelId: modelId,
  });
  assert.equal(empty.statusCode, 201);
  const original = (await call("GET", `/agents/${agentId}`)).json();
  const payload = {
    name: original.name,
    description: original.description,
    publicDescription: original.public_description,
    config: original.draft_config,
  };
  const updated = await call("PUT", `/agents/${agentId}`, {
    ...payload,
    config: {
      ...payload.config,
      rag: { ...payload.config.rag, knowledgeBaseIds: [empty.json().id] },
    },
    revision: original.revision,
  });
  assert.equal(updated.statusCode, 200);
  const before = generationCalls;
  const response = await call("POST", `/agents/${agentId}/chat`, {
    message: "What is the refund policy?",
  });
  const events = frames(response.body);
  assert.equal(events.at(-1)!.data.code, "NO_RELEVANT_SOURCES");
  assert.equal(generationCalls, before);
  assert.equal(
    (
      await call("PUT", `/agents/${agentId}`, {
        ...payload,
        revision: updated.json().revision,
      })
    ).statusCode,
    200,
  );
});
test("Website crawling preserves canonical provenance and enforces robots and redirect rules", async () => {
  const visited: string[] = [];
  const server = createServer((req, res) => {
    visited.push(req.url ?? "");
    if (req.url === "/robots.txt") {
      res
        .writeHead(200, { "content-type": "text/plain" })
        .end("User-agent: *\nDisallow: /private\n");
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/policy" }).end();
      return;
    }
    res
      .writeHead(200, { "content-type": "text/html" })
      .end(
        req.url === "/details"
          ? "<html><title>Delivery guide</title><body><main>Shipping is free.</main></body></html>"
          : '<html><head><title>Refund guide</title><link rel="canonical" href="/canonical-policy"></head><body><main>Refunds within 30 days.<a href="/details">Details</a><a href="/private">Private</a></main></body></html>',
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const host = "127.0.0.1:" + address.port,
    previous = config.KNOWLEDGE_PRIVATE_HOSTS;
  config.KNOWLEDGE_PRIVATE_HOSTS = host;
  try {
    const added = await call("POST", `/knowledge-bases/${kbId}/website`, {
      url: "http://" + host + "/policy",
      maxPages: 3,
      maxDepth: 1,
    });
    assert.equal(added.statusCode, 202);
    await processKnowledgeJob(embedding);
    const [source] =
      await sql`SELECT status FROM knowledge_sources WHERE id=${added.json().id}`;
    assert.equal(source!.status, "ready");
    const documents =
      await sql`SELECT source_url FROM knowledge_documents WHERE source_id=${added.json().id}`;
    assert.equal(documents.length, 2);
    assert.ok(
      documents.some((d) => d.source_url.endsWith("/canonical-policy")),
    );
    assert.ok(!visited.includes("/private"));
    for (const [path, code] of [
      ["/redirect", "WEBSITE_REDIRECT_BLOCKED"],
      ["/private", "ROBOTS_DISALLOWED"],
    ]) {
      const failed = await call("POST", `/knowledge-bases/${kbId}/website`, {
        url: "http://" + host + path,
      });
      await processKnowledgeJob(embedding);
      const [s] =
        await sql`SELECT status,error_code FROM knowledge_sources WHERE id=${failed.json().id}`;
      assert.equal(s!.status, "failed");
      assert.equal(s!.error_code, code);
    }
  } finally {
    config.KNOWLEDGE_PRIVATE_HOSTS = previous;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test("Curated Q&A edits replace chunks atomically; deletion removes retrieval and cancels jobs", async () => {
  const updated = await call(
    "PUT",
    `/knowledge-bases/${kbId}/sources/${qaId}/qa`,
    {
      question: "What is the refund policy?",
      answer: "The refund window is now 45 days.",
      tags: ["policy"],
    },
  );
  assert.equal(updated.statusCode, 200);
  await processKnowledgeJob(embedding);
  const chunks = (
    await call("GET", `/knowledge-bases/${kbId}/sources/${qaId}/chunks`)
  ).json();
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].content, /45 days/);
  assert.doesNotMatch(chunks[0].content, /30 days/);
  const badImport = await call("POST", `/knowledge-bases/${kbId}/qa/import`, {
    csv: "question,answer\nValid,Answer\n,Missing question",
  });
  assert.equal(badImport.statusCode, 400);
  const goodImport = await call("POST", `/knowledge-bases/${kbId}/qa/import`, {
    csv: "question,answer,tags\nIs shipping free?,Shipping is free.,delivery",
  });
  assert.equal(goodImport.statusCode, 202);
  const pending = goodImport.json().sources[0].id;
  await call("DELETE", `/knowledge-bases/${kbId}/sources/${pending}`);
  const [job] =
    await sql`SELECT status FROM knowledge_jobs WHERE source_id=${pending}`;
  assert.equal(job!.status, "cancelled");
  await call("DELETE", `/knowledge-bases/${kbId}/sources/${qaId}`);
  const [count] =
    await sql`SELECT count(*)::int AS n FROM knowledge_chunks WHERE source_id=${qaId}`;
  assert.equal(count!.n, 0);
  await sql`UPDATE knowledge_sources SET updated_at=now()-interval '11 minutes' WHERE id=${qaId}`;
  assert.equal(await purgeDeletedKnowledge(), true);
  const [purged] =
    await sql`SELECT metadata,object_key FROM knowledge_sources WHERE id=${qaId}`;
  assert.equal(purged!.metadata.objectsPurged, true);
  assert.equal(purged!.object_key, null);
  assert.equal(
    (
      await call("POST", `/knowledge-bases/${kbId}/website`, {
        url: "http://169.254.169.254/latest/meta-data/",
      })
    ).statusCode,
    400,
  );
  await call("DELETE", `/knowledge-bases/${kbId}`);
  assert.equal((await call("GET", `/knowledge-bases/${kbId}`)).statusCode, 404);
});
