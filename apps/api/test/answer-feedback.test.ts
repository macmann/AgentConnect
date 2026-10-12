import { prepareCorrectionRegression } from "../src/knowledge-regressions.js";
import { executeAgentSnapshot } from "../src/workflow-agents.js";
import { modelSnapshotSchema } from "../src/agent-models.js";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest } from "../src/security.js";
import { agentConfig } from "@agentconnect/schemas/agents";
import { processKnowledgeJob } from "../src/ingestion.js";
import { processEvaluationRun } from "../src/quality-worker.js";
import { cleanupKnowledgeFixtures } from "./knowledge-cleanup.mjs";
import type { ProviderFactory } from "@agentconnect/provider-sdk";
import type { EmbeddingFactory } from "@agentconnect/provider-sdk/embeddings";
if (config.NODE_ENV === "production") throw new Error("No production fixtures");
const org = randomUUID(),
  workspace = randomUUID(),
  kb = randomUUID(),
  embeddingId = randomUUID(),
  model = randomUUID(),
  source = randomUUID(),
  doc = randomUUID();
const users: Record<string, string> = {},
  sessions: Record<string, string> = {};
let agent = "",
  deployment = "",
  customerToken = "",
  conversation = "",
  messageId = "",
  issueId = "",
  improvementId = "",
  candidate = "",
  bootstrap = "",
  wrong = true;
