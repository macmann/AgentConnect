import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import {
  randomUUID,
  randomBytes,
  createHmac,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { token, digest } from "../src/security.js";
import { agentConfig } from "@agentconnect/schemas/agents";
import { modelSnapshot } from "../src/agents.js";
import { workflowGraph } from "@agentconnect/schemas/workflows";
import {
  processWorkflowRun,
  closeWorkflowSaver,
} from "../src/workflow-runtime.js";
import {
  processMessagingJob,
  queueSupportMessages,
} from "../src/messaging-worker.js";
import { channelCredentials } from "../src/messaging-channels.js";
import {
  incomingMessages,
  sendMessaging,
  validSignature,
  verifyTeamsActivity,
  teamsServiceUrl,
  type MessagingHttp,
} from "../src/customer-messaging-adapters.js";
import { semanticClusters } from "../src/semantic-gaps.js";
import { customerReport } from "../src/customer-reports.js";
import { widgetBundle } from "../src/widget-bundle.js";
import { deleteKnowledge } from "../src/knowledge-storage.js";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  workspace = randomUUID(),
  owner = randomUUID(),
  outsider = randomUUID(),
  model = randomUUID(),
  agent = randomUUID(),
  version = randomUUID(),
  deployment = randomUUID(),
  workflow = randomUUID(),
  workflowVersion = randomUUID(),
  embedding = randomUUID(),
  privateTool = randomUUID();
const ownerSession = token(),
  otherSession = token(),
  ip = `127.${randomBytes(1)[0]}.${randomBytes(1)[0]}.51`;
let chatCalls = 0,
  publicToken = "",
  conversation = "";
const callbackBefore = config.MESSAGING_PUBLIC_URL;
const requests: {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}[] = [];
let failDelivery = false;
const http: MessagingHttp = async (url, headers, body) => {
  requests.push({ url, headers, body });
  let data: unknown = { ok: true, result: true, status: 0 };
  if (url.endsWith("/getMe"))
    data = { ok: true, result: { username: "fixture_bot" } };
  if (url.includes("facebook.com") && url.includes("/me?"))
    data = { id: "12345", name: "Fixture page" };
  if (url.endsWith("/get_account_info"))
    data = { status: 0, name: "Fixture Viber" };
  if (url.includes("/oauth2/"))
    data = { access_token: "fixture-oauth-not-live" };
  if (failDelivery && url.endsWith("/sendMessage"))
    return {
      status: 503,
      body: (async function* () {
        yield Buffer.from("{}");
      })(),
      close: async () => {},
    };
  return {
    status: 200,
    body: (async function* () {
      yield Buffer.from(JSON.stringify(data));
    })(),
    close: async () => {},
  };
};
const app = await buildApp({
  messagingHttp: http,
  embeddingFactory: () => ({
    async embed(texts) {
      return texts.map((t) => (t.includes("branch") ? [0, 1, 0] : [1, 0, 0]));
    },
  }),
  providerFactory: () => ({
    async *stream() {
      chatCalls++;
      yield {
        type: "token",
        text: JSON.stringify({
          version: 1,
          message: "Fixture answer.",
          blocks: [],
        }),
      };
      yield { type: "usage", inputTokens: 4, outputTokens: 3 };
    },
  }),
});
async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    remoteAddress: ip,
    headers: {
      origin: config.WEB_ORIGIN,
      cookie: "session=" + ownerSession,
      ...headers,
    },
    ...(payload === undefined
      ? {}
      : {
          payload: JSON.stringify(payload),
          headers: {
            origin: config.WEB_ORIGIN,
            cookie: "session=" + ownerSession,
            "content-type": "application/json",
            ...headers,
          },
        }),
  });
}
const publicHeaders = () => ({ authorization: "Bearer " + publicToken });
const base = `/public/deployments/${deployment}`;
const graph = workflowGraph.parse({
  nodes: [
    {
      id: "input",
      type: "input",
      position: { x: 0, y: 0 },
      data: { label: "Input" },
    },
    {
      id: "output",
      type: "output",
      position: { x: 200, y: 0 },
      data: { label: "Result", prefix: "Completed: " },
    },
  ],
  edges: [{ id: "io", source: "input", target: "output" }],
});
before(async () => {
  config.MESSAGING_PUBLIC_URL = "https://api.fixture.example";
  await sql.begin(async (tx) => {
    for (const [uid, session] of [
      [owner, ownerSession],
      [outsider, otherSession],
    ]) {
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES(${uid!},${uid! + "@example.com"},'Fixture','not-login',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(${digest(session!)},${uid!},now()+interval '1 hour')`;
    }
    await tx`INSERT INTO organizations(id,name) VALUES(${org},'Engagement fixture')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES(${workspace},${org},'Engagement fixture')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES(${randomUUID()},${org},${owner},'owner')`;
    await tx`INSERT INTO embedding_models(id,organization_id,workspace_id,name,provider,model_id,base_url,dimensions) VALUES(${embedding},${org},${workspace},'Semantic fixture','openai-compatible','fixture','https://api.deepseek.com',3)`;
    await tx`INSERT INTO model_configurations(id,organization_id,workspace_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES(${model},${org},${workspace},'Fixture','openai-compatible','fixture','https://api.deepseek.com',32768,4096,${tx.json({ streaming: true, temperature: true, topP: true })})`;
    await tx`INSERT INTO workflows(id,workspace_id,organization_id,name,description,draft_graph,created_by) VALUES(${workflow},${workspace},${org},'Customer lookup','',${tx.json(graph)},${owner})`;
    await tx`INSERT INTO workflow_versions(id,workflow_id,workspace_id,organization_id,version,name,graph,published_by) VALUES(${workflowVersion},${workflow},${workspace},${org},1,'Customer lookup',${tx.json(graph)},${owner})`;
  });
  const c = agentConfig.parse({
    modelId: model,
    generative: { enabled: true, allowPublicForms: true },
    quickActions: [
      {
        id: "lookup",
        label: "Lookup",
        message: "Find approved information",
        behavior: "workflow",
        workflowVersionId: workflowVersion,
        workflowFields: [
          {
            name: "reference",
            label: "Reference",
            type: "text",
            required: true,
          },
        ],
      },
    ],
  });
  const snapshot = await modelSnapshot(model, workspace, c);
  await sql.begin(async (tx) => {
    await tx`INSERT INTO agents(id,organization_id,workspace_id,name,description,public_description,draft_config,created_by) VALUES(${agent},${org},${workspace},'Engagement','','',${tx.json(c)},${owner})`;
    await tx`INSERT INTO agent_versions(id,agent_id,workspace_id,organization_id,version,name,public_description,config,model_snapshot,model_id,published_by) VALUES(${version},${agent},${workspace},${org},1,'Engagement','',${tx.json(c)},${tx.json(snapshot)},${model},${owner})`;
    await tx`INSERT INTO deployments(id,workspace_id,organization_id,agent_id,version_id,name,environment,widget_settings) VALUES(${deployment},${workspace},${org},${agent},${version},'Fixture','development',${tx.json({ enabled: true, access: "restricted", allowedOrigins: ["https://widget.example"], theme: "light", position: "right", launcher: "Chat", greeting: "Hello", width: 380, height: 560, language: "en" })})`;
    await tx`INSERT INTO tools(id,workspace_id,organization_id,name,description,kind,config,input_schema,timeout_ms) VALUES(${privateTool},${workspace},${org},'Private fixture','Private read-only lookup','http',${tx.json({ kind: "http", url: "https://example.com" })},${tx.json({})},5000)`;
  });
  const session = await call("POST", base + "/sessions");
  assert.equal(session.statusCode, 201, session.body);
  publicToken = session.json().token;
  const created = await call(
    "POST",
    base + "/conversations",
    {},
    publicHeaders(),
  );
  assert.equal(created.statusCode, 201, created.body);
  conversation = created.json().conversationId;
});
after(async () => {
  config.MESSAGING_PUBLIC_URL = callbackBefore;
  const artifacts =
    await sql`SELECT storage_key FROM generated_artifacts WHERE organization_id=${org}`;
  await Promise.all(artifacts.map((a) => deleteKnowledge(a.storage_key)));
  const runs =
    await sql`SELECT id FROM workflow_runs WHERE organization_id=${org}`;
  const saver = await import("../src/workflow-runtime.js").then((m) =>
    m.workflowSaver(),
  );
  for (const r of runs) await saver.deleteThread(r.id);
  await closeWorkflowSaver();
  await sql.begin(async (tx) => {
    await tx`DELETE FROM messaging_channels WHERE organization_id=${org}`;
    for (const table of [
      "workflow_approvals",
      "workflow_node_runs",
      "tool_executions",
      "workflow_runs",
      "workflow_versions",
      "workflows",
      "collected_submissions",
      "generated_artifacts",
      "support_events",
      "support_case_contexts",
      "support_case_assignments",
      "support_cases",
      "handoff_events",
      "conversation_reviews",
      "messages",
      "agent_runs",
      "conversations",
      "deployments",
      "agent_versions",
      "agents",
      "tools",
      "model_configurations",
      "embedding_models",
      "audit_events",
      "memberships",
      "workspaces",
    ]) {
      if (
        table === "support_case_contexts" ||
        table === "support_case_assignments"
      )
        continue;
      await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
    }
    await tx`DELETE FROM organizations WHERE id=${org}`;
    await tx`DELETE FROM users WHERE id=ANY(${[owner, outsider]}::uuid[])`;
  });
  await app.close();
});
test("CSAT is customer-scoped, validated and distinct from staff reviews", async () => {
  const path = base + "/conversations/" + conversation + "/feedback";
  assert.equal(
    (await call("PUT", path, { rating: 5, resolved: true }, publicHeaders()))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await call(
        "POST",
        base + "/chat",
        { conversationId: conversation, message: "Hello" },
        publicHeaders(),
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (await call("PUT", path, { rating: 6, resolved: true }, publicHeaders()))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await call(
        "PUT",
        path,
        { rating: 5, resolved: true, comment: "Helpful" },
        publicHeaders(),
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (await call("GET", path, undefined, { authorization: "Bearer " + token() }))
      .statusCode,
    404,
  );
  assert.equal(
    (await call("GET", path, undefined, publicHeaders())).json().rating,
    5,
  );
  const report = await customerReport(workspace, org, {
    from: new Date(Date.now() - 86400000).toISOString(),
    to: new Date(Date.now() + 1000).toISOString(),
  });
  assert.equal(report.feedback!.average_csat, 5);
  assert.equal(report.feedback!.confirmed_ai_resolved, 1);
  assert.equal(
    (
      await call(
        "PUT",
        path,
        { rating: 2, resolved: false, comment: "Changed my mind" },
        publicHeaders(),
      )
    ).statusCode,
    200,
  );
  const changed = (await call("GET", path, undefined, publicHeaders())).json();
  assert.equal(changed.resolved, false);
  assert.equal(changed.rating, 2);
});
test("Customer workflows validate inputs, are idempotent, resume and protect version and ownership", async () => {
  const path = base + "/conversations/" + conversation + "/workflows",
    requestId = randomUUID();
  assert.equal(
    (
      await call(
        "POST",
        path,
        { actionId: "lookup", requestId, values: {} },
        publicHeaders(),
      )
    ).statusCode,
    400,
  );
  const input = { actionId: "lookup", requestId, values: { reference: "ABC" } };
  assert.equal(
    (await call("POST", path, input, publicHeaders())).statusCode,
    201,
  );
  assert.equal(
    (await call("POST", path, input, publicHeaders())).statusCode,
    201,
  );
  assert.equal(
    (
      await call(
        "POST",
        path,
        { ...input, values: { reference: "Different" } },
        publicHeaders(),
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await call(
        "POST",
        path,
        { ...input, versionId: randomUUID() },
        publicHeaders(),
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call("GET", path + "/" + requestId, undefined, {
        authorization: "Bearer " + token(),
      })
    ).statusCode,
    404,
  );
  assert.equal(await processWorkflowRun(), true);
  const result = await call(
    "GET",
    path + "/" + requestId,
    undefined,
    publicHeaders(),
  );
  assert.equal(result.json().status, "completed");
  assert.match(result.json().output, /ABC/);
  assert.equal(result.json().steps.length, 2);
  const replay = await app.inject({
    method: "POST",
    url: path,
    payload: input,
    headers: { origin: config.WEB_ORIGIN, ...publicHeaders() },
    remoteAddress: "127.2.3.51",
  });
  assert.equal(replay.json().status, "completed");
  const [run] =
    await sql`SELECT user_id,conversation_id,version_id FROM workflow_runs WHERE id=${requestId}`;
  assert.equal(run!.user_id, null);
  assert.equal(run!.version_id, workflowVersion);
  assert.equal(run!.conversation_id, conversation);
});
test("Public workflow validation rejects private tool attachments", async () => {
  const hiddenGraph = workflowGraph.parse({
    nodes: [
      {
        id: "i",
        type: "input",
        position: { x: 0, y: 0 },
        data: { label: "Input" },
      },
      {
        id: "t",
        type: "tool",
        position: { x: 100, y: 0 },
        data: { label: "Private", toolId: privateTool },
      },
      {
        id: "o",
        type: "output",
        position: { x: 200, y: 0 },
        data: { label: "Output" },
      },
    ],
    edges: [
      { id: "it", source: "i", target: "t" },
      { id: "to", source: "t", target: "o" },
    ],
  });
  const hidden = randomUUID();
  await sql`INSERT INTO workflow_versions(id,workflow_id,workspace_id,organization_id,version,name,graph,published_by) VALUES(${hidden},${workflow},${workspace},${org},2,'Private',${sql.json(hiddenGraph)},${owner})`;
  const { validateCustomerActions } =
    await import("../src/customer-workflows.js");
  await assert.rejects(
    validateCustomerActions(
      agentConfig.parse({
        modelId: model,
        quickActions: [
          {
            id: "private",
            label: "Private",
            message: "Lookup",
            behavior: "workflow",
            workflowVersionId: hidden,
          },
        ],
      }),
      workspace,
      org,
      true,
    ),
    /TOOL_NOT_PUBLIC/,
  );
});
test("Semantic clustering retains examples and reviewer split/merge choices", async () => {
  const questions = ["reset password", "recover my login", "find a branch"],
    ids: string[] = [];
  for (const question of questions) {
    const run = randomUUID();
    ids.push(run);
    await sql`INSERT INTO agent_runs(id,conversation_id,workspace_id,organization_id,status,trace_id,answer_kind,finished_at) VALUES(${run},${conversation},${workspace},${org},'completed',${run},'no_answer',now())`;
    await sql`INSERT INTO messages(id,conversation_id,workspace_id,organization_id,run_id,role,content) VALUES(${randomUUID()},${conversation},${workspace},${org},${run},'user',${question})`;
  }
  const gapBase = `/workspaces/${workspace}/operations/knowledge-gaps`,
    range = {
      from: new Date(Date.now() - 86400000).toISOString(),
      to: new Date(Date.now() + 10000).toISOString(),
    };
  const clustered = await call("POST", gapBase + "/cluster", {
    ...range,
    modelId: embedding,
  });
  assert.equal(clustered.statusCode, 200, clustered.body);
  const grouped = await call("GET", gapBase + "?" + new URLSearchParams(range));
  const relevant = grouped
    .json()
    .groups.find((g: { examples: { question: string }[] }) =>
      g.examples.some((e) => e.question === "reset password"),
    );
  assert.ok(
    relevant.examples.some(
      (e: { question: string }) => e.question === "recover my login",
    ),
  );
  assert.ok(
    !relevant.examples.some(
      (e: { question: string }) => e.question === "find a branch",
    ),
  );
  assert.equal(
    (
      await call("POST", gapBase + "/assign", {
        runIds: [ids[1]],
        targetRunId: null,
      })
    ).statusCode,
    200,
  );
  await call("POST", gapBase + "/cluster", { ...range, modelId: embedding });
  const [manual] =
    await sql`SELECT method,group_key FROM knowledge_gap_assignments WHERE run_id=${ids[1]!}`;
  assert.equal(manual!.method, "reviewer");
  assert.equal(
    (
      await call("POST", gapBase + "/assign", {
        runIds: [ids[1]],
        targetRunId: ids[2],
      })
    ).statusCode,
    200,
  );
  const assignments =
    await sql`SELECT group_key FROM knowledge_gap_assignments WHERE run_id=ANY(${[ids[1]!, ids[2]!]}::uuid[])`;
  assert.equal(assignments[0]!.group_key, assignments[1]!.group_key);
  assert.equal(
    (
      await call("POST", gapBase + "/assign", {
        runIds: [randomUUID()],
        targetRunId: ids[2],
      })
    ).statusCode,
    404,
  );
  assert.deepEqual(
    semanticClusters(
      [
        [1, 0],
        [0.9, 0.3],
        [0.65, 0.76],
      ],
      0.8,
    ),
    [[0, 1], [2]],
  );
  assert.throws(() => semanticClusters([[0, 0]]));
});
test("Messaging credentials are encrypted, scoped, editable and provider setup uses fixed endpoints", async () => {
  for (const provider of ["telegram", "viber", "messenger", "teams"] as const) {
    const credentials =
      provider === "teams"
        ? {
            appId: randomUUID(),
            appSecret: "fixture-client-secret",
            tenantId: randomUUID(),
          }
        : provider === "messenger"
          ? { token: "fixture-page-token", appSecret: "fixture-meta-secret" }
          : {
              token:
                provider === "telegram"
                  ? "1234:fixture_token"
                  : "fixture-viber-token",
            };
    const created = await call(
      "POST",
      `/workspaces/${workspace}/messaging-channels`,
      { name: provider, provider, deploymentId: deployment, credentials },
    );
    assert.equal(created.statusCode, 201, created.body);
    const channelId = created.json().id,
      connected = await call(
        "POST",
        `/workspaces/${workspace}/messaging-channels/${channelId}/connect`,
        {},
      );
    assert.equal(connected.statusCode, 200, connected.body);
    const [row] =
      await sql`SELECT * FROM messaging_channels WHERE id=${channelId}`;
    assert.doesNotMatch(
      JSON.stringify(row!.credentials),
      /fixture_token|fixture-page-token|fixture-client-secret/,
    );
    const listed = await call(
      "GET",
      `/workspaces/${workspace}/messaging-channels`,
    );
    assert.ok(!listed.body.includes("fixture_token"));
    assert.ok(!listed.body.includes("fixture-client-secret"));
    assert.equal(
      (
        await call(
          "GET",
          `/workspaces/${workspace}/messaging-channels`,
          undefined,
          { cookie: "session=" + otherSession },
        )
      ).statusCode,
      403,
    );
  }
  assert.ok(
    requests.some(
      (r) =>
        r.url.endsWith("/setWebhook") &&
        (r.body as { url: string }).url.startsWith(
          "https://api.fixture.example/",
        ),
    ),
  );
  assert.ok(
    requests.some(
      (r) =>
        r.url.endsWith("/set_webhook") &&
        (r.body as { event_types: string[] }).event_types.includes(
          "conversation_started",
        ),
    ),
  );
  const [telegram] =
    await sql`SELECT * FROM messaging_channels WHERE workspace_id=${workspace} AND provider='telegram'`;
  const prior = channelCredentials(telegram!);
  assert.equal(
    (
      await call(
        "PUT",
        `/workspaces/${workspace}/messaging-channels/${telegram!.id}`,
        {
          name: "Renamed",
          provider: "telegram",
          deploymentId: deployment,
          credentials: {},
        },
      )
    ).statusCode,
    200,
  );
  const [changed] =
    await sql`SELECT * FROM messaging_channels WHERE id=${telegram!.id}`;
  assert.equal(changed!.enabled, false);
  assert.equal(channelCredentials(changed!).token, prior.token);
  await call(
    "POST",
    `/workspaces/${workspace}/messaging-channels/${telegram!.id}/connect`,
    {},
  );
});
test("Signed webhooks deduplicate events and channel delivery reuses conversations and saved replies", async () => {
  const [channel] =
      await sql`SELECT * FROM messaging_channels WHERE workspace_id=${workspace} AND provider='telegram'`,
    c = channelCredentials(channel!);
  const url = "/messaging/webhooks/" + channel!.id;
  const incoming = {
    update_id: 1,
    message: {
      text: "Hello",
      chat: { id: 42, type: "private" },
      from: { is_bot: false },
    },
  };
  const request = () =>
    app.inject({
      method: "POST",
      url,
      payload: incoming,
      headers: { "x-telegram-bot-api-secret-token": c.webhookSecret! },
      remoteAddress: ip,
    });
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url,
        payload: incoming,
        remoteAddress: ip,
      })
    ).statusCode,
    401,
  );
  assert.equal((await request()).statusCode, 200);
  assert.equal((await request()).statusCode, 200);
  const before = chatCalls;
  failDelivery = true;
  assert.equal(await processMessagingJob(app, http), true);
  failDelivery = false;
  const [queued] =
    await sql`SELECT * FROM messaging_inbox WHERE channel_id=${channel!.id} AND event_id='1'`;
  assert.equal(queued!.status, "sending");
  assert.match(queued!.reply, /Fixture answer/);
  assert.equal(chatCalls, before + 1);
  await sql`UPDATE messaging_inbox SET next_attempt_at=now() WHERE id=${queued!.id}`;
  assert.equal(await processMessagingJob(app, http), true);
  assert.equal(chatCalls, before + 1);
  const [done] =
    await sql`SELECT status FROM messaging_inbox WHERE id=${queued!.id}`;
  assert.equal(done!.status, "completed");
  const [client] =
    await sql`SELECT * FROM messaging_customers WHERE channel_id=${channel!.id}`;
  assert.ok(client!.conversation_id);
  await app.inject({
    method: "POST",
    url,
    payload: {
      ...incoming,
      update_id: 2,
      message: { ...incoming.message, text: "/rating 4" },
    },
    headers: { "x-telegram-bot-api-secret-token": c.webhookSecret! },
    remoteAddress: ip,
  });
  await processMessagingJob(app, http);
  const [feedback] =
    await sql`SELECT rating FROM customer_feedback WHERE conversation_id=${client!.conversation_id}`;
  assert.equal(feedback!.rating, 4);
  assert.equal(chatCalls, before + 1);
  await sql`INSERT INTO handoff_events(id,conversation_id,workspace_id,organization_id,kind,actor_id,content) VALUES(${randomUUID()},${client!.conversation_id},${workspace},${org},'operator_message',${owner},'Support reply')`;
  await queueSupportMessages();
  await queueSupportMessages();
  assert.equal(await processMessagingJob(app, http), true);
  const outbound = requests.filter(
    (r) =>
      r.url.endsWith("/sendMessage") &&
      (r.body as { text: string }).text === "Support reply",
  );
  assert.equal(outbound.length, 1);
  const [facebook] =
    await sql`SELECT * FROM messaging_channels WHERE workspace_id=${workspace} AND provider='messenger'`;
  const mc = channelCredentials(facebook!);
  const challenge = await app.inject({
    method: "GET",
    url:
      "/messaging/webhooks/" +
      facebook!.id +
      "?" +
      new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.verify_token": mc.webhookSecret!,
        "hub.challenge": "123",
      }),
  });
  assert.equal(challenge.body, "123");
  const body = JSON.stringify({
    object: "page",
    entry: [
      {
        id: "12345",
        messaging: [
          { sender: { id: "user" }, message: { mid: "m1", text: "Hello" } },
        ],
      },
    ],
  });
  const signature =
    "sha256=" + createHmac("sha256", mc.appSecret!).update(body).digest("hex");
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/messaging/webhooks/" + facebook!.id,
        payload: body,
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signature,
        },
        remoteAddress: ip,
      })
    ).statusCode,
    200,
  );
  assert.equal(await processMessagingJob(app, http), true);
  const [viber] =
    await sql`SELECT * FROM messaging_channels WHERE workspace_id=${workspace} AND provider='viber'`;
  const vc = channelCredentials(viber!);
  const viberBody =
    '{"event":"message","message_token":9223372036854775807,"sender":{"id":"viber-customer"},"message":{"type":"text","text":"Hello"}}';
  const viberRequest = () =>
    app.inject({
      method: "POST",
      url: "/messaging/webhooks/" + viber!.id,
      payload: viberBody,
      headers: {
        "content-type": "application/json",
        "x-viber-content-signature": createHmac("sha256", vc.token!)
          .update(viberBody)
          .digest("hex"),
      },
      remoteAddress: ip,
    });
  assert.equal((await viberRequest()).statusCode, 200);
  assert.equal((await viberRequest()).statusCode, 200);
  const viberJobs =
    await sql`SELECT event_id FROM messaging_inbox WHERE channel_id=${viber!.id}`;
  assert.equal(viberJobs.length, 1);
  assert.equal(viberJobs[0]!.event_id, "9223372036854775807");
  assert.equal(await processMessagingJob(app, http), true);
});
test("Teams JWT validates signature, audience, tenant and authenticated service URL", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    }),
    appId = randomUUID(),
    tenantId = randomUUID(),
    key = {
      ...publicKey.export({ format: "jwk" }),
      kid: "fixture-unique-key",
      use: "sig",
    };
  const httpKeys: MessagingHttp = async () => ({
    status: 200,
    body: (async function* () {
      yield Buffer.from(JSON.stringify({ keys: [key] }));
    })(),
    close: async () => {},
  });
  const activity = {
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    channelData: { tenant: { id: tenantId } },
  };
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: key.kid }),
  ).toString("base64url");
  const jwt = (overrides: Record<string, unknown> = {}) => {
    const payload = Buffer.from(
      JSON.stringify({
        iss: "https://api.botframework.com",
        aud: appId,
        nbf: Date.now() / 1000 - 10,
        exp: Date.now() / 1000 + 300,
        serviceurl: activity.serviceUrl,
        ...overrides,
      }),
    ).toString("base64url");
    const value = header + "." + payload;
    return (
      "Bearer " +
      value +
      "." +
      sign("RSA-SHA256", Buffer.from(value), privateKey).toString("base64url")
    );
  };
  await verifyTeamsActivity(jwt(), { appId, tenantId }, activity, httpKeys);
  await assert.rejects(
    verifyTeamsActivity(
      jwt({ aud: "wrong" }),
      { appId, tenantId },
      activity,
      httpKeys,
    ),
    /CHANNEL_SIGNATURE_INVALID/,
  );
  await assert.rejects(
    verifyTeamsActivity(
      jwt(),
      { appId, tenantId: "different" },
      activity,
      httpKeys,
    ),
    /TEAMS_TENANT_REJECTED/,
  );
  await assert.rejects(
    verifyTeamsActivity(
      jwt(),
      { appId, tenantId },
      { ...activity, serviceUrl: "https://evil.example" },
      httpKeys,
    ),
    /CHANNEL_SIGNATURE_INVALID/,
  );
  const [teams] =
    await sql`SELECT id FROM messaging_channels WHERE workspace_id=${workspace} AND provider='teams'`;
  const base = `/workspaces/${workspace}/messaging-channels/${teams!.id}`;
  const edited = await call("PUT", base, {
    name: "Teams fixture",
    provider: "teams",
    deploymentId: deployment,
    credentials: { appId, appSecret: "fixture-not-live", tenantId },
  });
  assert.equal(edited.statusCode, 200, edited.body);
  const connected = await call("POST", base + "/connect");
  assert.equal(connected.statusCode, 200, connected.body);
  const body = {
    ...activity,
    type: "message",
    id: "teams-event-1",
    text: "Hello from Teams",
    conversation: { id: "personal-conversation", conversationType: "personal" },
    from: { id: "teams-customer" },
    recipient: { id: "bot" },
  };
  const webhook = () =>
    app.inject({
      method: "POST",
      url: "/messaging/webhooks/" + teams!.id,
      headers: { authorization: jwt() },
      payload: body,
      remoteAddress: ip,
    });
  assert.equal((await webhook()).statusCode, 200);
  assert.equal((await webhook()).statusCode, 200);
  const queued =
    await sql`SELECT id FROM messaging_inbox WHERE channel_id=${teams!.id} AND event_id='teams-event-1'`;
  assert.equal(queued.length, 1);
  assert.equal(await processMessagingJob(app, http), true);
  assert.throws(() => teamsServiceUrl("https://127.0.0.1/path"));
  assert.throws(() =>
    teamsServiceUrl("https://smba.trafficmanager.net.evil.example/path"),
  );
});
test("All four outbound adapters deliver text and widget bundle contains executable rich controls", async () => {
  failDelivery = false;
  for (const provider of ["telegram", "viber", "messenger", "teams"] as const)
    await sendMessaging(
      provider,
      { token: "fixture", appId: randomUUID(), appSecret: "fixture" },
      {
        recipientId: "customer",
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        conversationId: "conversation",
        botId: "bot",
      },
      "Hello",
      "Fixture",
      http,
    );
  assert.ok(requests.some((r) => r.url.endsWith("/pa/send_message")));
  assert.ok(requests.some((r) => r.url.endsWith("/me/messages")));
  assert.ok(
    requests.some((r) =>
      r.url.includes("/v3/conversations/conversation/activities"),
    ),
  );
  assert.equal(
    incomingMessages("telegram", {
      update_id: 3,
      message: { text: "Group message", chat: { id: 44, type: "group" } },
    }).length,
    0,
  );
  const raw = '{"event":"message"}';
  assert.ok(
    validSignature(
      raw,
      "secret",
      createHmac("sha256", "secret").update(raw).digest("hex"),
    ),
  );
  assert.equal(
    validSignature(
      raw + " ",
      "secret",
      createHmac("sha256", "secret").update(raw).digest("hex"),
    ),
    false,
  );
  assert.doesNotThrow(() => new Function(widgetBundle));
  assert.match(widgetBundle, /View chart data/);
  assert.match(widgetBundle, /Start workflow/);
  assert.match(widgetBundle, /Save feedback/);
});
