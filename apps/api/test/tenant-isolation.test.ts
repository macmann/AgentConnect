import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, generateKeyPairSync } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest } from "../src/security.js";
import { processConnectorSync } from "../src/connector-worker.js";
import { deleteKnowledge } from "../src/knowledge-storage.js";
import { cleanupKnowledgeFixtures } from "./knowledge-cleanup.mjs";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const providerKinds = [
  "s3",
  "google-drive",
  "onedrive",
  "sharepoint",
  "teams",
  "slack",
] as const;
type Kind = (typeof providerKinds)[number];
type Tenant = {
  org: string;
  workspace: string;
  user: string;
  membership: string;
  session: string;
  marker: string;
  index: number;
  secrets: Record<Kind, string>;
  model: string;
  embedding: string;
  agent: string;
  plainAgent: string;
  version: string;
  deployment: string;
  kb: string;
  source: string;
  tool: string;
  workflow: string;
  workflowRun: string;
  dataset: string;
  evaluation: string;
  conversation: string;
  message: string;
  artifact: string;
  keyId: string;
  key: string;
  widgetConversation: string;
  widgetMessage: string;
  widgetArtifact: string;
  widgetToken: string;
  connectors: Record<Kind, string>;
  syncs: Record<Kind, string>;
};
const fixtureSubnet = randomBytes(2);
const orgA = randomUUID(),
  orgB = randomUUID();
const tenants = [orgA, orgA, orgB].map(
  (org, index) =>
    ({
      org,
      index,
      workspace: randomUUID(),
      user: randomUUID(),
      membership: randomUUID(),
      session: "session=" + randomUUID(),
      marker: "isolation-private-" + randomUUID(),
      secrets: {},
      connectors: {},
      syncs: {},
    }) as Tenant,
);
const original = {
  allowed: config.CONNECTOR_ALLOWED_HOSTS,
  private: config.CONNECTOR_PRIVATE_HOSTS,
  tools: config.TOOL_ALLOWED_HOSTS,
};
config.CONNECTOR_ALLOWED_HOSTS =
  "www.googleapis.com,oauth2.googleapis.com,graph.microsoft.com,login.microsoftonline.com,slack.com";
config.CONNECTOR_PRIVATE_HOSTS = new URL(config.S3_ENDPOINT).host;
config.TOOL_ALLOWED_HOSTS = "tools.example.com";
let providerCalls = 0,
  discoveryCalls = 0;
