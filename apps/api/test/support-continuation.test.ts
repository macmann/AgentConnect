import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest } from "../src/security.js";
import { aiResumeContext } from "@agentconnect/schemas/support";
import { continuationContext } from "../src/support/continuation.js";
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
const facts = {
  issue: "Unauthorized card transaction",
  resolution: "Card blocked and dispute opened",
  actionsCompleted: [
    "Identity checked",
    "Blocked card ending 8944",
    "Created dispute DSP-29219",
  ],
  references: { disputeId: "DSP-29219" },
  expectedNextStep: "Review in 5-7 working days",
  doNotRepeat: ["Identity verification", "Card blocking", "Dispute creation"],
  doNotRepeatToolIds: [] as string[],
};
let lastChat: import("@agentconnect/provider-sdk").ChatRequest | undefined,
  maliciousToolId = "";
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
      if (!copilot) lastChat = input;
      if (providerFailure)
        throw new ProviderError("PROVIDER_HTTP_ERROR", false, 503);
      yield {
        type: "token",
        text: copilot
          ? JSON.stringify({ ...suggestion, resolution: facts })
          : input.system.includes("request_human_handoff")
            ? JSON.stringify(decision)
            : input.system.includes("Choose useful read-only tools")
              ? JSON.stringify({
                  calls: [{ toolId: maliciousToolId, arguments: {} }],
                })
              : input.system.includes("approved_support_context")
                ? "Your dispute DSP-29219 is open; review in 5-7 working days."
                : "Please verify your identity first.",
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
  lastChat = undefined;
  maliciousToolId = "";
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

async function resolve(
  s: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  role = "operator",
) {
  return call(
    "POST",
    base + "/cases/" + s.id + "/resolve",
    {
      summary: "PRIVATE RESOLUTION NOTE",
      code: "action_completed",
      resume: facts,
      ...extra,
    },
    role,
  );
}
test("AI → human → AI preserves approved facts and public human messages without leaking notes", async () => {
  const { s, c } = await active();
  await call(
    "POST",
    base + "/cases/" + s.id + "/notes",
    { content: "PRIVATE OPERATOR NOTE" },
    "operator",
  );
  await call(
    "POST",
    base + "/cases/" + s.id + "/messages",
    { content: "I checked your identity and created dispute DSP-29219." },
    "operator",
  );
  const r = await resolve(s, {
    finalResponse: "Your card was blocked and dispute DSP-29219 is open.",
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(
    aiResumeContext.parse(r.json().resume_context).facts.references.disputeId,
    "DSP-29219",
  );
  const [conv] = await sql`SELECT * FROM conversations WHERE id=${c}`;
  assert.equal(conv!.conversation_mode, "ai");
  assert.equal(conv!.ai_resume_case_id, s.id);
  assert.equal(conv!.active_support_case_id, null);
  await chat(c, "What happens next?");
  assert.ok(lastChat!.system.includes("DSP-29219"));
  assert.ok(lastChat!.system.includes("Identity verification"));
  assert.ok(lastChat!.system.includes("I checked your identity"));
  assert.ok(
    JSON.stringify(lastChat!.messages).includes(
      "Please verify your identity first.",
    ),
  );
  assert.ok(!JSON.stringify(lastChat).includes("PRIVATE OPERATOR NOTE"));
  assert.ok(!JSON.stringify(lastChat).includes("PRIVATE RESOLUTION NOTE"));
  const publicState = await call("GET", `/conversations/${c}/handoff`);
  assert.equal(publicState.json().conversationMode, "ai");
  assert.ok(!publicState.body.includes("resume_context"));
  assert.ok(!publicState.body.includes("PRIVATE"));
});
test("Resolution suggestions are review-only and provider failure cannot prevent deterministic resolution", async () => {
  const { s, path, c } = await active();
  await policy({
    generateResolutionSummary: true,
    aiTriageEnabled: false,
    generateHandoffSummary: false,
  });
  const proposal = await call("POST", path, { kind: "resolution" }, "operator");
  assert.equal(proposal.statusCode, 200, proposal.body);
  assert.equal(proposal.json().provenance.purpose, "resolution_summary");
  assert.equal(
    proposal.json().result.resolution.references.disputeId,
    "DSP-29219",
  );
  let [caseRow] =
    await sql`SELECT status,resume_context FROM support_cases WHERE id=${s.id}`;
  assert.equal(caseRow!.status, "active");
  assert.deepEqual(caseRow!.resume_context, {});
  providerFailure = true;
  const failed = await call(
    "POST",
    path,
    { kind: "resolution", regenerate: true },
    "operator",
  );
  assert.equal(failed.json().status, "failed");
  assert.equal(copilotCalls, 2);
  const done = await resolve(s, {
    resume: undefined,
    finalResponse: "Your request was reviewed.",
  });
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().resume_context.origin, "deterministic_fallback");
  assert.equal(
    done.json().resume_context.facts.resolution,
    "Your request was reviewed.",
  );
  const [conv] =
    await sql`SELECT conversation_mode FROM conversations WHERE id=${c}`;
  assert.equal(conv!.conversation_mode, "ai");
  [caseRow] =
    await sql`SELECT resume_context FROM support_cases WHERE id=${s.id}`;
  assert.ok(!JSON.stringify(caseRow!.resume_context).includes("PRIVATE"));
});
test("Policy can hold AI return and only the current authorized controller can resume", async () => {
  const { s, c } = await active();
  await policy({ returnToAIEnabled: false });
  const done = await resolve(s);
  assert.equal(done.statusCode, 200, done.body);
  assert.equal(done.json().conversation_mode, "returning_to_ai");
  assert.equal(
    (
      await call("POST", `/agents/${agent}/chat`, {
        conversationId: c,
        message: "Continue",
      })
    ).statusCode,
    409,
  );
  const endpoint = base + "/cases/" + s.id + "/resume";
  assert.equal((await call("POST", endpoint, {}, "analyst")).statusCode, 403);
  assert.equal((await call("POST", endpoint, {}, "operator")).statusCode, 409);
  await policy({ returnToAIEnabled: true });
  assert.equal((await call("POST", endpoint, {}, "operator")).statusCode, 200);
  await chat(c, "Continue");
  assert.ok(lastChat!.system.includes("DSP-29219"));
  assert.equal((await call("POST", endpoint, {}, "operator")).statusCode, 409);
});
test("Approved blocked tools are filtered before planning and malicious replays cannot execute", async () => {
  const { s, c } = await active(),
    blocked = randomUUID(),
    allowed = randomUUID();
  for (const id of [blocked, allowed])
    await sql`INSERT INTO tools(id,organization_id,workspace_id,name,description,kind,timeout_ms,config,input_schema) VALUES (${id},${org},${workspace},'Read lookup','Read only lookup','http',1000,${sql.json({ kind: "http", url: "https://example.invalid/lookup", method: "GET", headers: {} })},'{"type":"object","properties":{}}')`;
  const [conv] =
    await sql`SELECT config_snapshot FROM conversations WHERE id=${c}`;
  const cfg = conv!.config_snapshot;
  cfg.tools.toolIds = [blocked];
  await sql`UPDATE conversations SET config_snapshot=${sql.json(cfg)} WHERE id=${c}`;
  const done = await resolve(s, {
    resume: { ...facts, doNotRepeatToolIds: [blocked] },
  });
  assert.equal(done.statusCode, 200, done.body);
  await chat(c, "Please run the lookup again");
  assert.ok(!lastChat!.system.includes("Choose useful read-only tools"));
  cfg.tools.toolIds = [blocked, allowed];
  await sql`UPDATE conversations SET config_snapshot=${sql.json(cfg)} WHERE id=${c}`;
  maliciousToolId = blocked;
  const attack = await chat(c, "Repeat the completed tool");
  assert.ok(attack.body.includes("TOOL_PLAN_INVALID"));
  const executions =
    await sql`SELECT id FROM tool_executions WHERE workspace_id=${workspace}`;
  assert.equal(executions.length, 0);
});
test("Approval and final reply roll back together when tool references or resume schema are invalid", async () => {
  const { s, c } = await active();
  for (const resume of [
    { ...facts, doNotRepeatToolIds: [randomUUID()] },
    { ...facts, references: { bad: 42 } },
    { ...facts, actionsCompleted: Array(21).fill("Unbounded") },
  ]) {
    const r = await resolve(s, { resume, finalResponse: "Should not send" });
    assert.ok([400, 422].includes(r.statusCode), r.body);
  }
  const [row] =
    await sql`SELECT status,resume_context FROM support_cases WHERE id=${s.id}`;
  assert.equal(row!.status, "active");
  assert.deepEqual(row!.resume_context, {});
  const [conv] =
    await sql`SELECT conversation_mode,ai_resume_case_id FROM conversations WHERE id=${c}`;
  assert.equal(conv!.conversation_mode, "human");
  assert.equal(conv!.ai_resume_case_id, null);
  const events =
    await sql`SELECT * FROM handoff_events WHERE conversation_id=${c} AND content='Should not send'`;
  assert.equal(events.length, 0);
  assert.equal((await resolve(s, {}, "analyst")).statusCode, 403);
  assert.equal(
    (
      await call(
        "POST",
        base.replace(workspace, sibling) + "/cases/" + s.id + "/resolve",
        { summary: "private", resume: facts },
      )
    ).statusCode,
    404,
  );
});
test("Policy excludes public human transcripts while keeping explicitly approved resolution facts", async () => {
  const { s, c } = await active();
  await policy({ includeHumanMessagesInAIContext: false });
  await call(
    "POST",
    base + "/cases/" + s.id + "/messages",
    { content: "PUBLIC HUMAN MESSAGE NOT PERMITTED IN AI" },
    "operator",
  );
  await resolve(s);
  await chat(c, "Continue");
  assert.ok(lastChat!.system.includes("DSP-29219"));
  assert.ok(
    !lastChat!.system.includes("PUBLIC HUMAN MESSAGE NOT PERMITTED IN AI"),
  );
});
test("Duplicate resolution sends one final reply and reopening revokes the previous active resume pointer", async () => {
  const { s, c } = await active();
  const responses = await Promise.all([
    resolve(s, { finalResponse: "Resolved once" }),
    resolve(s, { finalResponse: "Resolved once" }),
  ]);
  assert.ok(responses.every((r) => r.statusCode === 200));
  const replies =
    await sql`SELECT id FROM support_events WHERE support_case_id=${s.id} AND type='message.created' AND payload->>'content'='Resolved once'`;
  assert.equal(replies.length, 1);
  const reopened = await call(
    "POST",
    base + "/cases/" + s.id + "/status",
    { status: "active" },
    "operator",
  );
  assert.equal(reopened.statusCode, 200, reopened.body);
  assert.equal(reopened.json().ai_resume_case_id, null);
  assert.deepEqual(reopened.json().resume_context, {});
  assert.equal(
    (
      await call("POST", `/agents/${agent}/chat`, {
        conversationId: c,
        message: "Should wait",
      })
    ).statusCode,
    409,
  );
});
test("Continuation context is bounded and scoped; historical private summaries never become AI context", async () => {
  const { s, c } = await active();
  await resolve(s);
  await sql`UPDATE support_cases SET resume_context=${sql.json({ summary: "LEGACY PRIVATE SUMMARY", code: "legacy" })} WHERE id=${s.id}`;
  assert.equal(
    (
      await call("POST", `/agents/${agent}/chat`, {
        conversationId: c,
        message: "Continue",
      })
    ).statusCode,
    409,
  );
  await sql`UPDATE conversations SET ai_resume_case_id=NULL WHERE id=${c}`;
  await chat(c, "Continue");
  assert.ok(!lastChat!.system.includes("LEGACY PRIVATE SUMMARY"));
  const [conv] = await sql`SELECT * FROM conversations WHERE id=${c}`;
  const context = await sql.begin((tx) =>
    continuationContext(tx, conv as never, []),
  );
  assert.equal(context.grounding, "");
});

test("Repeated interventions keep only three approved cases and a bounded human transcript", async () => {
  const { c, s } = await active();
  await resolve(s);
  const ids = [s.id];
  for (let n = 0; n < 4; n++) {
    const created = await call("POST", base + "/cases", { conversationId: c });
    assert.equal(created.statusCode, 201, created.body);
    const next = created.json();
    assert.equal(
      (await call("POST", base + "/cases/" + next.id + "/claim", {}))
        .statusCode,
      200,
    );
    const done = await resolve(
      next,
      {
        resume: {
          ...facts,
          resolution: "Approved resolution " + n + " " + "x".repeat(1400),
        },
      },
      "owner",
    );
    assert.equal(done.statusCode, 200, done.body);
    ids.push(next.id);
    for (let m = 0; m < 15; m++)
      await sql`INSERT INTO support_events(id,organization_id,workspace_id,conversation_id,support_case_id,type,actor_type,actor_id,payload) VALUES (${randomUUID()},${org},${workspace},${c},${next.id},'message.created','operator',${users.owner!},${sql.json({ content: "Visible human message " + n + " " + m + " " + "y".repeat(1400) })})`;
  }
  const [conv] = await sql`SELECT * FROM conversations WHERE id=${c}`;
  const ctx = await sql.begin((tx) =>
    continuationContext(tx, conv as never, []),
  );
  assert.equal(ctx.caseIds.length, 3);
  assert.ok(!ctx.caseIds.includes(ids[0]));
  assert.ok(!ctx.caseIds.includes(ids[1]));
  const raw = ctx.grounding
    .split("<approved_support_context>\n")[1]!
    .split("\n</approved_support_context>")[0]!;
  assert.ok(Buffer.byteLength(raw) <= 12000);
  const parsed = JSON.parse(raw);
  assert.ok(parsed.transcript.length <= 12);
});
test("An older paused resolution cannot resume a newer human intervention", async () => {
  const { s, c } = await active();
  await policy({ returnToAIEnabled: false });
  await resolve(s);
  const next = await call("POST", base + "/cases", { conversationId: c });
  assert.equal(next.statusCode, 201, next.body);
  await policy({ returnToAIEnabled: true });
  assert.equal(
    (await call("POST", base + "/cases/" + s.id + "/resume", {}, "operator"))
      .statusCode,
    409,
  );
  const [conv] =
    await sql`SELECT conversation_mode,active_support_case_id FROM conversations WHERE id=${c}`;
  assert.equal(conv!.conversation_mode, "waiting_human");
  assert.equal(conv!.active_support_case_id, next.json().id);
});
