import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest } from "../src/security.js";
import { agentConfig } from "@agentconnect/schemas/agents";
import { handoffPolicy } from "@agentconnect/schemas/support";
import {
  effectivePolicy,
  evaluateEscalation,
  isHumanRequest,
} from "../src/support/policy.js";
import { processSupportTriage } from "../src/support/triage.js";
import { processSupportRouting } from "../src/support/routing.js";
import {
  ProviderError,
  type ProviderFactory,
} from "@agentconnect/provider-sdk";
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
const app = await buildApp({
  providerFactory: () => ({
    async *stream(input) {
      if (providerFailure)
        throw new ProviderError("PROVIDER_HTTP_ERROR", false, 503);
      yield {
        type: "token",
        text: input.system.includes("request_human_handoff")
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
async function state(c: string) {
  const r = await call("GET", `/conversations/${c}/handoff`);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function request(c: string) {
  return call("POST", `/conversations/${c}/handoff`, { action: "request" });
}
async function queue() {
  const r = await call("POST", base + "/queues", {
    name: "Queue " + randomUUID(),
    isDefault: true,
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().id as string;
}
const goodResult = {
  intent: "billing",
  category: "accounts",
  priority: "high",
  language: "my",
  requiredSkills: ["Billing", "Foreign skill"],
  preferredSkills: ["Billing"],
  sentiment: "frustrated",
  complexity: "medium",
  summary: "Customer needs account help.",
  reason: "Repeated requests for a specialist.",
  customerContext: [],
  actionsAttempted: ["The assistant asked about the account issue."],
  suggestedNextAction: "Review the customer request.",
};
function triageFactory(
  result: unknown = goodResult,
  inspect?: (input: import("@agentconnect/provider-sdk").ChatRequest) => void,
): ProviderFactory {
  return () => ({
    async *stream(input) {
      inspect?.(input);
      yield { type: "token", text: JSON.stringify(result) };
      yield { type: "usage", inputTokens: 100, outputTokens: 30 };
    },
  });
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

test("Default policy is controlled with two explicit requests; policies enforce roles and scoped references", async () => {
  const r = await call("GET", base + "/policy");
  assert.equal(r.json().policy.humanEntryMode, "policy_controlled");
  assert.equal(r.json().policy.explicitRequestThreshold, 2);
  assert.equal(
    (await call("PUT", base + "/policy", {}, "operator")).statusCode,
    403,
  );
  assert.equal(
    (await call("GET", base + "/policy", undefined, "analyst")).statusCode,
    200,
  );
  assert.equal(
    (await call("GET", base + "/policy", undefined, "outsider")).statusCode,
    403,
  );
  for (const body of [
    { explicitRequestThreshold: 0 },
    { maxResolutionAttempts: 1 },
    { triageModelId: randomUUID() },
    { defaultQueueId: randomUUID() },
    { unknown: true },
    { intentRules: [{ intent: "billing", requiredSkills: [randomUUID()] }] },
  ])
    assert.equal((await call("PUT", base + "/policy", body)).statusCode, 400);
});
test("Deployment overrides agent and workspace; deleting overrides restores deterministic inheritance", async () => {
  await policy({ humanEntryMode: "disabled" });
  await policy(
    { explicitRequestThreshold: 4 },
    `?scope=agent&targetId=${agent}`,
  );
  await policy(
    { humanEntryMode: "always_available" },
    `?scope=deployment&targetId=${deployment}`,
  );
  const c = await conversation(true),
    [row] = await sql`SELECT * FROM conversations WHERE id=${c}`;
  assert.equal(
    (await sql.begin((tx) => effectivePolicy(tx, row as never))).source,
    "deployment",
  );
  await call(
    "DELETE",
    base + `/policy?scope=deployment&targetId=${deployment}`,
  );
  assert.equal((await state(c)).access.entryMode, "policy_controlled");
  await call("DELETE", base + `/policy?scope=agent&targetId=${agent}`);
  assert.equal((await state(c)).access.entryMode, "disabled");
  assert.equal(
    (
      await call(
        "PUT",
        base + `/policy?scope=agent&targetId=${randomUUID()}`,
        {},
      )
    ).statusCode,
    404,
  );
});
test("Repeated explicit requests offer support without takeover; confirmation creates one queued triage case", async () => {
  const c = await conversation();
  assert.equal((await request(c)).statusCode, 409);
  await chat(c, "I want a human");
  assert.equal((await state(c)).access.canRequest, false);
  await chat(c, "I need a human");
  const offer = (await state(c)).access.offer;
  assert.ok(offer.id);
  assert.equal(
    (await sql`SELECT conversation_mode FROM conversations WHERE id=${c}`)[0]!
      .conversation_mode,
    "ai",
  );
  assert.equal((await request(c)).statusCode, 201);
  assert.equal((await request(c)).statusCode, 409);
  const [s] = await sql`SELECT * FROM support_cases WHERE conversation_id=${c}`;
  assert.equal(s!.triage_status, "pending");
  assert.equal(s!.reason_code, "explicit_request");
  assert.equal((await state(c)).status, "pending");
  assert.equal(
    (await sql`SELECT status FROM support_offers WHERE id=${offer.id}`)[0]!
      .status,
    "confirmed",
  );
});
test("Dismissal keeps AI control and resets the repeated-request window", async () => {
  const c = await conversation();
  await chat(c, "I want a human");
  await chat(c, "I need a human");
  await call("POST", `/conversations/${c}/handoff`, { action: "dismiss" });
  assert.equal((await state(c)).access.canRequest, false);
  await chat(c, "I want a human");
  assert.equal((await state(c)).access.canRequest, false);
  await chat(c, "I need a human");
  assert.ok((await state(c)).access.offer);
});
test("Disabled and expired offers cannot authorize a customer handoff; policy is rechecked at confirmation", async () => {
  const c = await conversation();
  await chat(c, "I want a human");
  await chat(c, "I need a human");
  await policy({ humanEntryMode: "disabled" });
  assert.equal((await request(c)).statusCode, 403);
  await policy({});
  await sql`UPDATE support_offers SET expires_at=now()-interval '1 second' WHERE conversation_id=${c}`;
  assert.equal((await request(c)).statusCode, 409);
  assert.equal((await state(c)).access.offer, null);
});
test("Resolution-loop detection uses repeated questions, is configurable and ignores ordinary one-off frustration", async () => {
  const c = await conversation();
  for (let i = 0; i < 2; i++) await chat(c, "Why is my invoice still wrong?");
  assert.equal((await state(c)).access.canRequest, false);
  await chat(c, "Why is my invoice still wrong?");
  assert.equal((await state(c)).access.offer.reason_code, "resolution_loop");
  const other = await conversation();
  await chat(other, "I am frustrated");
  assert.equal((await state(other)).access.offer, null);
  await policy({ loopDetectionEnabled: false });
  const disabled = await conversation();
  for (let i = 0; i < 3; i++)
    await chat(disabled, "Why is my invoice still wrong?");
  assert.equal((await state(disabled)).access.offer, null);
});
test("Repeated failed tool runs trigger a validated offer, provider failures alone do not masquerade as tool failures", async () => {
  const c = await conversation();
  for (let i = 0; i < 2; i++) {
    const run = randomUUID();
    await sql`INSERT INTO agent_runs(id,conversation_id,organization_id,workspace_id,status,error_code,trace_id,finished_at) VALUES (${run},${c},${org},${workspace},'failed','TOOL_TIMEOUT','fixture',now())`;
    await sql`INSERT INTO messages(id,conversation_id,organization_id,workspace_id,run_id,role,content) VALUES (${randomUUID()},${c},${org},${workspace},${run},'user',${"Account check " + i})`;
    await evaluateEscalation(c, run);
  }
  assert.equal((await state(c)).access.offer.reason_code, "tool_failure");
  providerFailure = true;
  const other = await conversation();
  await chat(other, "Account check");
  assert.equal((await state(other)).access.offer, null);
});
test("Structured runtime handoff requests are policy-gated; required intents and repeated frustration are validated", async () => {
  await policy({ agentCanRequestHandoff: true });
  decision = {
    requestHandoff: true,
    intent: "authority",
    sentiment: "neutral",
    reason: "Manual authority needed",
  };
  const c = await conversation();
  await chat(c, "Please approve this");
  assert.equal((await state(c)).access.offer.reason_code, "agent_request");
  await policy({ intentRules: [{ intent: "fraud" }] });
  decision = {
    requestHandoff: false,
    intent: "fraud",
    sentiment: "neutral",
    reason: "",
  };
  const intent = await conversation();
  await chat(intent, "Unrecognized charge");
  assert.equal(
    (await state(intent)).access.offer.reason_code,
    "required_intent",
  );
  await policy({
    sentimentEscalationEnabled: true,
    loopDetectionEnabled: false,
  });
  decision = {
    requestHandoff: false,
    intent: "general",
    sentiment: "frustrated",
    reason: "",
  };
  const frustration = await conversation();
  await chat(frustration, "That didn't help");
  assert.equal((await state(frustration)).access.offer, null);
  await chat(frustration, "It still does not work");
  assert.equal(
    (await state(frustration)).access.offer.reason_code,
    "persistent_frustration",
  );
});
test("Malformed internal AI recommendations fail closed while deterministic explicit requests still work", async () => {
  await policy({ agentCanRequestHandoff: true });
  decision = {
    requestHandoff: true,
    intent: "fraud",
    sentiment: "made-up",
    reason: "",
  };
  const c = await conversation();
  await chat(c, "Check charge");
  assert.equal((await state(c)).access.offer, null);
  await chat(c, "I want a human");
  await chat(c, "I need a human");
  assert.ok((await state(c)).access.offer);
});
test("Valid triage stores a private once-generated brief, provenance and scoped preferences without assigning arbitrary users", async () => {
  const q = await queue(),
    { c, s } = await confirmed({ defaultQueueId: q });
  const skill = randomUUID();
  await sql`INSERT INTO support_skills(id,workspace_id,organization_id,name) VALUES (${skill},${workspace},${org},'Billing')`;
  let calls = 0;
  await processSupportTriage(
    triageFactory(goodResult, (input) => {
      calls++;
      assert.equal(input.topP, null);
      assert.equal(input.maxOutputTokens, 2048);
      assert.ok(input.system.includes("untrusted"));
    }),
  );
  await processSupportTriage(
    triageFactory(goodResult, () => {
      calls++;
    }),
  );
  assert.equal(calls, 1);
  const [ready] = await sql`SELECT * FROM support_cases WHERE id=${s.id}`;
  assert.equal(ready!.triage_status, "completed");
  assert.equal(ready!.handoff_brief.summary, goodResult.summary);
  assert.equal(ready!.triage_provenance.purpose, "support_triage");
  assert.equal(ready!.triage_provenance.inputTokens, 100);
  assert.deepEqual(ready!.routing_requirements.requiredSkills, []);
  assert.deepEqual(ready!.routing_requirements.preferredSkills, [skill]);
  assert.equal(ready!.assigned_operator_id, null);
  assert.equal(ready!.priority, "normal");
  assert.ok(!JSON.stringify(await state(c)).includes(goodResult.summary));
  assert.ok(!JSON.stringify(await state(c)).includes("routing_requirements"));
});
test("Only approved intent rules set mandatory routing requirements, queue and priority", async () => {
  const q = await queue(),
    target = await queue(),
    skill = randomUUID();
  await sql`INSERT INTO support_skills(id,workspace_id,organization_id,name) VALUES (${skill},${workspace},${org},'Billing')`;
  const { s } = await confirmed({
    defaultQueueId: q,
    intentRules: [
      {
        intent: "billing",
        queueId: target,
        priority: "urgent",
        requiredSkills: [skill],
      },
    ],
  });
  await processSupportTriage(triageFactory());
  const [ready] = await sql`SELECT * FROM support_cases WHERE id=${s.id}`;
  assert.equal(ready!.queue_id, target);
  assert.equal(ready!.priority, "urgent");
  assert.deepEqual(ready!.routing_requirements.requiredSkills, [skill]);
});
test("Malformed or unavailable AI triage releases the default queue; operators can still claim and reply", async () => {
  const q = await queue(),
    { s } = await confirmed({ defaultQueueId: q });
  await processSupportTriage(
    triageFactory({ ...goodResult, operatorId: users.outsider }),
  );
  const [failed] = await sql`SELECT * FROM support_cases WHERE id=${s.id}`;
  assert.equal(failed!.triage_status, "failed");
  assert.equal(failed!.queue_id, q);
  assert.equal(
    failed!.triage_provenance.errorCode,
    "SUPPORT_TRIAGE_INVALID_OR_UNAVAILABLE",
  );
  assert.equal(
    (await call("POST", `${base}/cases/${s.id}/claim`, {}, "operator"))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "POST",
        `${base}/cases/${s.id}/messages`,
        { content: "A specialist can help." },
        "operator",
      )
    ).statusCode,
    200,
  );
});
test("Routing waits for pending triage; manual claim remains available and expired leases release routing", async () => {
  const q = await queue();
  await call("PUT", base + `/operators/${users.operator}/profile`, {});
  await call(
    "POST",
    base + `/operators/${users.operator}/presence`,
    { status: "available" },
    "operator",
  );
  await call("PUT", base + `/queues/${q}/members`, {
    members: [{ userId: users.operator }],
  });
  await app.inject({
    method: "PATCH",
    url: base + `/queues/${q}`,
    remoteAddress,
    headers: { origin: config.WEB_ORIGIN, cookie: `session=${sessions.owner}` },
    payload: { routingStrategy: "round_robin", assignmentMode: "automatic" },
  });
  const { s } = await confirmed({ defaultQueueId: q });
  await processSupportRouting();
  assert.equal(
    (
      await sql`SELECT assigned_operator_id FROM support_cases WHERE id=${s.id}`
    )[0]!.assigned_operator_id,
    null,
  );
  await sql`UPDATE support_cases SET triage_status='running',triage_lease_token=${randomUUID()},triage_lease_until=now()-interval '1 second' WHERE id=${s.id}`;
  await processSupportTriage();
  await processSupportRouting();
  assert.equal(
    (
      await sql`SELECT assigned_operator_id FROM support_cases WHERE id=${s.id}`
    )[0]!.assigned_operator_id,
    users.operator,
  );
});
test("Concurrent triage workers issue one provider call and stale leases cannot overwrite newer state", async () => {
  const { s } = await confirmed();
  let calls = 0;
  const factory = triageFactory(goodResult, () => {
    calls++;
  });
  await Promise.all([
    processSupportTriage(factory),
    processSupportTriage(factory),
  ]);
  assert.equal(calls, 1);
  assert.equal(
    (await sql`SELECT triage_status FROM support_cases WHERE id=${s.id}`)[0]!
      .triage_status,
    "completed",
  );
});
test("Private notes never enter triage input; manual refresh is role-gated, deduplicated and preserves the transcript", async () => {
  const { s } = await confirmed();
  await processSupportTriage(triageFactory());
  await call("POST", `${base}/cases/${s.id}/claim`, {}, "operator");
  await call(
    "POST",
    `${base}/cases/${s.id}/notes`,
    { content: "TOP SECRET INTERNAL NOTE" },
    "operator",
  );
  assert.equal(
    (await call("POST", `${base}/cases/${s.id}/brief/refresh`, {}, "analyst"))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await call("POST", `${base}/cases/${s.id}/brief/refresh`, {}, "operator")
    ).json().queued,
    true,
  );
  assert.equal(
    (
      await call("POST", `${base}/cases/${s.id}/brief/refresh`, {}, "operator")
    ).json().queued,
    false,
  );
  await processSupportTriage(
    triageFactory(goodResult, (input) => {
      assert.ok(!JSON.stringify(input).includes("TOP SECRET INTERNAL NOTE"));
    }),
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int AS n FROM messages WHERE conversation_id=${s.conversation_id}`
    )[0]!.n,
    2,
  );
});
test("Explicit-request detector avoids incidental mentions and handles configured customer phrasing", () => {
  for (const t of [
    "human",
    "agent please",
    "I want a human",
    "Talk to somebody",
    "I need a real person",
  ])
    assert.ok(isHumanRequest(t), t);
  for (const t of [
    "Explain human anatomy",
    "Our operator deployed this",
    "An agent handles invoices",
  ])
    assert.equal(isHumanRequest(t), false, t);
  assert.equal(
    handoffPolicy.safeParse({ maxOutputTokens: 8193 }).success,
    false,
  );
});

test("Public customer endpoints enforce the same consent policy and never expose private triage", async () => {
  const raw = randomUUID(),
    c = await conversation(true);
  await sql`UPDATE conversations SET guest_token_hash=${digest(raw)} WHERE id=${c}`;
  const path = `/public/deployments/${deployment}/conversations/${c}/handoff`;
  const guest = (method: "GET" | "POST", url: string, body?: unknown) =>
    app.inject({
      method,
      url,
      remoteAddress,
      headers: {
        origin: config.WEB_ORIGIN,
        authorization: "Bearer " + raw,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      payload: body ? JSON.stringify(body) : undefined,
    });
  assert.equal(
    (await guest("POST", path, { action: "request" })).statusCode,
    409,
  );
  for (const message of ["I want a human", "I need a human"]) {
    const r = await guest("POST", `/public/deployments/${deployment}/chat`, {
      conversationId: c,
      message,
    });
    assert.equal(r.statusCode, 200, r.body);
  }
  assert.ok((await guest("GET", path)).json().access.offer);
  assert.equal(
    (await guest("POST", path, { action: "request" })).statusCode,
    201,
  );
  await processSupportTriage(triageFactory());
  const publicBody = (await guest("GET", path)).body;
  assert.ok(!publicBody.includes(goodResult.summary));
  assert.ok(!publicBody.includes("triage_provenance"));
  assert.equal((await guest("GET", base + "/policy")).statusCode, 401);
});
test("Unavailable provider triage fails safely and a later manual refresh can recover", async () => {
  const { s } = await confirmed();
  await processSupportTriage(() => ({
    async *stream() {
      throw new ProviderError("AUTHENTICATION_FAILED", false, 401);
      yield { type: "usage", inputTokens: null, outputTokens: null };
    },
  }));
  const [failed] =
    await sql`SELECT triage_status,triage_provenance FROM support_cases WHERE id=${s.id}`;
  assert.equal(failed!.triage_status, "failed");
  assert.equal(failed!.triage_provenance.errorCode, "AUTHENTICATION_FAILED");
  assert.equal(
    (await call("POST", `${base}/cases/${s.id}/brief/refresh`, {}, "operator"))
      .statusCode,
    200,
  );
  await processSupportTriage(triageFactory());
  assert.equal(
    (await sql`SELECT triage_status FROM support_cases WHERE id=${s.id}`)[0]!
      .triage_status,
    "completed",
  );
});
test("Explicit selected models honor registered token limits and skip archived models", async () => {
  const { s } = await confirmed({
    triageModelId: model,
    maxOutputTokens: 8192,
  });
  await sql`UPDATE model_configurations SET max_output_tokens=1024 WHERE id=${model}`;
  await processSupportTriage(
    triageFactory(goodResult, (input) =>
      assert.equal(input.maxOutputTokens, 1024),
    ),
  );
  await sql`UPDATE model_configurations SET archived_at=now() WHERE id=${model}`;
  assert.equal(
    (await call("PUT", base + "/policy", { triageModelId: model })).statusCode,
    400,
  );
  await call("POST", `${base}/cases/${s.id}/brief/refresh`, {}, "operator");
  await processSupportTriage(triageFactory());
  assert.equal(
    (await sql`SELECT triage_status FROM support_cases WHERE id=${s.id}`)[0]!
      .triage_status,
    "failed",
  );
  await sql`UPDATE model_configurations SET archived_at=NULL,max_output_tokens=4096 WHERE id=${model}`;
});
test("A stale triage lease cannot overwrite a manually refreshed case", async () => {
  const { s } = await confirmed();
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((r) => {
      release = r;
    }),
    begun = new Promise<void>((r) => {
      started = r;
    });
  const running = processSupportTriage(() => ({
    async *stream() {
      started();
      await waiting;
      yield {
        type: "token",
        text: JSON.stringify({ ...goodResult, summary: "Old lease summary" }),
      };
    },
  }));
  await begun;
  await sql`UPDATE support_cases SET triage_lease_until=now()-interval '1 second' WHERE id=${s.id}`;
  await processSupportTriage();
  assert.equal(
    (
      await call("POST", `${base}/cases/${s.id}/brief/refresh`, {}, "operator")
    ).json().queued,
    true,
  );
  release();
  await running;
  const [pending] =
    await sql`SELECT triage_status,handoff_brief FROM support_cases WHERE id=${s.id}`;
  assert.equal(pending!.triage_status, "pending");
  assert.ok(
    !JSON.stringify(pending!.handoff_brief).includes("Old lease summary"),
  );
  await processSupportTriage(triageFactory());
  assert.equal(
    (await sql`SELECT handoff_brief FROM support_cases WHERE id=${s.id}`)[0]!
      .handoff_brief.summary,
    goodResult.summary,
  );
});
test("Disabling triage and briefs permits immediate manual service without a model call", async () => {
  const { s } = await confirmed({
    aiTriageEnabled: false,
    generateHandoffSummary: false,
  });
  assert.equal(s.triage_status, "none");
  let calls = 0;
  await processSupportTriage(
    triageFactory(goodResult, () => {
      calls++;
    }),
  );
  assert.equal(calls, 0);
  assert.equal(
    (await call("POST", `${base}/cases/${s.id}/brief/refresh`, {}, "operator"))
      .statusCode,
    409,
  );
});

test("A failed refresh preserves the last successful brief and its generation provenance", async () => {
  const { s } = await confirmed();
  await processSupportTriage(triageFactory());
  const [original] =
    await sql`SELECT handoff_brief FROM support_cases WHERE id=${s.id}`;
  await call("POST", `${base}/cases/${s.id}/brief/refresh`, {}, "operator");
  await processSupportTriage(triageFactory({ invalid: true }));
  const [failed] =
    await sql`SELECT triage_status,handoff_brief,triage_provenance FROM support_cases WHERE id=${s.id}`;
  assert.equal(failed!.triage_status, "failed");
  assert.deepEqual(failed!.handoff_brief, original!.handoff_brief);
  assert.ok(failed!.triage_provenance.errorCode);
  assert.ok(failed!.handoff_brief.provenance.generatedAt);
});
test("Declining after additional AI turns resets all earlier explicit requests", async () => {
  const c = await conversation();
  await chat(c, "I want a human");
  await chat(c, "I need a human");
  await chat(c, "I want a human");
  await call("POST", `/conversations/${c}/handoff`, { action: "dismiss" });
  await chat(c, "I need a human");
  assert.equal((await state(c)).access.offer, null);
  await chat(c, "I want a human");
  assert.ok((await state(c)).access.offer);
});
test("Concurrent customer confirmations create exactly one support case", async () => {
  const c = await conversation();
  await chat(c, "I want a human");
  await chat(c, "I need a human");
  const results = await Promise.all([request(c), request(c)]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
  assert.equal(
    (
      await sql`SELECT count(*)::int AS n FROM support_cases WHERE conversation_id=${c}`
    )[0]!.n,
    1,
  );
});