const envelope = {
  version: 1,
  message: "fixture-private-response",
  blocks: [
    {
      type: "file",
      title: "Private fixture",
      format: "txt",
      content: "fixture-private-artifact",
    },
    {
      type: "action",
      id: "accept",
      title: "Accept",
      label: "Accept",
      action: "data.collect",
      confirmation: "confirm",
      values: { choice: "fixture-private-choice" },
    },
  ],
};
const app = await buildApp({
  providerFactory: () => ({
    async *stream() {
      providerCalls++;
      yield { type: "token", text: JSON.stringify(envelope) };
      yield { type: "usage", inputTokens: 1, outputTokens: 1 };
    },
  }),
  sharePointClientFactory: () => {
    discoveryCalls++;
    throw new Error("Unauthorized discovery reached provider");
  },
});
async function request(
  t: Tenant | undefined,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
  extra: { bearer?: string; origin?: string | null; session?: string } = {},
) {
  return app.inject({
    method,
    url,
    remoteAddress: `127.${fixtureSubnet[0]}.${fixtureSubnet[1]}.${(t?.index ?? 3) + 1}`,
    headers: {
      ...(extra.origin === null
        ? {}
        : { origin: extra.origin ?? config.WEB_ORIGIN }),
      ...((extra.session ?? t?.session)
        ? { cookie: extra.session ?? t!.session }
        : {}),
      ...(extra.bearer ? { authorization: `Bearer ${extra.bearer}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function create(t: Tenant, path: string, body: unknown, expected = 201) {
  const result = await request(t, "POST", path, body);
  assert.equal(result.statusCode, expected, result.body);
  return result.json().id as string;
}
function events(body: string) {
  return body
    .split("\n\n")
    .filter((part) => part.startsWith("event:"))
    .map((part) => ({
      event: part.split("\n")[0]!.slice(7),
      data: JSON.parse(part.split("\n")[1]!.slice(6)),
    }));
}
function channelSelection(kind: Kind) {
  switch (kind) {
    case "s3":
      return {
        endpoint: config.S3_ENDPOINT,
        region: "us-east-1",
        bucket: "fixture-isolation",
        prefix: "approved/",
        maxObjects: 10,
      };
    case "google-drive":
      return { folderId: "fixture-folder", maxObjects: 10 };
    case "onedrive":
      return {
        driveId: "b!fixture",
        folderId: "fixture-folder",
        maxObjects: 10,
      };
    case "sharepoint":
      return {
        siteId: `fixture.sharepoint.com,${randomUUID()},${randomUUID()}`,
        driveId: "b!fixture",
        folderId: "fixture-folder",
        maxObjects: 10,
      };
    case "teams":
      return {
        teamId: randomUUID(),
        channelId: "19:fixture@thread.tacv2",
        maxObjects: 10,
      };
    case "slack":
      return { teamId: "TFIXTURE", channelId: "CFIXTURE", maxObjects: 10 };
  }
}
const graph = {
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
      position: { x: 100, y: 0 },
      data: { label: "Output" },
    },
  ],
  edges: [{ id: "edge", source: "input", target: "output" }],
};
before(async () => {
  await sql.begin(async (tx) => {
    for (const org of [orgA, orgB])
      await tx`INSERT INTO organizations(id,name) VALUES (${org},'Isolation fixture')`;
    for (const t of tenants) {
      await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${t.workspace},${t.org},${t.marker})`;
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${t.user},${t.user + "@example.com"},'Scoped administrator','unused-test-password',now())`;
      await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${t.membership},${t.org},${t.workspace},${t.user},'workspace_admin')`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(t.session.slice(8))},${t.user},now()+interval '1 hour')`;
    }
  });
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  for (const t of tenants) {
    const base = `/workspaces/${t.workspace}`;
    for (const kind of providerKinds) {
      const value =
        kind === "s3"
          ? { accessKeyId: "fixture", secretAccessKey: "fixture-secret" }
          : kind === "google-drive"
            ? { client_email: "fixture@example.com", private_key: privateKey }
            : kind === "slack"
              ? { token: "xoxp-fixture-only" }
              : {
                  tenantId: randomUUID(),
                  clientId: randomUUID(),
                  clientSecret: "fixture-client-secret",
                };
      await create(t, base + "/secrets", {
        name: kind.toUpperCase().replaceAll("-", "_") + "_FIXTURE",
        value: JSON.stringify(value),
      });
      const list = (await request(t, "GET", base + "/secrets")).json();
      t.secrets[kind] = list.find(
        (s: { name: string }) =>
          s.name === kind.toUpperCase().replaceAll("-", "_") + "_FIXTURE",
      ).id;
    }
    t.model = await create(t, base + "/models", {
      name: t.marker,
      provider: "openai-compatible",
      modelId: "fixture",
      baseUrl: "https://api.openai.com/v1",
    });
    t.embedding = await create(t, base + "/embedding-models", {
      name: t.marker,
      provider: "openai-compatible",
      modelId: "fixture",
      baseUrl: "https://api.openai.com/v1",
      dimensions: 3,
    });
    t.kb = await create(t, base + "/knowledge-bases", {
      name: t.marker,
      embeddingModelId: t.embedding,
    });
    t.source = await create(
      t,
      `/knowledge-bases/${t.kb}/text`,
      { title: t.marker, text: t.marker },
      202,
    );
    t.tool = await create(t, base + "/tools", {
      name: t.marker,
      description: t.marker,
      readOnlyAcknowledged: true,
      config: { kind: "http", url: "https://tools.example.com/read" },
    });
    t.agent = await create(t, base + "/agents", {
      name: t.marker,
      config: {
        modelId: t.model,
        generative: {
          enabled: true,
          allowedBlocks: ["file", "action"],
          allowPublicForms: true,
        },
      },
    });
    t.plainAgent = await create(t, base + "/agents", {
      name: t.marker + "-plain",
      config: { modelId: t.model },
    });
    const chat = await request(t, "POST", `/agents/${t.agent}/chat`, {
      message: "Private test",
    });
    assert.equal(chat.statusCode, 200, chat.body);
    const stream = events(chat.body),
      ui = stream.find((e) => e.event === "ui");
    assert.ok(ui, chat.body);
    t.conversation = stream[0]!.data.conversationId;
    t.message = ui.data.messageId;
    t.artifact = ui.data.blocks.find(
      (b: { type: string }) => b.type === "file",
    ).artifactId;
    t.version = await create(t, `/agents/${t.agent}/publish`, { revision: 1 });
    t.deployment = await create(t, `/agents/${t.agent}/deployments`, {
      name: t.marker,
      versionId: t.version,
    });
    const widget = await request(t, "PUT", base + `/channels/${t.deployment}`, {
      enabled: true,
      access: "restricted",
      allowedOrigins: [config.WEB_ORIGIN, "https://second.example"],
    });
    assert.equal(widget.statusCode, 200, widget.body);
    const publicChat = await request(
      undefined,
      "POST",
      `/public/widgets/${t.deployment}/chat`,
      { message: "Widget test" },
    );
    assert.equal(publicChat.statusCode, 200, publicChat.body);
    const publicStream = events(publicChat.body),
      publicUi = publicStream.find((e) => e.event === "ui");
    assert.ok(publicUi, publicChat.body);
    t.widgetConversation = publicStream[0]!.data.conversationId;
    t.widgetToken = publicStream[0]!.data.guestToken;
    t.widgetMessage = publicUi.data.messageId;
    t.widgetArtifact = publicUi.data.blocks.find(
      (b: { type: string }) => b.type === "file",
    ).artifactId;
    const key = await request(t, "POST", base + "/operations/api-keys", {
      label: t.marker,
      agentId: t.plainAgent,
    });
    assert.equal(key.statusCode, 201, key.body);
    t.key = key.json().key;
    t.keyId = key.json().id;
    t.workflow = await create(t, base + "/workflows", {
      name: t.marker,
      graph,
    });
    t.workflowRun = await create(
      t,
      `/workflows/${t.workflow}/runs`,
      { input: t.marker, revision: 1 },
      202,
    );
    t.dataset = await create(t, base + "/datasets", {
      name: t.marker,
      examples: [
        { input: t.marker, expectedBehavior: "Answer", contains: ["fixture"] },
      ],
    });
    t.evaluation = await create(
      t,
      base + "/evaluations",
      {
        agentId: t.plainAgent,
        datasetId: t.dataset,
        revision: 1,
        evaluator: { mode: "deterministic" },
      },
      202,
    );
    for (const kind of providerKinds) {
      t.connectors[kind] = await create(t, base + "/connectors", {
        name: t.marker + "-" + kind,
        kind,
        secretId: t.secrets[kind],
        knowledgeBaseId: t.kb,
        selection: channelSelection(kind),
      });
      const syncId = randomUUID();
      t.syncs[kind] = syncId;
      await sql`INSERT INTO connector_syncs(id,connector_id,organization_id,workspace_id,requested_by,connector_revision,status,counts) VALUES (${syncId},${t.connectors[kind]},${t.org},${t.workspace},${t.user},1,'completed',${sql.json({ listed: 1 })})`;
    }
  }
});
after(async () => {
  try {
    const keys =
      await sql`SELECT storage_key FROM generated_artifacts WHERE organization_id IN ${sql([orgA, orgB])}`;
    for (const key of keys) await deleteKnowledge(key.storage_key);
    for (const org of [orgA, orgB]) await cleanupKnowledgeFixtures(sql, org);
    await sql.begin(async (tx) => {
      for (const table of [
        "connector_items",
        "connector_syncs",
        "enterprise_connectors",
        "evaluation_results",
        "evaluation_runs",
        "agent_quality_gates",
        "evaluation_datasets",
        "workflow_approvals",
        "workflow_node_runs",
        "tool_executions",
        "workflow_runs",
        "workflow_versions",
        "workflows",
        "collected_submissions",
        "generated_artifacts",
        "conversation_reviews",
        "handoff_events",
        "webhook_deliveries",
        "workspace_webhooks",
        "messages",
        "agent_runs",
        "conversations",
        "workspace_api_keys",
        "deployments",
        "agent_versions",
        "agents",
        "model_prices",
        "tools",
        "mcp_connectors",
        "knowledge_chunks",
        "knowledge_documents",
        "knowledge_jobs",
        "knowledge_sources",
        "knowledge_bases",
        "embedding_models",
        "model_configurations",
        "audit_events",
        "secrets",
        "memberships",
        "workspaces",
      ])
        await tx`DELETE FROM ${tx(table)} WHERE organization_id IN ${tx([orgA, orgB])}`;
      await tx`DELETE FROM organizations WHERE id IN ${tx([orgA, orgB])}`;
      await tx`DELETE FROM users WHERE id IN ${tx(tenants.map((t) => t.user))}`;
    });
  } finally {
    config.CONNECTOR_ALLOWED_HOSTS = original.allowed;
    config.CONNECTOR_PRIVATE_HOSTS = original.private;
    config.TOOL_ALLOWED_HOSTS = original.tools;
    await app.close();
  }
});
function deny(
  result: { statusCode: number; body: string },
  allowed: number[],
  label: string,
) {
  assert.ok(
    allowed.includes(result.statusCode),
    `${label}: ${result.statusCode} ${result.body}`,
  );
  for (const t of tenants)
    assert.ok(
      !result.body.includes(t.marker),
      `${label} leaked a private marker`,
    );
  assert.ok(
    !result.body.includes("fixture-private-"),
    `${label} leaked content`,
  );
}
const collections = [
  "retention",
  "agents",
  "models",
  "secrets",
  "embedding-models",
  "knowledge-bases",
  "tools",
  "mcp-connectors",
  "workflows",
  "workflow-agents",
  "datasets",
  "quality-models",
  "evaluations",
  "quality-gates",
  "connectors",
  "conversations",
  "collected-data",
  "handoffs",
  "channels",
  "members",
  "audit",
  "operations/audit",
  "operations/analytics",
  "operations/conversations",
  "operations/prices",
  "operations/api-keys",
  "operations/webhooks",
  "operations/webhook-deliveries",
  "operations/deployments",
];
test("workspace collections are isolated between sibling workspaces and unrelated organizations", async () => {
  for (const victim of tenants)
    for (const suffix of collections) {
      const path = `/workspaces/${victim.workspace}/${suffix}`;
      const own = await request(victim, "GET", path);
      assert.equal(own.statusCode, 200, `${path}: ${own.body}`);
      for (const other of tenants.filter((t) => t !== victim))
        assert.ok(
          !own.body.includes(other.marker),
          `${path} returned another workspace's data`,
        );
      for (const other of tenants.filter((t) => t !== victim))
        deny(await request(other, "GET", path), [403], path);
    }
});
test("global resource details, histories and signed artifact grants reject another workspace administrator", async () => {
  for (const victim of tenants) {
    const paths = [
      `/agents/${victim.agent}`,
      `/agents/${victim.agent}/versions`,
      `/agents/${victim.agent}/deployments`,
      `/knowledge-bases/${victim.kb}`,
      `/knowledge-bases/${victim.kb}/sources`,
      `/knowledge-bases/${victim.kb}/sources/${victim.source}/chunks`,
      `/knowledge-bases/${victim.kb}/qa/export`,
      `/tools/${victim.tool}`,
      `/workflows/${victim.workflow}`,
      `/workflows/${victim.workflow}/versions`,
      `/workflows/${victim.workflow}/runs`,
      `/workflow-runs/${victim.workflowRun}`,
      `/conversations/${victim.conversation}/messages`,
      `/conversations/${victim.conversation}/tool-executions`,
      `/conversations/${victim.conversation}/reviews`,
      `/conversations/${victim.conversation}/handoff`,
      `/artifacts/${victim.artifact}/grant`,
    ];
    for (const path of paths) {
      const own = await request(victim, "GET", path);
      assert.equal(own.statusCode, 200, `${path}: ${own.body}`);
      for (const other of tenants.filter((t) => t !== victim))
        deny(await request(other, "GET", path), [403], path);
    }
  }
});
test("all six connector providers bind sync history, mutations and credentials to the selected workspace", async () => {
  const caller = tenants[0]!;
  for (const victim of tenants.slice(1))
    for (const kind of providerKinds) {
      const local = `/workspaces/${caller.workspace}/connectors/${victim.connectors[kind]}`,
        foreign = `/workspaces/${victim.workspace}/connectors/${victim.connectors[kind]}`;
      deny(
        await request(caller, "GET", local + "/syncs"),
        [404],
        kind + " history",
      );
      deny(
        await request(caller, "GET", foreign + "/syncs"),
        [403],
        kind + " foreign history",
      );
      deny(
        await request(caller, "POST", local + "/sync"),
        [404],
        kind + " sync",
      );
      deny(
        await request(
          caller,
          "POST",
          local + `/syncs/${victim.syncs[kind]}/cancel`,
        ),
        [404],
        kind + " cancellation",
      );
      deny(await request(caller, "DELETE", local), [404], kind + " delete");
      deny(
        await request(
          caller,
          "POST",
          `/workspaces/${caller.workspace}/connectors`,
          {
            name: "Cross credential",
            kind,
            secretId: victim.secrets[kind],
            knowledgeBaseId: caller.kb,
            selection: channelSelection(kind),
          },
        ),
        [409],
        kind + " foreign secret",
      );
      deny(
        await request(
          caller,
          "POST",
          `/workspaces/${caller.workspace}/connectors`,
          {
            name: "Cross KB",
            kind,
            secretId: caller.secrets[kind],
            knowledgeBaseId: victim.kb,
            selection: channelSelection(kind),
          },
        ),
        [404],
        kind + " foreign KB",
      );
      const [state] =
        await sql`SELECT revision,enabled,archived_at FROM enterprise_connectors WHERE id=${victim.connectors[kind]}`;
      assert.equal(state!.revision, 1);
      assert.equal(state!.enabled, true);
      assert.equal(state!.archived_at, null);
    }
  deny(
    await request(
      caller,
      "POST",
      `/workspaces/${caller.workspace}/connectors/sharepoint/discover`,
      {
        action: "site",
        secretId: tenants[2]!.secrets.sharepoint,
        siteUrl: "https://fixture.sharepoint.com/sites/Private",
      },
    ),
    [409],
    "SharePoint discovery credential",
  );
  assert.equal(discoveryCalls, 0);
});
test("nested resources and imported message references cannot be swapped across workspaces", async () => {
  const caller = tenants[0]!,
    victim = tenants[2]!,
    base = `/workspaces/${caller.workspace}`;
  const attempts: [
    "GET" | "POST" | "PUT" | "DELETE",
    string,
    unknown,
    number[],
  ][] = [
    ["GET", base + `/evaluations/${victim.evaluation}`, undefined, [404]],
    [
      "POST",
      base + `/evaluations/${victim.evaluation}/cancel`,
      undefined,
      [409],
    ],
    ["DELETE", base + `/datasets/${victim.dataset}`, undefined, [404]],
    [
      "POST",
      base + `/datasets/${caller.dataset}/import-messages`,
      { revision: 1, messageIds: [victim.message] },
      [404],
    ],
    [
      "POST",
      base + "/evaluations",
      {
        agentId: victim.plainAgent,
        datasetId: caller.dataset,
        revision: 1,
        evaluator: { mode: "deterministic" },
      },
      [404],
    ],
    [
      "POST",
      base + "/operations/api-keys",
      { label: "Cross agent", agentId: victim.agent },
      [400],
    ],
    ["DELETE", base + `/operations/api-keys/${victim.keyId}`, undefined, [404]],
    ["PUT", base + `/channels/${victim.deployment}`, { enabled: false }, [404]],
    [
      "DELETE",
      `/agents/${caller.agent}/deployments/${victim.deployment}`,
      undefined,
      [404],
    ],
    [
      "POST",
      `/agents/${caller.agent}/rollback/${victim.version}`,
      { revision: 1 },
      [404],
    ],
    [
      "DELETE",
      `/knowledge-bases/${caller.kb}/sources/${victim.source}`,
      undefined,
      [404],
    ],
    [
      "GET",
      `/knowledge-bases/${caller.kb}/sources/${victim.source}/chunks`,
      undefined,
      [404],
    ],
    [
      "PUT",
      base + `/secrets/${victim.secrets.s3}`,
      { value: "overwrite-attempt" },
      [404],
    ],
    [
      "POST",
      `/messages/${victim.message}/reviews`,
      { rating: "dislike" },
      [403],
    ],
    [
      "POST",
      `/messages/${victim.message}/actions/accept`,
      { confirmed: true, values: {} },
      [403],
    ],
  ];
  const calls = providerCalls;
  for (const [method, path, body, statuses] of attempts)
    deny(await request(caller, method, path, body), statuses, path);
  assert.equal(providerCalls, calls);
  const [dataset] =
    await sql`SELECT revision,examples FROM evaluation_datasets WHERE id=${caller.dataset}`;
  assert.equal(dataset!.revision, 1);
  assert.equal(dataset!.examples.length, 1);
  const [deployment] =
    await sql`SELECT enabled FROM deployments WHERE id=${victim.deployment}`;
  assert.equal(deployment!.enabled, true);
});
test("model, embedding and agent attachment references reject foreign credentials and resources", async () => {
  const caller = tenants[0]!,
    victim = tenants[1]!,
    base = `/workspaces/${caller.workspace}`;
  const inputs: [string, unknown, number[]][] = [
    [
      "/models",
      {
        name: "Cross credential",
        provider: "openai-compatible",
        modelId: "fixture",
        baseUrl: "https://api.openai.com/v1",
        secretId: victim.secrets.s3,
      },
      [400],
    ],
    [
      "/embedding-models",
      {
        name: "Cross credential",
        provider: "openai-compatible",
        modelId: "fixture",
        baseUrl: "https://api.openai.com/v1",
        secretId: victim.secrets.s3,
        dimensions: 3,
      },
      [400],
    ],
    [
      "/knowledge-bases",
      { name: "Cross embedding", embeddingModelId: victim.embedding },
      [400],
    ],
    [
      "/agents",
      { name: "Cross model", config: { modelId: victim.model } },
      [400],
    ],
    [
      "/agents",
      {
        name: "Cross knowledge",
        config: {
          modelId: caller.model,
          rag: { knowledgeBaseIds: [victim.kb] },
        },
      },
      [404, 400],
    ],
    [
      "/agents",
      {
        name: "Cross tool",
        config: { modelId: caller.model, tools: { toolIds: [victim.tool] } },
      },
      [404, 400],
    ],
  ];
  for (const [path, body, statuses] of inputs)
    deny(await request(caller, "POST", base + path, body), statuses, path);
});
test("execution keys remain agent-scoped and cannot replace a session for administrative reads", async () => {
  const caller = tenants[0]!,
    victim = tenants[2]!;
  const calls = providerCalls;
  deny(
    await request(
      undefined,
      "POST",
      `/agents/${victim.plainAgent}/chat`,
      { message: "Cross key" },
      { bearer: caller.key, origin: null },
    ),
    [401],
    "Foreign agent execution",
  );
  deny(
    await request(
      undefined,
      "GET",
      `/workspaces/${caller.workspace}/operations/api-keys`,
      undefined,
      { bearer: caller.key },
    ),
    [401],
    "Key administration",
  );
  assert.equal(providerCalls, calls);
  const own = await request(
    undefined,
    "POST",
    `/agents/${caller.plainAgent}/chat`,
    { message: "Own scoped key" },
    { bearer: caller.key, origin: null },
  );
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(events(own.body).at(-1)!.event, "done");
});
test("widget conversation tokens cannot cross deployments or origins for chat and handoff", async () => {
  const t = tenants[0]!,
    other = tenants[2]!,
    calls = providerCalls;
  for (const target of [other.deployment, t.deployment]) {
    const extra = {
      bearer: t.widgetToken,
      origin:
        target === t.deployment ? "https://second.example" : config.WEB_ORIGIN,
    };
    deny(
      await request(
        undefined,
        "POST",
        `/public/widgets/${target}/chat`,
        { conversationId: t.widgetConversation, message: "Cross binding" },
        extra,
      ),
      [403, 404],
      "Widget chat binding",
    );
    deny(
      await request(
        undefined,
        "GET",
        `/public/widgets/${target}/conversations/${t.widgetConversation}/handoff`,
        undefined,
        extra,
      ),
      [403, 404],
      "Widget handoff binding",
    );
  }
  assert.equal(providerCalls, calls);
});
test("widget artifact grants enforce the conversation origin and current widget policy", async () => {
  const t = tenants[0]!,
    path = `/artifacts/${t.widgetArtifact}/grant`;
  const own = await request(undefined, "GET", path, undefined, {
    bearer: t.widgetToken,
  });
  assert.equal(own.statusCode, 200, own.body);
  for (const origin of [
    null,
    "https://unapproved.example",
    "https://second.example",
  ])
    deny(
      await request(undefined, "GET", path, undefined, {
        bearer: t.widgetToken,
        origin,
      }),
      [403],
      "Widget grant origin",
    );
  await sql`UPDATE deployments SET widget_settings=jsonb_set(widget_settings,'{enabled}','false'::jsonb) WHERE id=${t.deployment}`;
  try {
    deny(
      await request(undefined, "GET", path, undefined, {
        bearer: t.widgetToken,
      }),
      [403],
      "Disabled widget grant",
    );
    deny(
      await request(
        undefined,
        "POST",
        `/messages/${t.widgetMessage}/actions/accept`,
        { confirmed: true, values: {} },
        { bearer: t.widgetToken },
      ),
      [403],
      "Disabled widget action",
    );
    const [submissions] =
      await sql`SELECT count(*)::int AS count FROM collected_submissions WHERE message_id=${t.widgetMessage}`;
    assert.equal(submissions!.count, 0);
  } finally {
    await sql`UPDATE deployments SET widget_settings=jsonb_set(widget_settings,'{enabled}','true'::jsonb) WHERE id=${t.deployment}`;
  }
});
test("membership revocation immediately blocks existing sessions and API keys and queued connector work", async () => {
  const t = tenants[1]!,
    base = `/workspaces/${t.workspace}`;
  const queued = await request(
    t,
    "POST",
    base + `/connectors/${t.connectors.slack}/sync`,
  );
  assert.equal(queued.statusCode, 202, queued.body);
  const calls = providerCalls;
  await sql`DELETE FROM memberships WHERE id=${t.membership}`;
  try {
    deny(await request(t, "GET", base + "/agents"), [403], "Revoked session");
    deny(
      await request(t, "GET", `/conversations/${t.conversation}/messages`),
      [403],
      "Revoked history",
    );
    deny(
      await request(t, "GET", `/artifacts/${t.artifact}/grant`),
      [403],
      "Revoked grant",
    );
    deny(
      await request(
        undefined,
        "POST",
        `/agents/${t.plainAgent}/chat`,
        { message: "Revoked key" },
        { bearer: t.key, origin: null },
      ),
      [403],
      "Revoked key issuer",
    );
    let adapters = 0;
    await processConnectorSync(async () => {
      adapters++;
      throw new Error("Revoked work reached adapter");
    });
    assert.equal(adapters, 0);
    assert.equal(providerCalls, calls);
    const [sync] =
      await sql`SELECT status,error_code FROM connector_syncs WHERE id=${queued.json().id}`;
    assert.equal(sync!.status, "failed");
  } finally {
    await sql`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${t.membership},${t.org},${t.workspace},${t.user},'workspace_admin')`;
  }
});

