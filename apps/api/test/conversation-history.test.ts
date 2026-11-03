import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest } from "../src/security.js";
import { cleanupKnowledgeFixtures } from "./knowledge-cleanup.mjs";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  wid = randomUUID(),
  foreign = randomUUID(),
  kb = randomUUID(),
  embedding = randomUUID(),
  caseId = randomUUID(),
  human = randomUUID(),
  note = randomUUID();
const users: Record<string, string> = {},
  cookies: Record<string, string> = {};
let aid = "",
  cid = "",
  guest = "",
  mid = "";
const app = await buildApp({
  providerFactory: () => ({
    async *stream() {
      yield { type: "token", text: "Original AI answer" };
      yield { type: "usage", inputTokens: 10, outputTokens: 5 };
    },
  }),
});
async function call(
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  role = "owner",
) {
  return app.inject({
    method,
    url,
    headers: {
      origin: config.WEB_ORIGIN,
      cookie: cookies[role] ?? "",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    payload: body ? JSON.stringify(body) : undefined,
  });
}
function meta(body: string) {
  return JSON.parse(
    body
      .split("\n\n")
      .find((v) => v.startsWith("event: meta"))!
      .split("\n")[1]!
      .slice(6),
  );
}
const base = `/workspaces/${wid}/conversation-history`;
before(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES(${org},'History test')`;
    for (const id of [wid, foreign])
      await tx`INSERT INTO workspaces(id,organization_id,name) VALUES(${id},${org},'History workspace')`;
    for (const role of ["owner", "analyst", "outsider"]) {
      const uid = randomUUID(),
        raw = randomUUID();
      users[role] = uid;
      cookies[role] = `session=${raw}`;
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES(${uid},${uid + "@example.invalid"},${role},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(${digest(raw)},${uid},now()+interval '1 hour')`;
      if (role !== "outsider")
        await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES(${randomUUID()},${org},${role === "owner" ? null : wid},${uid},${role})`;
    }
    await tx`INSERT INTO embedding_models(id,organization_id,workspace_id,name,provider,model_id,base_url,dimensions) VALUES(${embedding},${org},${wid},'Fixture','openai-compatible','fixture','https://example.test',2)`;
    await tx`INSERT INTO knowledge_bases(id,organization_id,workspace_id,name,description,embedding_model_id,dimensions,chunk_size,chunk_overlap,chunk_strategy) VALUES(${kb},${org},${wid},'Golden KB','Reviewed answers',${embedding},2,500,50,'recursive')`;
  });
  const model = (
    await call("POST", `/workspaces/${wid}/models`, {
      name: "History model",
      provider: "openai-compatible",
      modelId: "fixture",
      baseUrl: "https://api.openai.com/v1",
    })
  ).json().id;
  const agent = await call("POST", `/workspaces/${wid}/agents`, {
    name: "History agent",
    config: { modelId: model },
  });
  assert.equal(agent.statusCode, 201, agent.body);
  aid = agent.json().id;
  const chat = await call("POST", `/agents/${aid}/chat`, {
    message: "How does this work?",
  });
  assert.equal(chat.statusCode, 200, chat.body);
  cid = meta(chat.body).conversationId;
  const [message] =
    await sql`SELECT id FROM messages WHERE conversation_id=${cid} AND role='assistant'`;
  mid = message!.id;
  const v = (
    await call("POST", `/agents/${aid}/publish`, { revision: 1 })
  ).json().id;
  const d = (
    await call("POST", `/agents/${aid}/deployments`, {
      name: "Portal",
      versionId: v,
    })
  ).json().id;
  const anon = await call(
    "POST",
    `/public/deployments/${d}/chat`,
    { message: "Anonymous question" },
    "",
  );
  assert.equal(anon.statusCode, 200, anon.body);
  guest = meta(anon.body).conversationId;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO support_cases(id,workspace_id,organization_id,conversation_id,status) VALUES(${caseId},${wid},${org},${cid},'active')`;
    for (const [id, type, content] of [
      [human, "message.created", "Human specialist answer"],
      [note, "note.created", "PRIVATE NOTE"],
    ])
      await tx`INSERT INTO support_events(id,workspace_id,organization_id,conversation_id,support_case_id,type,actor_type,actor_id,payload) VALUES(${id!},${wid},${org},${cid},${caseId},${type!},'operator',${users.owner!},${tx.json({ content })})`;
  });
});
after(async () => {
  await cleanupKnowledgeFixtures(sql, org);
  await sql.begin(async (tx) => {
    for (const table of [
      "knowledge_jobs",
      "knowledge_sources",
      "knowledge_bases",
      "embedding_models",
      "conversation_reviews",
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
      await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    await tx`DELETE FROM sessions WHERE user_id=ANY(${Object.values(users)})`;
    await tx`DELETE FROM users WHERE id=ANY(${Object.values(users)})`;
  });
  await app.close();
});
test("History filters identities and human text without exposing private notes or tenant data", async () => {
  const all = await call("GET", base);
  assert.equal(all.statusCode, 200, all.body);
  assert.equal(all.json().items.length, 2);
  const anonymous = (
    await call("GET", base + "?identity=anonymous&channel=hosted")
  ).json().items;
  assert.equal(anonymous.length, 1);
  assert.equal(anonymous[0].id, guest);
  assert.equal(anonymous[0].customer_name, "Anonymous");
  assert.equal(
    (await call("GET", base + "?identity=registered")).json().items[0]
      .customer_name,
    "owner",
  );
  assert.equal(
    (await call("GET", base + "?search=Human%20specialist")).json().items[0].id,
    cid,
  );
  assert.equal(
    (await call("GET", base + "?search=PRIVATE")).json().items.length,
    0,
  );
  assert.equal(
    (await call("GET", base, undefined, "outsider")).statusCode,
    403,
  );
  assert.equal(
    (await call("GET", `/workspaces/${foreign}/conversation-history/${cid}`))
      .statusCode,
    404,
  );
  assert.equal(
    (await call("GET", base + "?beforeId=" + randomUUID())).statusCode,
    400,
  );
  const detail = await call("GET", base + `/${guest}`);
  assert.ok(!detail.body.includes("guest_token_hash"));
  assert.ok(!detail.body.includes("config_snapshot"));
});
test("Session and unified message pagination includes AI and human replies without private notes", async () => {
  const first = (await call("GET", base + "?limit=1")).json();
  const next = (
    await call(
      "GET",
      base + "?limit=1&" + new URLSearchParams(first.nextCursor),
    )
  ).json();
  assert.equal(first.items.length, 1);
  assert.equal(next.items.length, 1);
  assert.notEqual(first.items[0].id, next.items[0].id);
  assert.equal(next.nextCursor, null);
  const data = (await call("GET", base + `/${cid}/timeline?limit=100`)).json();
  assert.ok(
    data.items.some(
      (m: { id: string; role: string }) => m.id === human && m.role === "human",
    ),
  );
  assert.ok(data.items.some((m: { id: string }) => m.id === mid));
  assert.ok(!JSON.stringify(data).includes("PRIVATE"));
  const a = (await call("GET", base + `/${cid}/timeline?limit=1`)).json();
  const b = (
    await call(
      "GET",
      base + `/${cid}/timeline?limit=1&` + new URLSearchParams(a.nextCursor),
    )
  ).json();
  assert.notEqual(a.items[0].id, b.items[0].id);
});
test("Golden answers preserve originals, enforce reviewer permissions, prevent duplicates and retain provenance", async () => {
  const body = {
    knowledgeBaseId: kb,
    messageId: mid,
    question: "How does this work?",
    answer: "Reviewed golden answer",
  };
  assert.equal(
    (await call("POST", base + `/${cid}/golden-answers`, body, "analyst"))
      .statusCode,
    403,
  );
  assert.equal(
    (await call("POST", base + `/${guest}/golden-answers`, body)).statusCode,
    404,
  );
  assert.equal(
    (
      await call("POST", base + `/${cid}/golden-answers`, {
        ...body,
        messageId: note,
      })
    ).statusCode,
    404,
  );
  const saved = await call("POST", base + `/${cid}/golden-answers`, body);
  assert.equal(saved.statusCode, 202, saved.body);
  assert.equal(
    (await call("POST", base + `/${cid}/golden-answers`, body)).statusCode,
    409,
  );
  assert.equal(
    (
      await call("POST", base + `/${cid}/golden-answers`, {
        ...body,
        messageId: human,
      })
    ).statusCode,
    202,
  );
  const sources = await call("GET", `/knowledge-bases/${kb}/sources`);
  assert.equal(sources.statusCode, 200, sources.body);
  assert.equal(sources.json().length, 2);
  for (const source of sources.json()) {
    assert.equal(source.metadata.provenance.conversationId, cid);
    assert.equal(source.metadata.provenance.reviewerId, users.owner);
    assert.equal(source.metadata.goldenAnswer, true);
  }
  const [original] = await sql`SELECT content FROM messages WHERE id=${mid}`;
  assert.equal(original!.content, "Original AI answer");
  assert.equal(
    (await call("GET", base + `/${cid}`)).json().goldenAnswers.length,
    2,
  );
});
