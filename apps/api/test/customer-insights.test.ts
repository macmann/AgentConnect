import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { executeAgentSnapshot } from "../src/workflow-agents.js";
import { deleteKnowledge } from "../src/knowledge-storage.js";
import { digest } from "../src/security.js";
import { agentConfig } from "@agentconnect/schemas/agents";
import { unzipSync, strFromU8 } from "fflate";
import {
  componentPreview,
  fitHistory,
  tokenCount,
  controlledProvider,
  reserveTokens,
  settleTokens,
} from "../src/context-control.js";
import { excelReport } from "../src/excel-report.js";
import { dateRange, customerReport } from "../src/customer-reports.js";
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
let calls = 0,
  summaryCalls = 0,
  deployment = "",
  customerToken = "",
  legacyGuest = "",
  conversation = "";
const embedding: EmbeddingFactory = () => ({
  async embed(texts) {
    return texts.map((t) => (t.includes("unrelated") ? [0, 1, 0] : [1, 0, 0]));
  },
});
const provider: ProviderFactory = () => ({
  async *stream(input) {
    calls++;
    for (const message of input.messages)
      assert.deepEqual(Object.keys(message).sort(), ["content", "role"]);
    if (input.system.startsWith("Summarize")) summaryCalls++;
    yield { type: "token", text: "A helpful answer." };
    yield { type: "usage", inputTokens: 8, outputTokens: 6 };
  },
});
const app = await buildApp({
  embeddingFactory: embedding,
  providerFactory: provider,
});
const ip = `127.${randomBytes(1)[0]}.${randomBytes(1)[0]}.43`;
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
const bearer = () => ({
  authorization: "Bearer " + customerToken,
  "x-customer-token": customerToken,
});
function meta(body: string) {
  return JSON.parse(
    body
      .split("\n\n")
      .find((f) => f.startsWith("event: meta"))!
      .split("\n")[1]!
      .slice(6),
  );
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
  const keys =
    await sql`SELECT object_key FROM knowledge_sources WHERE organization_id=${org} AND object_key IS NOT NULL`;
  await Promise.all(keys.map((s) => deleteKnowledge(s.object_key)));
  try {
    await sql.begin(async (tx) => {
      for (const table of [
        "operator_presence_samples",
        "operator_profiles",
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
  }
});
test("Explicit ranges validate bounds and Excel cells cannot become formulas", () => {
  assert.throws(() => dateRange({ from: "2026-01-01T00:00:00Z" }));
  assert.throws(() =>
    dateRange({ from: "2026-01-02T00:00:00Z", to: "2026-01-01T00:00:00Z" }),
  );
  const workbook = unzipSync(
    excelReport({
      Data: [{ question: '=HYPERLINK("evil")', count: 3, label: "A&B" }],
    }),
  );
  assert.ok(workbook["xl/workbook.xml"]);
  const sheet = strFromU8(workbook["xl/worksheets/sheet1.xml"]!);
  assert.match(sheet, /A&amp;B/);
  assert.doesNotMatch(sheet, /<f>/);
  assert.match(sheet, /<v>3<\/v>/);
});
test("Tokenizer preview decomposes payload and preserves current input; failed calls still charge usage", async () => {
  const c = agentConfig.parse({
      modelId: model,
      maxOutputTokens: 64,
      contextControls: { enabled: true, inputBudget: 200, historyBudget: 64 },
    }),
    m = await modelSnapshot(model, workspace);
  assert.ok(
    tokenCount("hello world", "o200k_base") < Buffer.byteLength("hello world"),
  );
  const fit = fitHistory(c, m, [
    { role: "user", content: "old ".repeat(100) },
    { role: "assistant", content: "answer ".repeat(100) },
    { role: "user", content: "current question" },
  ]);
  assert.equal(fit.messages.at(-1)?.content, "current question");
  assert.equal(fit.removed.length, 2);
  const turnBounded = fitHistory({ ...c, historyWindow: 1 }, m, [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ]);
  assert.deepEqual(turnBounded.messages, [{ role: "user", content: "c" }]);
  const preview = componentPreview(
    c,
    m,
    fit.messages,
    "reference",
    "tool",
    "summary",
  );
  assert.ok(preview.components.knowledge > 0);
  assert.equal(
    preview.total,
    Object.values(preview.components).reduce((a, b) => a + b, 0),
  );
  const meter = controlledProvider(
    {
      async *stream() {
        yield { type: "token", text: "partial" };
        throw new Error("provider failure");
      },
    },
    c,
    m,
  );
  await assert.rejects(async () => {
    for await (const e of meter.provider.stream({
      system: "role",
      messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 64,
      temperature: 0,
      topP: 1,
      signal: AbortSignal.timeout(1000),
    }))
      void e;
  });
  assert.ok(meter.usage().reported > 0);
});
test("Workflow/evaluation snapshots honor the same tokenizer input budget", async () => {
  const c = agentConfig.parse({
      modelId: model,
      maxOutputTokens: 64,
      contextControls: { enabled: true, inputBudget: 128 },
    }),
    m = await modelSnapshot(model, workspace);
  let calls = 0;
  await assert.rejects(
    executeAgentSnapshot(
      c,
      m,
      "long ".repeat(500),
      { workspaceId: workspace, organizationId: org },
      AbortSignal.timeout(5000),
      () => ({
        async *stream() {
          calls++;
          yield { type: "token", text: "unsafe oversized answer" };
        },
      }),
    ),
    (e: unknown) => (e as { code: string }).code === "CONTEXT_LIMIT",
  );
  assert.equal(calls, 0);
});
test("Branding is shared, validated and tenant scoped", async () => {
  const pub = await call("POST", `/agents/${agent}/publish`, { revision: 1 });
  assert.equal(pub.statusCode, 201, pub.body);
  const dep = await call("POST", `/agents/${agent}/deployments`, {
    name: "Customer fixture",
    versionId: pub.json().id,
  });
  assert.equal(dep.statusCode, 201, dep.body);
  deployment = dep.json().id;
  await sql`UPDATE deployments SET widget_settings=${sql.json({ enabled: true, access: "restricted", allowedOrigins: [config.WEB_ORIGIN] })} WHERE id=${deployment}`;
  const path = `/workspaces/${workspace}/channels/${deployment}/branding`;
  assert.equal(
    (await call("PUT", path, { logoUrl: "javascript:alert(1)" })).statusCode,
    400,
  );
  assert.equal(
    (
      await call("PUT", path, {
        name: "Bank",
        logoUrl: "https://example.com/logo.png",
        welcomeMessage: "Welcome",
        primaryColor: "#123456",
      })
    ).statusCode,
    200,
  );
  assert.equal((await call("PUT", path, {}, "outsider")).statusCode, 403);
  const hosted = await call("GET", `/public/deployments/${deployment}`),
    widget = await call("GET", `/public/widgets/${deployment}`);
  assert.equal(hosted.json().name, "Bank");
  assert.deepEqual(hosted.json().branding, widget.json().branding);
});
test("Sessions restore history and cannot access another customer or channel", async () => {
  const base = `/public/deployments/${deployment}`,
    start = await call("POST", base + "/sessions");
  assert.equal(start.statusCode, 201, start.body);
  customerToken = start.json().token;
  const sent = await call(
    "POST",
    base + "/chat",
    { message: "My enquiry" },
    "owner",
    bearer(),
  );
  assert.equal(sent.statusCode, 200, sent.body);
  conversation = meta(sent.body).conversationId;
  legacyGuest = meta(sent.body).guestToken;
  assert.equal(
    (await call("POST", base + "/sessions", undefined, "owner", bearer()))
      .statusCode,
    200,
  );
  const history = await call(
    "GET",
    base + "/history",
    undefined,
    "owner",
    bearer(),
  );
  assert.equal(history.json()[0].id, conversation);
  const transcript = await call(
    "GET",
    base + "/history/" + conversation,
    undefined,
    "owner",
    bearer(),
  );
  assert.equal(transcript.json().messages.length, 2);
  assert.equal(transcript.headers["cache-control"], "no-store");
  const another = await call("POST", base + "/sessions");
  assert.equal(
    (
      await call("GET", base + "/history/" + conversation, undefined, "owner", {
        authorization: "Bearer " + another.json().token,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await call(
        "GET",
        `/public/widgets/${deployment}/history`,
        undefined,
        "owner",
        bearer(),
      )
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await call(
        "POST",
        base + "/chat",
        { message: "Continue", conversationId: conversation },
        "owner",
        bearer(),
      )
    ).statusCode,
    200,
  );
});
test("Retained transcript pages expose older messages with scoped stable cursors", async () => {
  const [run] =
    await sql`SELECT id FROM agent_runs WHERE conversation_id=${conversation} ORDER BY started_at LIMIT 1`;
  await sql`INSERT INTO messages ${sql(Array.from({ length: 205 }, (_, i) => ({ id: randomUUID(), conversation_id: conversation, organization_id: org, workspace_id: workspace, run_id: run!.id, role: "user", content: "Retained message " + i, created_at: new Date(Date.UTC(2026, 0, 1, 0, i)) })))}`;
  const base = `/public/deployments/${deployment}/history/${conversation}`,
    first = await call("GET", base, undefined, "owner", bearer());
  assert.equal(first.json().messages.length, 200);
  assert.equal(first.json().hasMore, true);
  const cursor = first.json().messages[0];
  const next = await call(
    "GET",
    base +
      "?" +
      new URLSearchParams({
        before: cursor.created_at,
        beforeId: cursor.messageId,
      }),
    undefined,
    "owner",
    bearer(),
  );
  assert.ok(next.json().messages.length);
  assert.equal(next.json().hasMore, false);
  assert.ok(
    next
      .json()
      .messages.every(
        (m: { messageId: string }) =>
          !first
            .json()
            .messages.some(
              (n: { messageId: string }) => n.messageId === m.messageId,
            ),
      ),
  );
});
test("Reports use real activity and precise dates with a readable Excel workbook", async () => {
  const base = `/workspaces/${workspace}/operations`,
    r = await call("GET", base + "/insights?days=7");
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().summary.active_customer_sessions, 1);
  assert.equal(r.json().summary.customer_conversations, 1);
  assert.ok(r.json().trends.length >= 7);
  assert.equal(
    (await call("GET", base + "/insights", undefined, "outsider")).statusCode,
    403,
  );
  const excel = await call("GET", base + "/insights.xlsx?days=7");
  assert.equal(excel.statusCode, 200, excel.body);
  assert.ok(unzipSync(excel.rawPayload)["xl/worksheets/sheet1.xml"]);
  const past = await call(
    "GET",
    base + "/insights?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z",
  );
  assert.equal(past.json().summary.active_conversations, 0);
  assert.equal(past.json().trends.length, 1);
});
test("Corrections require independent review and an approved knowledge release before retrieval", async () => {
  const [message] =
    await sql`SELECT id FROM messages WHERE conversation_id=${conversation} AND role='assistant' ORDER BY created_at LIMIT 1`;
  const reviewed = await call("POST", `/messages/${message!.id}/reviews`, {
    rating: "dislike",
    correctedResponse: "Approved recovery guidance",
    reason: "Wrong answer",
  });
  assert.equal(reviewed.statusCode, 201, reviewed.body);
  const gaps = await call(
    "GET",
    `/workspaces/${workspace}/operations/knowledge-gaps`,
  );
  assert.equal(gaps.statusCode, 200, gaps.body);
  assert.equal(gaps.json().groups.length, 1);
  const base = `/workspaces/${workspace}/operations/knowledge-improvements`,
    draft = await call("POST", base, {
      reviewId: reviewed.json().id,
      knowledgeBaseId: kb,
      question: "My enquiry",
      answer: "Approved recovery guidance",
    });
  assert.equal(draft.statusCode, 201, draft.body);
  const path = base + "/" + draft.json().id;
  assert.equal(
    (await call("POST", path, { action: "approve" })).statusCode,
    409,
  );
  assert.equal(
    (await call("POST", path, { action: "materialize" }, "reviewer"))
      .statusCode,
    409,
  );
  assert.equal(
    (await call("POST", path, { action: "approve" }, "reviewer")).statusCode,
    200,
  );
  const indexed = await call(
    "POST",
    path,
    { action: "materialize" },
    "reviewer",
  );
  assert.equal(indexed.statusCode, 200, indexed.body);
  const [i] =
    await sql`SELECT * FROM knowledge_improvements WHERE id=${draft.json().id}`;
  assert.equal(i!.status, "materialized");
  const [k] =
    await sql`SELECT published_release_id FROM knowledge_bases WHERE id=${kb}`;
  assert.equal(k!.published_release_id, null);
});
test("Presence utilization clips observed intervals to expiry and records availability changes", async () => {
  await sql`INSERT INTO operator_profiles(workspace_id,organization_id,user_id) VALUES(${workspace},${org},${users.reviewer!})`;
  await sql`INSERT INTO operator_presence_samples(workspace_id,organization_id,user_id,status,expires_at,recorded_at) VALUES(${workspace},${org},${users.reviewer!},'available','2026-01-01T00:10:00Z','2026-01-01T00:00:00Z'),(${workspace},${org},${users.reviewer!},'busy','2026-01-01T00:20:00Z','2026-01-01T00:10:00Z')`;
  const report = await customerReport(workspace, org, {
    from: "2026-01-01T00:00:00Z",
    to: "2026-01-01T00:30:00Z",
  });
  const op = report.operators.find((o) => o.id === users.reviewer);
  assert.equal(op?.staffed_seconds, 1200);
  assert.equal(op?.busy_seconds, 600);
  assert.equal(op?.busy_presence_rate, 0.5);
  await sql`UPDATE operator_profiles SET presence_status='available',presence_expires_at=now()+interval '5 minutes' WHERE workspace_id=${workspace} AND user_id=${users.reviewer!}`;
  await sql`UPDATE operator_profiles SET manual_availability=false WHERE workspace_id=${workspace} AND user_id=${users.reviewer!}`;
  const [latest] =
    await sql`SELECT status FROM operator_presence_samples WHERE workspace_id=${workspace} AND user_id=${users.reviewer!} ORDER BY recorded_at DESC,id DESC LIMIT 1`;
  assert.equal(latest!.status, "offline");
});
test("Concurrent quota reservations are atomic and settling twice does not double count", async () => {
  const c = agentConfig.parse({
      modelId: model,
      maxOutputTokens: 64,
      contextControls: {
        enabled: true,
        inputBudget: 128,
        dailyTokenQuota: 350,
      },
    }),
    m = await modelSnapshot(model, workspace),
    runs =
      await sql`SELECT id FROM agent_runs WHERE conversation_id=${conversation} ORDER BY started_at`,
    [row] = await sql`SELECT * FROM conversations WHERE id=${conversation}`;
  const result = await Promise.allSettled(
    runs
      .slice(0, 2)
      .map((r) =>
        sql.begin((tx) => reserveTokens(tx, c, m, row as never, r.id)),
      ),
  );
  assert.equal(
    result.filter((r) => r.status === "fulfilled").length,
    1,
    JSON.stringify(
      result.map((r) =>
        r.status === "rejected" ? String(r.reason) : "fulfilled",
      ),
    ),
  );
  assert.equal(result.filter((r) => r.status === "rejected").length, 1);
  const [reserved] =
    await sql`SELECT * FROM token_reservations WHERE workspace_id=${workspace}`;
  await sql.begin((tx) => settleTokens(tx, reserved!.run_id, 14));
  await sql.begin((tx) => settleTokens(tx, reserved!.run_id, 14));
  const [usage] =
    await sql`SELECT * FROM customer_token_usage WHERE workspace_id=${workspace}`;
  assert.equal(Number(usage!.used_tokens), 14);
  assert.equal(Number(usage!.reserved_tokens), 0);
});
test("Runtime summaries persist only completed older turns and diagnostics show all provider calls", async () => {
  const c = agentConfig.parse({
    modelId: model,
    maxOutputTokens: 64,
    contextControls: {
      enabled: true,
      inputBudget: 2048,
      historyBudget: 64,
      summarize: true,
      summaryMaxTokens: 64,
      dailyTokenQuota: 100000,
    },
  });
  const saved = await call("PUT", `/agents/${agent}`, {
    name: "Customer fixture",
    description: "",
    publicDescription: "",
    config: c,
    revision: 1,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const published = await call("POST", `/agents/${agent}/publish`, {
    revision: saved.json().revision,
  });
  assert.equal(published.statusCode, 201, published.body);
  await sql`UPDATE deployments SET version_id=${published.json().id} WHERE id=${deployment}`;
  const base = `/public/deployments/${deployment}`;
  const first = await call(
    "POST",
    base + "/chat",
    { message: "old detail ".repeat(80) },
    "owner",
    bearer(),
  );
  assert.equal(first.statusCode, 200, first.body);
  const cid = meta(first.body).conversationId;
  const before = summaryCalls,
    second = await call(
      "POST",
      base + "/chat",
      { message: "Continue with support", conversationId: cid },
      "owner",
      bearer(),
    );
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(summaryCalls, before + 1);
  const [row] =
    await sql`SELECT context_summary FROM conversations WHERE id=${cid}`;
  assert.ok(row!.context_summary.text);
  assert.ok(row!.context_summary.beforeId);
  const third = await call(
    "POST",
    base + "/chat",
    { message: "Thanks", conversationId: cid },
    "owner",
    bearer(),
  );
  assert.equal(third.statusCode, 200);
  assert.equal(summaryCalls, before + 1);
  const counts = await call("GET", `/conversations/${cid}/context`);
  assert.equal(counts.statusCode, 200);
  assert.ok(counts.json()[0].context_breakdown.providerCalls.length);
  assert.equal(
    (await call("GET", `/conversations/${cid}/context`, undefined, "outsider"))
      .statusCode,
    403,
  );
});
test("Oversized input is rejected before provider invocation and quota failures return HTTP 429", async () => {
  const base = `/public/deployments/${deployment}`,
    first = await call(
      "POST",
      base + "/chat",
      { message: "x ".repeat(4000) },
      "owner",
      bearer(),
    );
  assert.equal(first.statusCode, 200, first.body);
  assert.match(first.body, /CONTEXT_LIMIT/);
  const s = await call(
    "POST",
    base + "/sessions",
    undefined,
    "owner",
    bearer(),
  );
  const subject = "customer:" + s.json().id;
  await sql`UPDATE customer_token_usage SET used_tokens=100000,reserved_tokens=0 WHERE workspace_id=${workspace} AND subject=${subject}`;
  const prior = calls,
    rejected = await call(
      "POST",
      base + "/chat",
      { message: "Hi" },
      "owner",
      bearer(),
    );
  assert.equal(rejected.statusCode, 429, rejected.body);
  assert.equal(calls, prior);
});
test("Expired sessions cannot resume using an earlier per-conversation guest grant", async () => {
  const [s] =
    await sql`SELECT customer_session_id FROM conversations WHERE id=${conversation}`;
  await sql`UPDATE customer_sessions SET expires_at=now()-interval '1 second' WHERE id=${s!.customer_session_id}`;
  const base = `/public/deployments/${deployment}`,
    r = await call(
      "POST",
      base + "/chat",
      { message: "Expired", conversationId: conversation },
      "owner",
      { authorization: "Bearer " + legacyGuest },
    );
  assert.equal(r.statusCode, 404);
  assert.equal(
    (
      await call(
        "GET",
        base + `/conversations/${conversation}/handoff`,
        undefined,
        "owner",
        { authorization: "Bearer " + legacyGuest },
      )
    ).statusCode,
    404,
  );
  await sql`UPDATE customer_sessions SET expires_at=now()+interval '1 day' WHERE id=${s!.customer_session_id}`;
});
test("Revoking browser access preserves workspace conversation records", async () => {
  const base = `/public/deployments/${deployment}`;
  assert.equal(
    (await call("DELETE", base + "/sessions", undefined, "owner", bearer()))
      .statusCode,
    204,
  );
  assert.equal(
    (await call("GET", base + "/history", undefined, "owner", bearer()))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await call(
        "POST",
        base + "/chat",
        { message: "Try", conversationId: conversation },
        "owner",
        bearer(),
      )
    ).statusCode,
    401,
  );
  const [row] =
    await sql`SELECT id FROM conversations WHERE id=${conversation}`;
  assert.ok(row);
  assert.ok(calls > 0);
});