test("signed artifact download capabilities bind the artifact ID, signature and expiry", async () => {
  const t = tenants[0]!,
    other = tenants[2]!;
  const grant = await request(t, "GET", `/artifacts/${t.artifact}/grant`);
  assert.equal(grant.statusCode, 200, grant.body);
  const path = grant.json().path as string;
  const success = await request(undefined, "GET", path);
  assert.equal(success.statusCode, 200);
  assert.equal(success.body, "fixture-private-artifact");
  const url = new URL(path, "http://fixture");
  url.searchParams.set("signature", "0".repeat(64));
  deny(
    await request(undefined, "GET", url.pathname + url.search),
    [403],
    "Tampered signature",
  );
  const expired = new URL(path, "http://fixture");
  expired.searchParams.set(
    "expires",
    String(Math.floor(Date.now() / 1000) - 1),
  );
  deny(
    await request(undefined, "GET", expired.pathname + expired.search),
    [403],
    "Expired capability",
  );
  deny(
    await request(undefined, "GET", path.replace(t.artifact, other.artifact)),
    [403],
    "Cross artifact capability",
  );
});
test("composite database constraints reject foreign connector credentials and knowledge bases", async () => {
  const t = tenants[0]!,
    other = tenants[2]!;
  for (const [kb, secret] of [
    [t.kb, other.secrets.slack],
    [other.kb, t.secrets.slack],
  ]) {
    const cid = randomUUID();
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`INSERT INTO enterprise_connectors(id,organization_id,workspace_id,name,kind,knowledge_base_id,secret_id,selection,created_by,updated_by) VALUES (${cid},${t.org},${t.workspace},'Invalid tenant reference','slack',${kb!},${secret!},${tx.json(channelSelection("slack"))},${t.user},${t.user})`;
      }),
      (error: unknown) =>
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23503",
    );
    assert.equal(
      (await sql`SELECT id FROM enterprise_connectors WHERE id=${cid}`).length,
      0,
    );
  }
});

