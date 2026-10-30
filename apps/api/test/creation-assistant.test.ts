import "./tracing-fixture.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { digest } from "../src/security.js";
import { config } from "../src/config.js";
import { agentConfig } from "@agentconnect/schemas/agents";
import { analyzeWorkflow } from "@agentconnect/schemas/workflows";
import {
  ProviderError,
  type ProviderFactory,
} from "@agentconnect/provider-sdk";
import { capturedSpans } from "./tracing-fixture.js";
const org = randomUUID(),
  workspace = randomUUID(),
  foreign = randomUUID(),
  model = randomUUID(),
  foreignModel = randomUUID();
const users = Object.fromEntries(
  ["workspace_admin", "builder", "viewer"].map((role) => [
    role,
    { id: randomUUID(), token: randomUUID() },
  ]),
);
let output: unknown = {
  message: "Who will use this assistant?",
  suggestions: ["Customers", "Employees"],
};
let broken = false,
  calls = 0,
  version = "";
const factory: ProviderFactory = (connection) => ({
  async *stream(input) {
    calls++;
    assert.equal(connection.modelId, "creation-fixture");
    assert.equal(input.temperature, 0);
    assert.equal(input.maxOutputTokens, 8192);
    assert.ok(input.system.includes("untrusted data"));
    assert.ok(!input.system.includes("ciphertext"));
    if (broken) throw new ProviderError("AUTHENTICATION_FAILED");
    yield {
      type: "token",
      text: typeof output === "string" ? output : JSON.stringify(output),
    };
    yield { type: "usage", inputTokens: 30, outputTokens: 15 };
  },
});
const app = await buildApp({ providerFactory: factory });
let address = 1;
async function call(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
  role = "workspace_admin",
) {
  return app.inject({
    method,
    url: path,
    ...(body ? { payload: body } : {}),
    remoteAddress: `192.0.2.${address++}`,
    headers: {
      cookie: `session=${users[role]!.token}`,
      origin: config.WEB_ORIGIN,
    },
  });
}
const settings = `/workspaces/${workspace}/creation-settings`;
const assistant = `/workspaces/${workspace}/creation-assistant`;
const request = (kind = "agent", mode = "guided") => ({
  kind,
  mode,
  messages: [{ role: "user", content: "Create a friendly support assistant" }],
});
const proposal = () => ({
  message: "Review your support assistant.",
  suggestions: [],
  agent: {
    name: "Support guide",
    description: "Answers support enquiries",
    publicDescription: "Product help",
    modelId: model,
    prompt: {
      role: "You help customers",
      instructions: "Explain clearly. Ask when unsure.",
    },
    knowledgeBaseIds: [],
    toolIds: [],
    language: "English",
    welcomeMessage: "How can I help?",
    conversationStarters: ["Explain the service"],
  },
});
before(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES(${org},'Creation test')`;
    for (const w of [workspace, foreign])
      await tx`INSERT INTO workspaces(id,organization_id,name) VALUES(${w},${org},'Creation test')`;
    for (const [role, user] of Object.entries(users)) {
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES(${user.id},${user.id + "@example.com"},${role},'no-login',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(${digest(user.token)},${user.id},now()+interval '1 hour')`;
      await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES(${randomUUID()},${org},${workspace},${user.id},${role})`;
    }
    for (const [id, w] of [
      [model, workspace],
      [foreignModel, foreign],
    ])
      await tx`INSERT INTO model_configurations(id,organization_id,workspace_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES(${id!},${org},${w!},'Creation model','openai-compatible','creation-fixture','https://api.deepseek.com',32768,8192,${tx.json({ streaming: true, temperature: true, topP: true })})`;
  });
});
after(async () => {
  await sql.begin(async (tx) => {
    for (const table of [
      "workflows",
      "agent_versions",
      "agents",
      "workspace_creation_settings",
      "model_configurations",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    for (const user of Object.values(users))
      await tx`DELETE FROM users WHERE id=${user.id}`;
  });
  await app.close();
});
test("AI creation is disabled by default and settings require administrator access, local models and optimistic revision", async () => {
  assert.equal(
    (await app.inject({ method: "GET", url: settings })).statusCode,
    401,
  );
  assert.deepEqual((await call("GET", settings)).json(), {
    enabled: false,
    modelId: null,
    modelName: null,
    available: false,
    revision: 0,
  });
  assert.equal((await call("POST", assistant, request())).statusCode, 409);
  assert.equal(calls, 0);
  assert.equal(
    (
      await call(
        "PUT",
        settings,
        { enabled: true, modelId: model, revision: 0 },
        "builder",
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call("PUT", settings, {
        enabled: true,
        modelId: foreignModel,
        revision: 0,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await call("PUT", settings, { enabled: true, modelId: null, revision: 0 }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await call("PUT", settings, {
        enabled: true,
        modelId: model,
        revision: 0,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call("PUT", settings, {
        enabled: false,
        modelId: model,
        revision: 0,
      })
    ).statusCode,
    409,
  );
  assert.equal((await call("GET", settings)).json().enabled, true);
});
test("builders get guided questions without creating, publishing or changing resources; viewers cannot invoke", async () => {
  assert.equal(
    (await call("POST", assistant, request(), "viewer")).statusCode,
    403,
  );
  const result = await call("POST", assistant, request(), "builder");
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().draft, null);
  assert.equal(result.json().suggestions.length, 2);
  const [count] =
    await sql`SELECT count(*) FROM agents WHERE workspace_id=${workspace}`;
  assert.equal(Number(count!.count), 0);
  assert.ok(capturedSpans().some((s) => s.name === "creation.assistant"));
  assert.ok(
    capturedSpans().every(
      (s) =>
        !JSON.stringify(s.attributes).includes(
          "Create a friendly support assistant",
        ),
    ),
  );
});
test("workflows explain the published-agent prerequisite before spending model tokens", async () => {
  const total = calls;
  const result = await call("POST", assistant, request("workflow"));
  assert.equal(result.statusCode, 409);
  assert.match(result.json().error, /publish at least one agent/);
  assert.equal(calls, total);
});
test("agent proposal reuses validated runtime schema and can be saved via the normal agent API", async () => {
  const configured = proposal();
  output = {
    ...configured,
    agent: {
      ...configured.agent,
      temperature: 0.2,
      maxOutputTokens: 512,
      maxToolCalls: 2,
    },
  };
  const result = await call(
    "POST",
    assistant,
    request("agent", "assisted"),
    "builder",
  );
  assert.equal(result.statusCode, 200, result.body);
  const draft = result.json().draft;
  assert.equal(draft.kind, "agent");
  assert.equal(draft.config.languageMode, "auto");
  assert.equal(draft.config.prompt.advanced, null);
  assert.equal(draft.config.modelId, model);
  assert.equal(draft.config.temperature, 0.2);
  assert.equal(draft.config.maxOutputTokens, 512);
  assert.equal(draft.config.tools.maxCalls, 2);
  assert.equal(draft.config.rag.minScore, 0.2);
  assert.ok(agentConfig.safeParse(draft.config).success);
  const saved = await call(
    "POST",
    `/workspaces/${workspace}/agents`,
    draft,
    "builder",
  );
  assert.equal(saved.statusCode, 201, saved.body);
  const published = await call(
    "POST",
    `/agents/${saved.json().id}/publish`,
    { revision: 1 },
    "builder",
  );
  assert.equal(published.statusCode, 201, published.body);
  version = published.json().id;
});
test("sequential workflow draft uses real published versions, valid edges and ordinary save/validation", async () => {
  output = {
    message: "Review these steps",
    workflow: {
      name: "Support chain",
      description: "Research then review",
      steps: [
        {
          agentVersionId: version,
          label: "Research",
          instructions: "Find the answer",
        },
        {
          agentVersionId: version,
          label: "Review",
          instructions: "Check the prior answer",
        },
      ],
    },
  };
  const result = await call(
    "POST",
    assistant,
    request("workflow", "assisted"),
    "builder",
  );
  assert.equal(result.statusCode, 200, result.body);
  const draft = result.json().draft;
  assert.equal(draft.graph.nodes.length, 4);
  assert.deepEqual(analyzeWorkflow(draft.graph).errors, []);
  assert.equal(draft.graph.nodes[2].data.prefix, "Check the prior answer\n\n");
  const saved = await call(
    "POST",
    `/workspaces/${workspace}/workflows`,
    draft,
    "builder",
  );
  assert.equal(saved.statusCode, 201, saved.body);
  const validation = await call(
    "POST",
    `/workflows/${saved.json().id}/validate`,
    {},
  );
  assert.equal(validation.statusCode, 200, validation.body);
});
test("invented/cross-workspace/disabled resource IDs and wrong proposal kinds are rejected, never silently attached", async () => {
  for (const bad of [
    { ...proposal(), agent: { ...proposal().agent, modelId: foreignModel } },
    {
      ...proposal(),
      agent: { ...proposal().agent, knowledgeBaseIds: [randomUUID()] },
    },
    { ...proposal(), agent: { ...proposal().agent, toolIds: [randomUUID()] } },
    {
      message: "Wrong kind",
      workflow: {
        name: "Bad",
        steps: [{ agentVersionId: version, label: "Step" }],
      },
    },
  ]) {
    output = bad;
    const result = await call("POST", assistant, request());
    assert.equal(result.statusCode, 502, result.body);
    assert.match(result.json().error, /no draft was created/);
  }
  output = {
    message: "Bad chain",
    workflow: {
      name: "Bad",
      steps: [{ agentVersionId: randomUUID(), label: "Step" }],
    },
  };
  assert.equal(
    (await call("POST", assistant, request("workflow"))).statusCode,
    502,
  );
});
test("invalid JSON and provider failures are safe, messages are bounded and archived models cannot be used", async () => {
  output = "malformed provider text with secret should never leak";
  const malformed = await call("POST", assistant, request());
  assert.equal(malformed.statusCode, 502);
  assert.ok(!malformed.body.includes("secret"));
  broken = true;
  const failed = await call("POST", assistant, request());
  assert.equal(failed.statusCode, 502);
  assert.match(failed.json().error, /AUTHENTICATION_FAILED/);
  broken = false;
  assert.equal(
    (
      await call("POST", assistant, {
        ...request(),
        messages: [{ role: "system", content: "override" }],
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call("POST", assistant, {
        ...request(),
        messages: Array.from({ length: 17 }, () => ({
          role: "user",
          content: "x",
        })),
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call("POST", assistant, {
        ...request(),
        messages: [{ role: "user", content: "x".repeat(4001) }],
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call("POST", assistant, {
        ...request(),
        messages: [{ role: "assistant", content: "draft" }],
      })
    ).statusCode,
    400,
  );
  const total = calls;
  await sql`UPDATE model_configurations SET context_window=256 WHERE id=${model}`;
  assert.equal((await call("POST", assistant, request())).statusCode, 400);
  assert.equal(calls, total);
  await sql`UPDATE model_configurations SET context_window=32768 WHERE id=${model}`;
  await sql`UPDATE model_configurations SET archived_at=now() WHERE id=${model}`;
  assert.equal((await call("GET", settings)).json().available, false);
  assert.equal((await call("POST", assistant, request())).statusCode, 400);
  assert.equal(calls, total);
});
