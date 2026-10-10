import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest } from "../src/security.js";
import { agentConfig } from "@agentconnect/schemas/agents";
import { ProviderError } from "@agentconnect/provider-sdk";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  workspace = randomUUID(),
  sibling = randomUUID(),
  agent = randomUUID(),
  model = randomUUID(),
  deployment = randomUUID();
const users: Record<string, string> = {},
  sessions: Record<string, string> = {},
  base = `/workspaces/${workspace}/support`;
let remoteAddress = `127.${randomBytes(1)[0]}.${randomBytes(1)[0]}.92`;
let decision = {
    requestHandoff: false,
    intent: "general",
    sentiment: "neutral",
    reason: "",
  },
  providerFailure = false;
let copilotCalls = 0,
  inspect:
    | ((input: import("@agentconnect/provider-sdk").ChatRequest) => void)
    | undefined,
  waitFor: Promise<void> | undefined;
let suggestion = {
  reply: "Please share the order number.",
  summary: "Customer needs account help.",
  sentiment: "unknown",
  nextAction: "request_information",
  rationale: "More information is needed.",
  toolRecommendations: [] as { toolId: string; reason: string }[],
};
const app = await buildApp({
  embeddingFactory: () => ({
    async embed(texts) {
      return texts.map(() => [1, 0, 0]);
    },
  }),
  providerFactory: () => ({
    async *stream(input) {
      const copilot = input.system.includes("PRIVATE support operator copilot");
      if (copilot) {
        copilotCalls++;
        inspect?.(input);
        if (waitFor) await waitFor;
      }
      if (providerFailure)
        throw new ProviderError("PROVIDER_HTTP_ERROR", false, 503);
      yield {
        type: "token",
        text: copilot
          ? JSON.stringify(suggestion)
          : input.system.includes("request_human_handoff")
            ? JSON.stringify(decision)
            : "What account issue can I help with?",
      };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
    },
  }),
});
async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
  role = "owner",
) {
  return app.inject({
    method,
    url,
    remoteAddress,
    headers: {
      origin: config.WEB_ORIGIN,
      cookie: `session=${sessions[role]}`,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
}
async function policy(extra: Record<string, unknown> = {}, query = "") {
  const r = await call("PUT", base + "/policy" + query, extra);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function conversation(dep = false) {
  const c = randomUUID();
  await sql`INSERT INTO conversations(id,organization_id,workspace_id,agent_id,deployment_id,user_id,guest_token_hash,config_snapshot,model_snapshot) VALUES (${c},${org},${workspace},${agent},${dep ? deployment : null},${dep ? null : users.owner!},${dep ? digest(randomUUID()) : null},${sql.json(agentConfig.parse({ modelId: model, maxOutputTokens: 1024 }))},${sql.json({ id: model, provider: "openai-compatible", modelId: "fixture", baseUrl: "https://api.deepseek.com/v1", secretId: null, contextWindow: 32768, maxOutputTokens: 4096, capabilities: { temperature: false, topP: false } })})`;
  return c;
}
async function chat(c: string, text: string) {
  const r = await call("POST", `/agents/${agent}/chat`, {
    conversationId: c,
    message: text,
  });
  assert.equal(r.statusCode, 200, r.body);
  return r;
}
async function request(c: string) {
  return call("POST", `/conversations/${c}/handoff`, { action: "request" });
}
async function confirmed(extra: Record<string, unknown> = {}) {
  await policy({ humanEntryMode: "always_available", ...extra });
  const c = await conversation();
  await chat(c, "Need account help");
  const r = await request(c);
  assert.equal(r.statusCode, 201, r.body);
  const [s] = await sql`SELECT * FROM support_cases WHERE conversation_id=${c}`;
  return { c, s: s! };
}
before(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Triage fixtures')`;
    for (const id of [workspace, sibling])
      await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${id},${org},'Triage workspace')`;
    for (const role of ["owner", "operator", "analyst", "outsider"]) {
      users[role] = randomUUID();
      sessions[role] = randomUUID();
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${users[role]!},${users[role] + "@example.invalid"},${role},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(sessions[role]!)},${users[role]!},now()+interval '1 hour')`;
      if (role !== "outsider")
        await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${role === "owner" ? null : workspace},${users[role]!},${role})`;
    }
    await tx`INSERT INTO model_configurations(id,organization_id,workspace_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES (${model},${org},${workspace},'Fixture','openai-compatible','fixture','https://api.deepseek.com/v1',32768,4096,'{"temperature":false,"topP":false,"streaming":true}')`;
    await tx`INSERT INTO agents(id,organization_id,workspace_id,name,description,public_description,draft_config,created_by) VALUES (${agent},${org},${workspace},'Triage agent','','',${tx.json(agentConfig.parse({ modelId: model }))},${users.owner!})`;
    const version = randomUUID();
    await tx`INSERT INTO agent_versions(id,organization_id,workspace_id,agent_id,version,name,public_description,model_id,config,model_snapshot,published_by) VALUES (${version},${org},${workspace},${agent},1,'Fixture','',${model},${tx.json(agentConfig.parse({ modelId: model }))},'{}',${users.owner!})`;
    await tx`INSERT INTO deployments(id,organization_id,workspace_id,agent_id,version_id,name) VALUES (${deployment},${org},${workspace},${agent},${version},'Fixture deployment')`;
  });
});
beforeEach(async () => {
  remoteAddress = `127.${randomBytes(1)[0]}.${randomBytes(1)[0]}.92`;
  providerFailure = false;
  copilotCalls = 0;
  inspect = undefined;
  waitFor = undefined;
  suggestion = {
    reply: "Please share the order number.",
    summary: "Customer needs account help.",
    sentiment: "unknown",
    nextAction: "request_information",
    rationale: "More information is needed.",
    toolRecommendations: [],
  };
  decision = {
    requestHandoff: false,
    intent: "general",
    sentiment: "neutral",
    reason: "",
  };
  for (const t of [
    "handoff_events",
    "messages",
    "agent_runs",
    "conversations",
    "support_policies",
    "support_queues",
    "operator_profiles",
    "support_skills",
    "knowledge_documents",
    "knowledge_sources",
    "knowledge_bases",
    "embedding_models",
    "tools",
  ])
    await sql`DELETE FROM ${sql(t)} WHERE organization_id=${org}`;
});
after(async () => {
  await sql.begin(async (tx) => {
    for (const t of [
      "handoff_events",
      "messages",
      "agent_runs",
      "conversations",
      "deployments",
      "agent_versions",
      "agents",
      "model_configurations",
      "knowledge_documents",
      "knowledge_sources",
      "knowledge_bases",
      "embedding_models",
      "tools",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(t)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    for (const id of Object.values(users))
      await tx`DELETE FROM users WHERE id=${id}`;
  });
  await app.close();
});

async function active() {
  const { c, s } = await confirmed({
    aiTriageEnabled: false,
    generateHandoffSummary: false,
  });
  await call("POST", base + "/cases/" + s.id + "/assign", {
    operatorId: users.operator,
  });
  const r = await call(
    "POST",
    base + "/cases/" + s.id + "/status",
    { status: "active" },
    "operator",
  );
  assert.equal(r.statusCode, 200, r.body);
  return { c, s, path: base + "/cases/" + s.id + "/copilot" };
}
test("Copilot is private, excludes notes, records usage and never sends a suggested draft", async () => {
  const { c, s, path } = await active();
  await call(
    "POST",
    base + "/cases/" + s.id + "/notes",
    { content: "PRIVATE NOTE SECRET" },
    "operator",
  );
  inspect = (i) => {
    assert.ok(!JSON.stringify(i).includes("PRIVATE NOTE SECRET"));
    assert.equal(i.temperature, 0);
    assert.equal(i.maxOutputTokens, 2048);
  };
  const before =
    await sql`SELECT id FROM support_events WHERE support_case_id=${s.id} AND type='message.created'`;
  const r = await call("POST", path, { kind: "reply" }, "operator");
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().result.reply, suggestion.reply);
  assert.equal(r.json().provenance.purpose, "copilot_reply");
  assert.equal(r.json().provenance.inputTokens, 10);
  const cached = await call("POST", path, { kind: "reply" }, "operator");
  assert.equal(cached.json().id, r.json().id);
  assert.equal(copilotCalls, 1);
  const after =
    await sql`SELECT id FROM support_events WHERE support_case_id=${s.id} AND type='message.created'`;
  assert.equal(after.length, before.length);
  const customer = await call("GET", `/conversations/${c}/handoff`);
  assert.ok(!customer.body.includes(suggestion.reply));
  const audits =
    await sql`SELECT metadata FROM audit_events WHERE workspace_id=${workspace}`;
  assert.ok(!JSON.stringify(audits).includes(suggestion.reply));
});
test("Only assigned operators or supervisors can use copilot; tenant and analyst isolation", async () => {
  const { path } = await active();
  assert.equal(
    (await call("POST", path, { kind: "reply" }, "analyst")).statusCode,
    403,
  );
  assert.equal(
    (await call("GET", path, undefined, "outsider")).statusCode,
    403,
  );
  assert.equal(
    (await call("POST", path.replace(workspace, sibling), { kind: "reply" }))
      .statusCode,
    404,
  );
  await sql`UPDATE support_cases SET assigned_operator_id=${users.owner!} WHERE workspace_id=${workspace}`;
  assert.equal(
    (await call("POST", path, { kind: "reply" }, "operator")).statusCode,
    403,
  );
  assert.equal(copilotCalls, 0);
});
test("Provider failure is safely recorded and manual operator reply still works", async () => {
  const { s, path } = await active();
  providerFailure = true;
  const r = await call("POST", path, { kind: "reply" }, "operator");
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, "failed");
  assert.equal(r.json().provenance.errorCode, "PROVIDER_HTTP_ERROR");
  assert.equal(r.json().result, null);
  const reply = await call(
    "POST",
    base + "/cases/" + s.id + "/messages",
    { content: "Manual help available" },
    "operator",
  );
  assert.equal(reply.statusCode, 200, reply.body);
  providerFailure = false;
  assert.equal(
    (
      await call("POST", path, { kind: "reply", regenerate: true }, "operator")
    ).json().status,
    "completed",
  );
});
test("Concurrent requests share one generation and operator revocation prevents returning its text", async () => {
  const { path, s } = await active();
  let release!: () => void;
  waitFor = new Promise<void>((r) => (release = r));
  const first = call("POST", path, { kind: "reply" }, "operator");
  for (let n = 0; n < 100 && !copilotCalls; n++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(copilotCalls, 1);
  const second = await call(
    "POST",
    path,
    { kind: "reply", regenerate: true },
    "operator",
  );
  assert.equal(second.json().status, "running");
  assert.equal(copilotCalls, 1);
  await sql`UPDATE support_cases SET assigned_operator_id=${users.owner!} WHERE id=${s.id}`;
  release();
  const r = await first;
  assert.equal(r.statusCode, 403, r.body);
  assert.ok(!r.body.includes(suggestion.reply));
  const [saved] =
    await sql`SELECT result,status FROM support_copilot WHERE support_case_id=${s.id}`;
  assert.equal(saved!.status, "failed");
  assert.equal(saved!.result, null);
});
test("Copilot rejects fabricated tool recommendations, citation references and unavailable actions", async () => {
  const { path } = await active();
  for (const change of [
    { toolRecommendations: [{ toolId: randomUUID(), reason: "Unknown" }] },
    { toolRecommendations: [], reply: "Invented source [99]" },
    { reply: "Draft", nextAction: "escalate_supervisor" },
  ]) {
    Object.assign(suggestion, change);
    const r = await call(
      "POST",
      path,
      { kind: "reply", regenerate: true },
      "operator",
    );
    assert.equal(r.json().status, "failed", r.body);
  }
});
test("Policy disables copilot and validates the selected scoped model", async () => {
  const { path } = await active();
  await policy({ copilotEnabled: false });
  assert.equal(
    (await call("POST", path, { kind: "reply" }, "operator")).statusCode,
    409,
  );
  assert.equal(copilotCalls, 0);
  assert.equal(
    (await call("PUT", base + "/policy", { copilotModelId: randomUUID() }))
      .statusCode,
    400,
  );
});
test("Empty knowledge search is private and does not invoke the chat provider", async () => {
  const { path } = await active();
  const r = await call("POST", path, { kind: "knowledge" }, "operator");
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().citations, []);
  assert.equal(copilotCalls, 0);
  assert.equal(r.json().status, "completed");
});
test("Expired generation lease permits explicit retry without automatic provider charges", async () => {
  const { path, s, c } = await active();
  await sql`INSERT INTO support_copilot(id,organization_id,workspace_id,conversation_id,support_case_id,requested_by,kind,status,context_hash,lease_until) VALUES (${randomUUID()},${org},${workspace},${c},${s.id},${users.operator!},'reply','running','expired',now()-interval '1 minute')`;
  const list = await call("GET", path, undefined, "operator");
  assert.equal(list.json().items[0].status, "failed");
  assert.equal(copilotCalls, 0);
  const r = await call("POST", path, { kind: "reply" }, "operator");
  assert.equal(r.json().status, "completed");
  assert.equal(copilotCalls, 1);
});

test("Copilot grounds suggestions in ready attached sources and approved tools without executing them", async () => {
  const { path, c } = await active(),
    embedding = randomUUID(),
    kb = randomUUID(),
    source = randomUUID(),
    document = randomUUID(),
    tool = randomUUID();
  await sql`INSERT INTO embedding_models(id,organization_id,workspace_id,name,provider,model_id,base_url,dimensions) VALUES (${embedding},${org},${workspace},'Embedding','openai-compatible','fixture','https://api.deepseek.com/v1',3)`;
  await sql`INSERT INTO knowledge_bases(id,organization_id,workspace_id,name,description,embedding_model_id,dimensions,chunk_size,chunk_overlap,chunk_strategy) VALUES (${kb},${org},${workspace},'Refund policy','',${embedding},3,400,0,'recursive')`;
  await sql`INSERT INTO knowledge_sources(id,knowledge_base_id,organization_id,workspace_id,kind,title,status) VALUES (${source},${kb},${org},${workspace},'text','Refund policy','ready')`;
  await sql`INSERT INTO knowledge_documents(id,source_id,knowledge_base_id,organization_id,workspace_id,title,metadata,page_count,content_hash,revision) VALUES (${document},${source},${kb},${org},${workspace},'Refund policy','{}',1,'fixture',1)`;
  await sql`INSERT INTO knowledge_chunks(id,document_id,source_id,knowledge_base_id,organization_id,workspace_id,embedding_model_id,dimensions,ordinal,content,metadata,embedding) VALUES (${randomUUID()},${document},${source},${kb},${org},${workspace},${embedding},3,0,'Refunds are available within 30 days.','{}','[1,0,0]')`;
  await sql`INSERT INTO tools(id,organization_id,workspace_id,name,description,kind,timeout_ms,config,input_schema) VALUES (${tool},${org},${workspace},'Order lookup','Read order status','http',1000,${sql.json({ kind: "http", url: "https://example.invalid/orders", method: "GET", headers: {} })},'{"type":"object","properties":{}}')`;
  const [conv] =
    await sql`SELECT config_snapshot FROM conversations WHERE id=${c}`;
  const cfg = conv!.config_snapshot;
  cfg.rag.knowledgeBaseIds = [kb];
  cfg.tools.toolIds = [tool];
  await sql`UPDATE conversations SET config_snapshot=${sql.json(cfg)} WHERE id=${c}`;
  suggestion.reply = "Refunds are available within 30 days [1].";
  suggestion.toolRecommendations = [
    { toolId: tool, reason: "Check order status before responding." },
  ];
  inspect = (i) => {
    assert.ok(
      JSON.stringify(i).includes("Refunds are available within 30 days."),
    );
  };
  const r = await call("POST", path, { kind: "reply" }, "operator");
  assert.equal(r.json().status, "completed", r.body);
  assert.equal(r.json().citations[0].title, "Refund policy");
  assert.equal(r.json().tools[0].name, "Order lookup");
  const executions =
    await sql`SELECT id FROM tool_executions WHERE workspace_id=${workspace}`;
  assert.equal(executions.length, 0);
  await sql`UPDATE knowledge_sources SET status='deleted',updated_at=now() WHERE id=${source}`;
  const list = await call("GET", path, undefined, "operator");
  assert.deepEqual(list.json().items, []);
  const search = await call("POST", path, { kind: "knowledge" }, "operator");
  assert.deepEqual(search.json().citations, []);
  assert.equal(copilotCalls, 1);
});