test("organization owners inherit only their organization's workspace access", async () => {
  const owner = randomUUID(),
    raw = randomUUID(),
    membership = randomUUID(),
    session = "session=" + raw;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${owner},${owner + "@example.com"},'Inherited owner','unused',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(raw)},${owner},now()+interval '1 hour')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${membership},${orgA},${owner},'owner')`;
  });
  try {
    for (const t of tenants) {
      for (const path of [
        `/workspaces/${t.workspace}/agents`,
        `/agents/${t.agent}`,
        `/knowledge-bases/${t.kb}`,
      ]) {
        const result = await request(t, "GET", path, undefined, { session });
        if (t.org === orgA) assert.equal(result.statusCode, 200, result.body);
        else deny(result, [403], "Inherited owner outside organization");
      }
    }
  } finally {
    await sql`DELETE FROM memberships WHERE id=${membership}`;
    await sql`DELETE FROM users WHERE id=${owner}`;
  }
});

test("role downgrade, session expiry and key expiry/revocation apply before provider execution", async () => {
  const t = tenants[0]!,
    base = `/workspaces/${t.workspace}`,
    calls = providerCalls;
  await sql`UPDATE memberships SET role='viewer' WHERE id=${t.membership}`;
  try {
    deny(
      await request(t, "GET", base + "/secrets"),
      [403],
      "Downgraded secret access",
    );
    deny(
      await request(t, "DELETE", base + `/connectors/${t.connectors.teams}`),
      [403],
      "Downgraded connector change",
    );
    deny(
      await request(
        undefined,
        "POST",
        `/agents/${t.plainAgent}/chat`,
        { message: "Downgraded issuer" },
        { bearer: t.key, origin: null },
      ),
      [403],
      "Downgraded key issuer",
    );
  } finally {
    await sql`UPDATE memberships SET role='workspace_admin' WHERE id=${t.membership}`;
  }
  const sid = digest(t.session.slice(8));
  await sql`UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE id_hash=${sid}`;
  try {
    deny(
      await request(t, "GET", `/agents/${t.agent}`),
      [401],
      "Expired session",
    );
  } finally {
    await sql`UPDATE sessions SET expires_at=now()+interval '1 hour' WHERE id_hash=${sid}`;
  }
  await sql`UPDATE workspace_api_keys SET expires_at=now()-interval '1 minute' WHERE id=${t.keyId}`;
  try {
    deny(
      await request(
        undefined,
        "POST",
        `/agents/${t.plainAgent}/chat`,
        { message: "Expired key" },
        { bearer: t.key, origin: null },
      ),
      [401],
      "Expired key",
    );
  } finally {
    await sql`UPDATE workspace_api_keys SET expires_at=now()+interval '1 hour' WHERE id=${t.keyId}`;
  }
  await sql`UPDATE workspace_api_keys SET revoked_at=now() WHERE id=${t.keyId}`;
  try {
    deny(
      await request(
        undefined,
        "POST",
        `/agents/${t.plainAgent}/chat`,
        { message: "Revoked key" },
        { bearer: t.key, origin: null },
      ),
      [401],
      "Revoked key",
    );
  } finally {
    await sql`UPDATE workspace_api_keys SET revoked_at=NULL WHERE id=${t.keyId}`;
  }
  assert.equal(providerCalls, calls);
  const [connector] =
    await sql`SELECT archived_at,revision FROM enterprise_connectors WHERE id=${t.connectors.teams}`;
  assert.equal(connector!.archived_at, null);
  assert.equal(connector!.revision, 1);
});
