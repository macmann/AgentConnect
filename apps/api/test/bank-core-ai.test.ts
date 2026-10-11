import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest } from "../src/security.js";
import { agentConfig } from "@agentconnect/schemas/agents";
import { bankingTemplates } from "@agentconnect/schemas/bank-experience";
import { advanceJourney } from "../src/bank-runtime.js";
import { PostgresRagTool } from "../src/knowledge-core.js";
import { executeAgentSnapshot } from "../src/workflow-agents.js";
import { modelSnapshot } from "../src/agents.js";
import type { EmbeddingFactory } from "@agentconnect/provider-sdk/embeddings";
import type { ProviderFactory } from "@agentconnect/provider-sdk";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  workspace = randomUUID(),
  kb = randomUUID(),
  embeddingId = randomUUID(),
  source = randomUUID(),
  model = randomUUID(),
  agent = randomUUID();
const users = Object.fromEntries(
    ["owner", "reviewer", "builder", "outsider"].map((k) => [k, randomUUID()]),
  ),
  sessions: Record<string, string> = {};
let answer = {
    kind: "answer",
    message: "Use the approved recovery screen [1].",
  },
  calls = 0,
  release1 = "",
  release2 = "",
  agentRevision = 1;
const embedding: EmbeddingFactory = () => ({
  async embed(texts) {
    return texts.map((t) => (t.includes("unrelated") ? [0, 1, 0] : [1, 0, 0]));
  },
});
const provider: ProviderFactory = () => ({
  async *stream() {
    calls++;
    yield { type: "token", text: JSON.stringify(answer) };
    yield { type: "usage", inputTokens: 8, outputTokens: 6 };
  },
});
const app = await buildApp({
  embeddingFactory: embedding,
  providerFactory: provider,
});
const ip = `127.${randomBytes(1)[0]}.${randomBytes(1)[0]}.43`;
const current = () =>
  agentConfig.parse({
    modelId: model,
    rag: {
      knowledgeBaseIds: [kb],
      contentMode: "approved",
      releasePins: { [kb]: release1 },
    },
    answerPolicy: { mode: "grounded" },
    quickActions: bankingTemplates.actions,
    journeys: bankingTemplates.journeys,
  });