const provider: ProviderFactory = () => ({
  async *stream(input) {
    yield {
      type: "token",
      text:
        input.system.includes("Branch KYC") && !wrong
          ? "Branch KYC is required [1]"
          : "Reset online [1].",
    };
    yield { type: "usage", inputTokens: 10, outputTokens: 8 };
  },
});
const embedding: EmbeddingFactory = () => ({
  async embed(texts) {
    return texts.map(() => [1, 0, 0]);
  },
});
const app = await buildApp({
  providerFactory: provider,
  embeddingFactory: embedding,
});
const ip = `127.${randomBytes(1)[0]}.${randomBytes(1)[0]}.71`;
async function call(
  method: "GET" | "POST" | "PUT",
  url: string,
  body?: unknown,
  role = "owner",
  headers: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    remoteAddress: ip,
    headers: {
      origin: config.WEB_ORIGIN,
      ...(sessions[role] ? { cookie: "session=" + sessions[role] } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { payload: JSON.stringify(body) } : {}),
  });
}
const guest = () => ({
  authorization: "Bearer " + customerToken,
  "x-customer-token": customerToken,
});
const queueBase = `/workspaces/${workspace}/operations/answer-issues`;
const releaseBase = `/knowledge-bases/${kb}/releases`;
async function release(sources: string[]) {
  const created = await call("POST", releaseBase, {
    name: "Reviewed correction",
    sourceIds: sources,
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id;
  assert.equal(
    (
      await call("POST", releaseBase + "/" + id + "/transition", {
        action: "submit",
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "POST",
        releaseBase + "/" + id + "/transition",
        { action: "approve" },
        "reviewer",
      )
    ).statusCode,
    200,
  );
  return id;
}
async function publicChat() {
  const r = await call(
    "POST",
    `/public/deployments/${deployment}/chat`,
    { message: "I forgot my password." },
    "guest",
    guest(),
  );
  assert.equal(r.statusCode, 200, r.body);
  const frames = r.body
    .split("\n\n")
    .filter((f) => f.includes("data: "))
    .map((f) => ({
      event: f.split("\n")[0]!.slice(7),
      data: JSON.parse(
        f
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice(6),
      ),
    }));
  const meta = frames.find((f) => f.event === "meta")!.data;
  conversation = meta.conversationId;
  const done = frames.find((f) => f.event === "done");
  assert.ok(done, r.body);
  messageId = done.data.messageId;
  return r;
}
before(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES(${org},'Answer feedback fixtures')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES(${workspace},${org},'Feedback workspace')`;
    for (const role of ["owner", "reviewer", "analyst", "outsider"]) {
      users[role] = randomUUID();
      sessions[role] = randomUUID();
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES(${users[role]!},${users[role]! + "@example.invalid"},${role},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(${digest(sessions[role]!)},${users[role]!},now()+interval '1 hour')`;
      if (role !== "outsider")
        await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES(${randomUUID()},${org},${role === "owner" ? null : workspace},${users[role]!},${role === "reviewer" ? "workspace_admin" : role})`;
    }
    await tx`INSERT INTO embedding_models(id,organization_id,workspace_id,name,provider,model_id,base_url,dimensions) VALUES(${embeddingId},${org},${workspace},'Fixture','openai-compatible','fixture','https://api.deepseek.com',3)`;
    await tx`INSERT INTO knowledge_bases(id,organization_id,workspace_id,name,description,embedding_model_id,dimensions,chunk_size,chunk_overlap,chunk_strategy,public_access,approval_required) VALUES(${kb},${org},${workspace},'Recovery','Approved recovery',${embeddingId},3,1600,200,'recursive',true,true)`;
    await tx`INSERT INTO knowledge_sources(id,knowledge_base_id,organization_id,workspace_id,kind,title,status) VALUES(${source},${kb},${org},${workspace},'text','Recovery','ready')`;
    await tx`INSERT INTO knowledge_documents(id,source_id,knowledge_base_id,organization_id,workspace_id,title,metadata,page_count,content_hash,revision) VALUES(${doc},${source},${kb},${org},${workspace},'Recovery',${tx.json({})},1,'fixture',1)`;
    await tx`INSERT INTO knowledge_chunks(id,document_id,source_id,knowledge_base_id,workspace_id,organization_id,embedding_model_id,dimensions,ordinal,content,metadata,embedding) VALUES(${randomUUID()},${doc},${source},${kb},${workspace},${org},${embeddingId},3,0,'Password recovery screen.',${tx.json({})},'[1,0,0]'::vector)`;
    await tx`INSERT INTO model_configurations(id,organization_id,workspace_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES(${model},${org},${workspace},'Fixture','openai-compatible','fixture','https://api.deepseek.com',32768,4096,${tx.json({ temperature: true, topP: true })})`;
  });
  bootstrap = await release([source]);
  assert.equal(
    (
      await call(
        "POST",
        releaseBase + "/" + bootstrap + "/transition",
        { action: "publish" },
        "reviewer",
      )
    ).statusCode,
    200,
  );
  const a = await call("POST", `/workspaces/${workspace}/agents`, {
    name: "Password recovery",
    config: agentConfig.parse({
      modelId: model,
      rag: { knowledgeBaseIds: [kb], requireCitations: true },
    }),
  });
  assert.equal(a.statusCode, 201, a.body);
  agent = a.json().id;
  const v = await call("POST", `/agents/${agent}/publish`, { revision: 1 });
  assert.equal(v.statusCode, 201, v.body);
  const d = await call("POST", `/agents/${agent}/deployments`, {
    name: "Customer chat",
    versionId: v.json().id,
  });
  assert.equal(d.statusCode, 201, d.body);
  deployment = d.json().id;
  const session = await call(
    "POST",
    `/public/deployments/${deployment}/sessions`,
    {},
    "guest",
  );
  customerToken = session.json().token;
  await publicChat();
});
after(async () => {
  try {
    await cleanupKnowledgeFixtures(sql, org);
    await sql.begin(async (tx) => {
      for (const table of [
        "evaluation_results",
        "evaluation_runs",
        "knowledge_improvements",
        "conversation_reviews",
        "handoff_events",
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
        "evaluation_datasets",
        "embedding_models",
        "audit_events",
        "memberships",
        "workspaces",
      ])
        await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
      await tx`DELETE FROM organizations WHERE id=${org}`;
      await tx`DELETE FROM users WHERE id=ANY(${Object.values(users)}::uuid[])`;
    });
  } finally {
    await app.close();
    await sql.end();
  }
});
test("Answer reports are scoped, idempotent, privately reviewed and enforce claim/revision checks", async () => {
  const path = `/public/deployments/${deployment}/conversations/${conversation}/answer-reports/${messageId}`;
  const bad = await call("POST", path, { reason: "incorrect" }, "guest", {
    authorization: "Bearer " + randomUUID(),
  });
  assert.equal(bad.statusCode, 404);
  const missing = await call(
    "POST",
    path.replace(messageId, randomUUID()),
    { reason: "incorrect" },
    "guest",
    guest(),
  );
  assert.equal(missing.statusCode, 404);
  const report = await call(
    "POST",
    path,
    { reason: "incorrect", comment: "Branch verification is missing." },
    "guest",
    guest(),
  );
  assert.equal(report.statusCode, 200, report.body);
  issueId = report.json().id;
  const again = await call(
    "POST",
    path,
    { reason: "incorrect", comment: "Branch verification is missing." },
    "guest",
    guest(),
  );
  assert.equal(again.json().id, issueId);
  assert.equal(
    (await call("GET", queueBase, undefined, "outsider")).statusCode,
    403,
  );
  const claims = await Promise.all(
    ["owner", "reviewer"].map((role) =>
      call(
        "POST",
        queueBase + "/" + issueId,
        { action: "claim", revision: 1 },
        role,
      ),
    ),
  );
  assert.deepEqual(claims.map((r) => r.statusCode).sort(), [200, 409]);
  const [i] =
    await sql`SELECT assigned_to,revision FROM answer_issues WHERE id=${issueId}`;
  if (i!.assigned_to !== users.owner) {
    await call(
      "POST",
      queueBase + "/" + issueId,
      { action: "release", revision: i!.revision },
      "reviewer",
    );
    const [latest] =
      await sql`SELECT revision FROM answer_issues WHERE id=${issueId}`;
    assert.equal(
      (
        await call("POST", queueBase + "/" + issueId, {
          action: "claim",
          revision: latest!.revision,
        })
      ).statusCode,
      200,
    );
  }
  const pub = await call("GET", path, undefined, "guest", guest());
  assert.deepEqual(Object.keys(pub.json()).sort(), ["id", "reason", "status"]);
  const update = await call(
    "POST",
    path,
    {
      reason: "incorrect",
      comment: "Branch verification is missing. Please check KYC.",
    },
    "guest",
    guest(),
  );
  assert.equal(update.json().id, issueId);
  const [details] =
    await sql`SELECT comment FROM answer_issues WHERE id=${issueId}`;
  assert.match(details!.comment, /check KYC/);
  const [current] =
    await sql`SELECT revision FROM answer_issues WHERE id=${issueId}`;
  assert.equal(
    (
      await call("POST", queueBase + "/" + issueId, {
        action: "close",
        revision: current!.revision,
        note: "Not verified",
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await call(
        "POST",
        queueBase + "/" + issueId + "/correction",
        {
          revision: current!.revision,
          knowledgeBaseId: kb,
          question: "I forgot my password.",
          answer: "Branch KYC is required.",
          reason: "Approved recovery procedure requires branch KYC.",
        },
        "analyst",
      )
    ).statusCode,
    403,
  );
  const correction = await call(
    "POST",
    queueBase + "/" + issueId + "/correction",
    {
      revision: current!.revision,
      knowledgeBaseId: kb,
      question: "I forgot my password.",
      answer: "Branch KYC is required",
      reason: "Approved recovery procedure requires branch KYC.",
    },
  );
  assert.equal(correction.statusCode, 201, correction.body);
  improvementId = correction.json().id;
});
test("Approved corrections create reusable regressions; preview tests cannot publish or bypass gates", async () => {
  const improvement = `/workspaces/${workspace}/operations/knowledge-improvements/${improvementId}`;
  assert.equal(
    (await call("POST", improvement, { action: "approve" })).statusCode,
    409,
  );
  assert.equal(
    (await call("POST", improvement, { action: "approve" }, "reviewer"))
      .statusCode,
    200,
  );
  const materialized = await call(
    "POST",
    improvement,
    { action: "materialize" },
    "reviewer",
  );
  assert.equal(materialized.statusCode, 200, materialized.body);
  assert.equal(await processKnowledgeJob(embedding), true);
  const [correction] =
    await sql`SELECT source_id FROM knowledge_improvements WHERE id=${improvementId}`;
  candidate = await release([source, correction!.source_id]);
  const verification = await call(
    "GET",
    releaseBase + "/" + candidate + "/verification",
  );
  assert.equal(verification.statusCode, 200, verification.body);
  const info = verification.json();
  assert.equal(info.targets.length, 2);
  assert.equal(info.dataset.revision, 2);
  const [d] =
    await sql`SELECT examples FROM evaluation_datasets WHERE id=${info.dataset.id}`;
  assert.equal(d!.examples[0].id, improvementId);
  const publish = () =>
    call(
      "POST",
      releaseBase + "/" + candidate + "/transition",
      { action: "publish" },
      "reviewer",
    );
  assert.equal((await publish()).statusCode, 409);
  async function evaluateAll() {
    for (const t of info.targets) {
      const queued = await call(
        "POST",
        `/workspaces/${workspace}/evaluations`,
        {
          agentId: t.agentId,
          revision: t.revision,
          datasetId: info.dataset.id,
          candidateReleaseId: candidate,
          ...(t.versionId ? { candidateVersionId: t.versionId } : {}),
          evaluator: { mode: "deterministic", minScore: 1 },
        },
      );
      assert.equal(queued.statusCode, 202, queued.body);
      assert.equal(await processEvaluationRun(provider, embedding), true);
    }
  }
  await evaluateAll();
  assert.equal((await publish()).statusCode, 409);
  const [live] =
    await sql`SELECT published_release_id FROM knowledge_bases WHERE id=${kb}`;
  assert.equal(live!.published_release_id, bootstrap);
  const [preview] =
    await sql`SELECT config_snapshot,model_snapshot FROM evaluation_runs WHERE candidate_release_id=${candidate} LIMIT 1`;
  await assert.rejects(
    executeAgentSnapshot(
      agentConfig.parse(preview!.config_snapshot),
      modelSnapshotSchema.parse(preview!.model_snapshot),
      "I forgot my password.",
      {
        workspaceId: workspace,
        organizationId: org,
        publicAccess: true,
        userId: users.owner,
      },
      new AbortController().signal,
      provider,
      embedding,
      candidate,
    ),
    { statusCode: 400 },
  );
  const [dataset] =
    await sql`SELECT * FROM evaluation_datasets WHERE id=${info.dataset.id}`;
  const missingChecks = dataset!.examples.map((e: Record<string, unknown>) => ({
    ...e,
    expectedAnswer: undefined,
    contains: [],
    forbidden: [],
  }));
  const edited = await call(
    "PUT",
    `/workspaces/${workspace}/datasets/${info.dataset.id}`,
    {
      revision: dataset!.revision,
      dataset: {
        name: dataset!.name,
        description: dataset!.description,
        examples: missingChecks,
      },
    },
  );
  assert.equal(edited.statusCode, 200, edited.body);
  const noChecks = await call("POST", `/workspaces/${workspace}/evaluations`, {
    agentId: agent,
    revision: 1,
    datasetId: info.dataset.id,
    candidateReleaseId: candidate,
    evaluator: { mode: "deterministic", minScore: 1 },
  });
  assert.equal(noChecks.statusCode, 409, noChecks.body);
  assert.equal(
    (
      await call(
        "PUT",
        `/workspaces/${workspace}/datasets/${info.dataset.id}`,
        {
          revision: edited.json().revision,
          dataset: {
            name: dataset!.name,
            description: dataset!.description,
            examples: dataset!.examples,
          },
        },
      )
    ).statusCode,
    200,
  );
  wrong = false;
  await evaluateAll();
  // A changed dependency invalidates passing evidence even though the release snapshot is unchanged.
  await sql`UPDATE model_configurations SET revision=revision+1 WHERE id=${model}`;
  assert.equal((await publish()).statusCode, 409);
  await evaluateAll();
  const saved = await publish();
  assert.equal(saved.statusCode, 200, saved.body);
  const state = await call("GET", queueBase + "/" + issueId);
  assert.equal(state.json().status, "verified");
  assert.equal(state.json().verification_release_id, candidate);
  const closed = await call("POST", queueBase + "/" + issueId, {
    action: "close",
    revision: state.json().revision,
    note: "Reviewed regression replay and published corrected guidance.",
  });
  assert.equal(closed.statusCode, 200, closed.body);
  const path = `/public/deployments/${deployment}/conversations/${conversation}/answer-reports/${messageId}`;
  const reopened = await call(
    "POST",
    path,
    { reason: "unresolved", comment: "The problem is still present." },
    "guest",
    guest(),
  );
  assert.equal(reopened.json().status, "reported");
  assert.equal(reopened.json().id, issueId);
});
test("Negative conversation feedback creates an answer issue and explicit report consent requests support", async () => {
  await publicChat();
  const feedback = await call(
    "PUT",
    `/public/deployments/${deployment}/conversations/${conversation}/feedback`,
    { rating: 1, resolved: false, comment: "Still unresolved" },
    "guest",
    guest(),
  );
  assert.equal(feedback.statusCode, 200, feedback.body);
  const [i] =
    await sql`SELECT id,reason FROM answer_issues WHERE message_id=${messageId}`;
  assert.equal(i!.reason, "unresolved");
  const requested = await call(
    "POST",
    `/public/deployments/${deployment}/conversations/${conversation}/answer-reports/${messageId}`,
    { reason: "unresolved", requestSupport: true },
    "guest",
    guest(),
  );
  assert.equal(requested.statusCode, 200, requested.body);
  assert.equal(requested.json().supportRequested, true);
  const [s] =
    await sql`SELECT status FROM support_cases WHERE conversation_id=${conversation}`;
  assert.ok(s);
  await sql`INSERT INTO support_policies(id,workspace_id,organization_id,scope,target_id,policy) VALUES(${randomUUID()},${workspace},${org},'workspace',${workspace},${sql.json({ humanEntryMode: "disabled" })})`;
  await publicChat();
  const unavailable = await call(
    "POST",
    `/public/deployments/${deployment}/conversations/${conversation}/answer-reports/${messageId}`,
    { reason: "unresolved", requestSupport: true },
    "guest",
    guest(),
  );
  assert.equal(unavailable.statusCode, 200, unavailable.body);
  assert.equal(unavailable.json().supportRequested, false);
  assert.ok(unavailable.json().id);
});

test("First regression setup includes legacy materialized corrections without changing the existing dataset", async () => {
  const legacyId = randomUUID(),
    reviewId = randomUUID();
  const [original] =
    await sql`SELECT dataset_id FROM knowledge_regression_datasets WHERE knowledge_base_id=${kb}`;
  const rollback = new Error("ROLLBACK_FIXTURE");
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`DELETE FROM knowledge_regression_datasets WHERE knowledge_base_id=${kb}`;
      await tx`INSERT INTO conversation_reviews(id,workspace_id,organization_id,message_id,reviewer_id,corrected_response,reason,comment) VALUES(${reviewId},${workspace},${org},${messageId},${users.owner!},'Legacy approved guidance','Legacy review','')`;
      await tx`INSERT INTO knowledge_improvements(id,workspace_id,organization_id,review_id,knowledge_base_id,question,answer,author_id,status,source_id) VALUES(${legacyId},${workspace},${org},${reviewId},${kb},'Legacy recovery question','Legacy approved guidance',${users.owner!},'materialized',${source})`;
      const data = await prepareCorrectionRegression(tx, {
        id: randomUUID(),
        knowledge_base_id: kb,
        workspace_id: workspace,
        organization_id: org,
        question: "New question",
        answer: "New approved answer",
      });
      assert.ok(data.cases.some((e) => e.id === legacyId));
      assert.ok(data.cases.some((e) => e.id === improvementId));
      throw rollback;
    }),
    (e) => e === rollback,
  );
  const [restored] =
    await sql`SELECT dataset_id FROM knowledge_regression_datasets WHERE knowledge_base_id=${kb}`;
  assert.equal(restored!.dataset_id, original!.dataset_id);
});