async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
  role = "owner",
  extra: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    remoteAddress: ip,
    headers: {
      origin: config.WEB_ORIGIN,
      cookie: `session=${sessions[role]}`,
      ...extra,
    },
    ...(payload === undefined
      ? {}
      : {
          payload: JSON.stringify(payload),
          headers: {
            origin: config.WEB_ORIGIN,
            cookie: `session=${sessions[role]}`,
            "content-type": "application/json",
            ...extra,
          },
        }),
  });
}
async function transition(
  rid: string,
  action: string,
  role = "reviewer",
  note = "Reviewed approved bank guidance",
) {
  return call(
    "POST",
    `/knowledge-bases/${kb}/releases/${rid}/transition`,
    { action, note },
    role,
  );
}
async function makeRelease(name: string) {
  const r = await call("POST", `/knowledge-bases/${kb}/releases`, {
    name,
    sourceIds: [source],
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().id as string;
}
function frames(body: string) {
  return body
    .split("\n\n")
    .filter((f) => f.startsWith("event:"))
    .map((f) => ({
      event: f.split("\n")[0]!.slice(7),
      data: JSON.parse(f.split("\n")[1]!.slice(6)),
    }));
}
async function chat(
  message: string,
  conversationId?: string,
  quickActionId?: string,
) {
  const r = await call("POST", `/agents/${agent}/chat`, {
    message,
    ...(conversationId ? { conversationId } : {}),
    ...(quickActionId ? { quickActionId } : {}),
  });
  assert.equal(r.statusCode, 200, r.body);
  return frames(r.body);
}
async function save(c = current()) {
  const r = await call("PUT", `/agents/${agent}`, {
    name: "Bank fixture",
    description: "",
    publicDescription: "",
    config: c,
    revision: agentRevision,
  });
  assert.equal(r.statusCode, 200, r.body);
  agentRevision = r.json().revision;
}
before(async () => {
  await sql.begin(async (tx) => {
    for (const [role, uid] of Object.entries(users)) {
      const raw = randomUUID();
      sessions[role] = raw;
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${uid},${uid + "@example.com"},${role},'fixture-not-login',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(raw)},${uid},now()+interval '1 hour')`;
    }
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Bank AI fixtures')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Bank AI fixtures')`;
    for (const role of ["owner", "reviewer", "builder"])
      await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${role === "owner" ? null : workspace},${users[role]!},${role === "reviewer" ? "workspace_admin" : role})`;
    await tx`INSERT INTO embedding_models(id,organization_id,workspace_id,name,provider,model_id,base_url,dimensions) VALUES (${embeddingId},${org},${workspace},'Fixture','openai-compatible','fixture','https://api.deepseek.com',3)`;
    await tx`INSERT INTO knowledge_bases(id,organization_id,workspace_id,name,description,embedding_model_id,dimensions,chunk_size,chunk_overlap,chunk_strategy,public_access,approval_required) VALUES (${kb},${org},${workspace},'Recovery guidance','Bank approved guidance',${embeddingId},3,1600,200,'recursive',true,true)`;
    await tx`INSERT INTO knowledge_sources(id,knowledge_base_id,organization_id,workspace_id,kind,title,status) VALUES (${source},${kb},${org},${workspace},'text','Recovery','ready')`;
    const doc = randomUUID();
    await tx`INSERT INTO knowledge_documents(id,source_id,knowledge_base_id,organization_id,workspace_id,title,metadata,page_count,content_hash,revision) VALUES (${doc},${source},${kb},${org},${workspace},'Recovery',${tx.json({})},1,'fixture',1)`;
    await tx`INSERT INTO knowledge_chunks(id,document_id,source_id,knowledge_base_id,workspace_id,organization_id,embedding_model_id,dimensions,ordinal,content,metadata,embedding) VALUES (${randomUUID()},${doc},${source},${kb},${workspace},${org},${embeddingId},3,0,'Use the approved recovery screen.',${tx.json({})},'[1,0,0]'::vector)`;
    await tx`INSERT INTO model_configurations(id,organization_id,workspace_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES (${model},${org},${workspace},'Fixture','openai-compatible','fixture','https://api.deepseek.com',32768,4096,${tx.json({ streaming: true, temperature: true, topP: true })})`;
    await tx`INSERT INTO agents(id,organization_id,workspace_id,name,description,public_description,draft_config,created_by) VALUES (${agent},${org},${workspace},'Bank fixture','','',${tx.json(agentConfig.parse({ modelId: model }))},${users.owner!})`;
  });
});
after(async () => {
  try {
    await sql.begin(async (tx) => {
      for (const table of [
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
  }
});
test("Governed knowledge does not retrieve indexed drafts before publication", async () => {
  await assert.rejects(
    new PostgresRagTool(embedding).execute(
      "recovery",
      [kb],
      { topK: 5, minScore: 0, mode: "hybrid" },
      { workspaceId: workspace, organizationId: org, publicAccess: false },
      AbortSignal.timeout(5000),
    ),
    (e: unknown) =>
      (e as { code: string }).code === "KNOWLEDGE_RELEASE_UNAVAILABLE",
  );
});
test("Release authors, tenant boundaries and ready-source validation are enforced", async () => {
  assert.equal(
    (
      await call("POST", `/knowledge-bases/${kb}/releases`, {
        name: "Bad",
        sourceIds: [randomUUID()],
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await call(
        "GET",
        `/knowledge-bases/${kb}/releases`,
        undefined,
        "outsider",
      )
    ).statusCode,
    403,
  );
  release1 = await makeRelease("Initial recovery");
  assert.equal((await transition(release1, "publish")).statusCode, 409);
  assert.equal((await transition(release1, "submit", "owner")).statusCode, 200);
  assert.equal(
    (await transition(release1, "approve", "owner")).statusCode,
    403,
  );
  assert.equal(
    (await transition(release1, "approve", "builder")).statusCode,
    403,
  );
  assert.equal((await transition(release1, "approve")).statusCode, 200);
  assert.equal((await transition(release1, "approve")).statusCode, 409);
  assert.equal((await transition(release1, "publish")).statusCode, 200);
});
test("Agents reject mismatched/unpublished release pins before publication", async () => {
  const c = current();
  c.rag.releasePins[kb] = randomUUID();
  assert.equal(
    (
      await call("PUT", `/agents/${agent}`, {
        name: "Bank fixture",
        config: c,
        revision: agentRevision,
      })
    ).statusCode,
    400,
  );
  await save();
});
test("Release snapshots survive current source revision edits, and live pointer rollback preserves pins", async () => {
  await sql`UPDATE knowledge_chunks SET content='Use the new recovery procedure.' WHERE source_id=${source}`;
  await sql`UPDATE knowledge_sources SET revision=revision+1 WHERE id=${source}`;
  release2 = await makeRelease("Changed recovery");
  for (const action of ["submit", "approve", "publish"])
    assert.equal(
      (
        await transition(
          release2,
          action,
          action === "submit" ? "owner" : "reviewer",
        )
      ).statusCode,
      200,
    );
  const rag = new PostgresRagTool(embedding),
    ctx = { workspaceId: workspace, organizationId: org, publicAccess: false };
  const pinned = await rag.execute(
    "recovery",
    [kb],
    current().rag,
    ctx,
    AbortSignal.timeout(5000),
  );
  assert.match(pinned[0]!.content, /approved recovery screen/);
  const latest = await rag.execute(
    "recovery",
    [kb],
    { ...current().rag, releasePins: {} },
    ctx,
    AbortSignal.timeout(5000),
  );
  assert.match(latest[0]!.content, /new recovery procedure/);
  assert.equal((await transition(release1, "publish")).statusCode, 200);
  const restored = await rag.execute(
    "recovery",
    [kb],
    { ...current().rag, releasePins: {} },
    ctx,
    AbortSignal.timeout(5000),
  );
  assert.match(restored[0]!.content, /approved recovery screen/);
});
test("Review rejection requires a note and is terminal", async () => {
  const rid = await makeRelease("Rejected");
  assert.equal((await transition(rid, "submit", "owner")).statusCode, 200);
  assert.equal(
    (await transition(rid, "reject", "reviewer", "")).statusCode,
    400,
  );
  assert.equal((await transition(rid, "reject")).statusCode, 200);
  assert.equal((await transition(rid, "publish")).statusCode, 409);
});
test("Grounded answer validates citations before streaming and records actual usage", async () => {
  const result = await chat("How do I recover access?");
  assert.ok(result.some((f) => f.event === "done"));
  assert.equal(result.filter((f) => f.event === "token").length, 1);
  assert.match(result.find((f) => f.event === "token")!.data.text, /\[1\]/);
  assert.equal(result.find((f) => f.event === "done")!.data.inputTokens, 8);
});
test("Clarification is valid without pretending to have answered with a citation", async () => {
  answer = { kind: "clarify", message: "Which service are you using?" };
  const result = await chat("I cannot access it");
  assert.ok(result.some((f) => f.event === "done"));
  assert.equal(
    result.find((f) => f.event === "token")!.data.text,
    answer.message,
  );
});
test("Uncited or invented-reference answers never reach customer token events", async () => {
  for (const message of ["Invented procedure", "Procedure [99]"]) {
    answer = { kind: "answer", message };
    const result = await chat("Recovery");
    assert.equal(result.filter((f) => f.event === "token").length, 0);
    assert.equal(
      result.find((f) => f.event === "error")!.data.code,
      "GROUNDED_RESPONSE_INVALID",
    );
  }
});
test("No-answer fallback creates a confirmation offer without taking human control", async () => {
  answer = { kind: "no_answer", message: "Model arbitrary fallback" };
  const result = await chat("Can you explain another rule?");
  const c = result.find((f) => f.event === "meta")!.data.conversationId;
  assert.equal(
    result.find((f) => f.event === "token")!.data.text,
    current().answerPolicy.noAnswerResponse,
  );
  const state = await call("GET", `/conversations/${c}/handoff`);
  assert.equal(state.json().conversationMode, "ai");
  assert.equal(state.json().access.offer.reason_code, "knowledge_gap");
  assert.equal(
    (await call("POST", `/conversations/${c}/handoff`, { action: "request" }))
      .statusCode,
    201,
  );
  const [row] =
    await sql`SELECT conversation_mode FROM conversations WHERE id=${c}`;
  assert.equal(row!.conversation_mode, "waiting_human");
});
test("Empty retrieval skips generation and uses the friendly no-answer policy", async () => {
  const before = calls;
  const result = await chat("unrelated");
  assert.equal(calls, before);
  assert.ok(result.some((f) => f.event === "done"));
});
test("Disabled human policy blocks quick-action offers and subsequent requests", async () => {
  assert.equal(
    (
      await call("PUT", `/workspaces/${workspace}/support/policy`, {
        humanEntryMode: "disabled",
      })
    ).statusCode,
    200,
  );
  const result = await chat("Customer care", undefined, "customer_care");
  const c = result.find((f) => f.event === "meta")!.data.conversationId;
  assert.equal(
    (await call("GET", `/conversations/${c}/handoff`)).json().access.canRequest,
    false,
  );
  assert.equal(
    (await call("POST", `/conversations/${c}/handoff`, { action: "request" }))
      .statusCode,
    403,
  );
  await call("PUT", `/workspaces/${workspace}/support/policy`, {
    humanEntryMode: "policy_controlled",
  });
});
test("Transfer journey persists across requests, collects details once and offers handoff", async () => {
  const before = calls;
  let result = await chat("Transfer issue", undefined, "transfer_dispute");
  const c = result.find((f) => f.event === "meta")!.data.conversationId;
  for (const value of ["Next app", "2026-10-11", "REF-12345", "Pending"])
    result = await chat(value, c);
  assert.equal(calls, before);
  assert.match(
    result.find((f) => f.event === "token")!.data.text,
    /has not verified or changed/,
  );
  const [row] =
    await sql`SELECT journey_state FROM conversations WHERE id=${c}`;
  assert.equal(row!.journey_state.values.reference, "REF-12345");
  assert.equal(row!.journey_state.complete, true);
  assert.equal(
    (await call("GET", `/conversations/${c}/handoff`)).json().access.offer
      .reason_code,
    "required_intent",
  );
});
test("Guidance journeys retrieve using collected context after all questions", async () => {
  answer = { kind: "answer", message: "Use the approved recovery screen [1]." };
  let result = await chat("Forgot password", undefined, "forgot_password");
  const c = result.find((f) => f.event === "meta")!.data.conversationId;
  await chat("Next app", c);
  result = await chat("I cannot find recovery", c);
  assert.match(
    result.find((f) => f.event === "token")!.data.text,
    /approved recovery screen/,
  );
  assert.ok(result.find((f) => f.event === "done")!.data.citations.length);
});
test("Journey cancellation, sensitive-value rejection and stale action IDs are deterministic", () => {
  const c = current();
  const initial = advanceJourney(c, {}, "start", "transfer_dispute");
  const rejected = advanceJourney(c, initial.state, "password: secret");
  assert.match(rejected.response!, /remove/);
  assert.deepEqual(rejected.state, initial.state);
  assert.deepEqual(advanceJourney(c, initial.state, "/cancel").state, {});
  const ordinary = c.quickActions.find((a) => a.behavior === "send");
  assert.ok(ordinary);
  const switched = advanceJourney(
    c,
    initial.state,
    ordinary.message,
    ordinary.id,
  );
  assert.deepEqual(switched.state, {});
  assert.equal(switched.response, null);
  assert.throws(
    () => advanceJourney(c, {}, "hello", "unknown_action"),
    /unavailable/,
  );
});
test("Schema rejects broken action links, duplicate IDs and credential field keys", () => {
  const c = current();
  assert.equal(
    agentConfig.safeParse({
      ...c,
      quickActions: [...c.quickActions, c.quickActions[0]],
    }).success,
    false,
  );
  assert.equal(
    agentConfig.safeParse({
      ...c,
      quickActions: [
        { ...c.quickActions[0], behavior: "journey", journeyId: "absent" },
      ],
    }).success,
    false,
  );
  assert.equal(
    agentConfig.safeParse({
      ...c,
      journeys: [
        {
          ...c.journeys[0],
          fields: [
            { key: "password", label: "Password", question: "Password?" },
          ],
        },
      ],
    }).success,
    false,
  );
});
test("Workflow and evaluation snapshot execution use the same grounded policy", async () => {
  const result = await executeAgentSnapshot(
    current(),
    await modelSnapshot(model, workspace),
    "Recovery",
    { workspaceId: workspace, organizationId: org },
    AbortSignal.timeout(5000),
    provider,
    embedding,
  );
  assert.match(result.output, /approved recovery screen/);
  assert.equal(result.citations.length, 1);
});
test("Deleted sources and revoked public knowledge never leak frozen release passages", async () => {
  await sql`UPDATE knowledge_bases SET public_access=false WHERE id=${kb}`;
  await assert.rejects(
    new PostgresRagTool(embedding).execute(
      "Recovery",
      [kb],
      current().rag,
      { workspaceId: workspace, organizationId: org, publicAccess: true },
      AbortSignal.timeout(5000),
    ),
    (e: unknown) => (e as { code: string }).code === "KNOWLEDGE_NOT_PUBLIC",
  );
  await sql`UPDATE knowledge_sources SET status='deleted' WHERE id=${source}`;
  assert.equal(
    (
      await new PostgresRagTool(embedding).execute(
        "Recovery",
        [kb],
        current().rag,
        { workspaceId: workspace, organizationId: org, publicAccess: false },
        AbortSignal.timeout(5000),
      )
    ).length,
    0,
  );
  assert.equal((await transition(release2, "publish")).statusCode, 409);
});
