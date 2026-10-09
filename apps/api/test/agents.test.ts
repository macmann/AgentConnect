import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { recoverInterruptedRuns } from "../src/agents.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { hashPassword, digest } from "../src/security.js";
import { agentConfig } from "@agentconnect/schemas/agents";
import {
  ProviderError,
  type ProviderFactory,
  type ModelConnection,
} from "@agentconnect/provider-sdk";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production mode");
const workspace = randomUUID(),
  org = randomUUID(),
  ownerId = randomUUID(),
  viewerId = randomUUID(),
  outsiderId = randomUUID();
const sessions = { owner: "", viewer: "", outsider: "" };
let modelId = "",
  agentId = "",
  versionId = "",
  deploymentId = "";
let lastConnection: ModelConnection | undefined;
let fail = false;
const factory: ProviderFactory = (connection) => {
  lastConnection = connection;
  return {
    async *stream() {
      if (fail) throw new ProviderError("RATE_LIMITED");
      yield { type: "token", text: "Fixture answer" };
      yield { type: "usage", inputTokens: 5, outputTokens: 2 };
    },
  };
};
const app = await buildApp({ providerFactory: factory });
async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
  session = sessions.owner,
  authorization?: string,
) {
  return app.inject({
    method,
    url,
    headers: {
      origin: config.WEB_ORIGIN,
      ...(session ? { cookie: session } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...(authorization ? { authorization } : {}),
    },
    payload: body ? JSON.stringify(body) : undefined,
  });
}
function events(body: string) {
  return body
    .split("\n\n")
    .filter((s) => s.startsWith("event:"))
    .map((s) => ({
      event: s.split("\n")[0]!.slice(7),
      data: JSON.parse(s.split("\n")[1]!.slice(6)),
    }));
}
before(async () => {
  const password = await hashPassword("fixture-password-only");
  await sql.begin(async (tx) => {
    for (const [kind, userId] of Object.entries({
      owner: ownerId,
      viewer: viewerId,
      outsider: outsiderId,
    })) {
      const raw = randomUUID();
      sessions[kind as keyof typeof sessions] = `session=${raw}`;
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${userId},${`${userId}@example.com`},${kind},${password},now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(raw)},${userId},now()+interval '1 hour')`;
    }
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Phase 1 fixtures')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Phase 1 fixtures')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${ownerId},'owner')`;
    await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${workspace},${viewerId},'viewer')`;
  });
});
after(async () => {
  await sql.begin(async (tx) => {
    await tx`DELETE FROM messages WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM agent_runs WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM conversations WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM deployments WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM agent_versions WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM agents WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM model_configurations WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM secrets WHERE workspace_id=${workspace}`;
    await tx`DELETE FROM audit_events WHERE organization_id=${org}`;
    await tx`DELETE FROM memberships WHERE organization_id=${org}`;
    await tx`DELETE FROM workspaces WHERE id=${workspace}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    await tx`DELETE FROM users WHERE id=ANY(${[ownerId, viewerId, outsiderId]})`;
  });
  await app.close();
});
const draft = () => ({
  name: "Fixture agent",
  description: "Explicit test fixture",
  publicDescription: "Public description",
  config: agentConfig.parse({
    modelId,
    prompt: { role: "You are a fixture.", instructions: "Original prompt" },
    maxOutputTokens: 32,
  }),
});
test("Register a tenant-owned encrypted credential and model; reject unauthorized/foreign secrets", async () => {
  assert.equal(
    (
      await call(
        "POST",
        `/workspaces/${workspace}/models`,
        { name: "No access", provider: "openai", modelId: "fixture" },
        sessions.viewer,
      )
    ).statusCode,
    403,
  );
  const secret = await call("POST", `/workspaces/${workspace}/secrets`, {
    name: "FIXTURE_PROVIDER_KEY",
    value: "fixture-not-real-key",
  });
  assert.equal(secret.statusCode, 201);
  const [s] = await sql`SELECT id FROM secrets WHERE workspace_id=${workspace}`;
  const res = await call("POST", `/workspaces/${workspace}/models`, {
    name: "Fixture model",
    provider: "openai",
    modelId: "fixture-model",
    secretId: s!.id,
    maxOutputTokens: 64,
  });
  assert.equal(res.statusCode, 201);
  modelId = res.json().id;
  assert.equal((await call("POST", `/models/${modelId}/test`)).json().ok, true);
  assert.equal(lastConnection?.apiKey, "fixture-not-real-key");
  const list = await call("GET", `/workspaces/${workspace}/models`);
  assert.ok(!list.body.includes("fixture-not-real-key"));
  assert.equal(
    (
      await call("POST", `/workspaces/${workspace}/models`, {
        name: "Foreign",
        provider: "openai",
        modelId: "fixture-model",
        secretId: randomUUID(),
      })
    ).statusCode,
    400,
  );
});
test("Custom provider registration explains host approval and retains the selected workspace credential", async () => {
  const original = config.MODEL_ALLOWED_HOSTS;
  const [secret] =
    await sql`SELECT id FROM secrets WHERE workspace_id=${workspace}`;
  const input = {
    name: "Custom provider",
    provider: "openai-compatible",
    modelId: "fixture-custom",
    secretId: secret!.id,
    baseUrl: "https://api.deepseek.com",
  };
  try {
    config.MODEL_ALLOWED_HOSTS = "api.openai.com";
    const denied = await call("POST", `/workspaces/${workspace}/models`, input);
    assert.equal(denied.statusCode, 400);
    assert.match(denied.body, /api.deepseek.com.*MODEL_ALLOWED_HOSTS/);
    config.MODEL_ALLOWED_HOSTS += ",api.deepseek.com";
    const approved = await call(
      "POST",
      `/workspaces/${workspace}/models`,
      input,
    );
    assert.equal(approved.statusCode, 201, approved.body);
    const [saved] =
      await sql`SELECT secret_id FROM model_configurations WHERE id=${approved.json().id}`;
    assert.equal(saved!.secret_id, secret!.id);
    const insecure = await call("POST", `/workspaces/${workspace}/models`, {
      ...input,
      baseUrl: "http://api.deepseek.com",
    });
    assert.equal(insecure.statusCode, 400);
    assert.match(insecure.body, /HTTPS/);
  } finally {
    config.MODEL_ALLOWED_HOSTS = original;
  }
});
test("Agent CRUD validates models, rejects viewers and cross-tenant access", async () => {
  assert.equal(
    (
      await call(
        "POST",
        `/workspaces/${workspace}/agents`,
        draft(),
        sessions.viewer,
      )
    ).statusCode,
    403,
  );
  const res = await call("POST", `/workspaces/${workspace}/agents`, draft());
  assert.equal(res.statusCode, 201);
  agentId = res.json().id;
  assert.equal(
    (await call("GET", `/agents/${agentId}`, undefined, sessions.outsider))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "PUT",
        `/agents/${agentId}`,
        { ...draft(), revision: 1 },
        sessions.viewer,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call("POST", `/workspaces/${workspace}/agents`, {
        ...draft(),
        config: { ...draft().config, modelId: randomUUID() },
      })
    ).statusCode,
    400,
  );
});
test("Published versions are immutable and stale revisions cannot overwrite drafts", async () => {
  const published = await call("POST", `/agents/${agentId}/publish`, {
    revision: 1,
  });
  assert.equal(published.statusCode, 201);
  versionId = published.json().id;
  await assert.rejects(
    () => sql`UPDATE agent_versions SET name='Changed' WHERE id=${versionId}`,
  );
  const updated = {
    ...draft(),
    config: {
      ...draft().config,
      prompt: {
        ...draft().config.prompt,
        instructions: "Changed draft prompt",
      },
    },
    revision: 1,
  };
  assert.equal(
    (await call("PUT", `/agents/${agentId}`, updated)).statusCode,
    200,
  );
  assert.equal(
    (await call("PUT", `/agents/${agentId}`, updated)).statusCode,
    409,
  );
  assert.equal(
    (await call("POST", `/agents/${agentId}/publish`, { revision: 1 }))
      .statusCode,
    409,
  );
  const [v] =
    await sql`SELECT config FROM agent_versions WHERE id=${versionId}`;
  assert.equal(v!.config.prompt.instructions, "Original prompt");
});
test("Deployment references a published version; public metadata omits prompts and credentials", async () => {
  assert.equal(
    (
      await call("POST", `/agents/${agentId}/deployments`, {
        name: "Bad",
        versionId: randomUUID(),
      })
    ).statusCode,
    400,
  );
  const deployed = await call("POST", `/agents/${agentId}/deployments`, {
    name: "Hosted fixture",
    versionId,
  });
  assert.equal(deployed.statusCode, 201);
  deploymentId = deployed.json().id;
  const publicInfo = await call(
    "GET",
    `/public/deployments/${deploymentId}`,
    undefined,
    "",
  );
  assert.equal(publicInfo.statusCode, 200);
  assert.equal(publicInfo.json().name, "Fixture agent");
  assert.equal(publicInfo.json().config, undefined);
  assert.ok(!publicInfo.body.includes("Original prompt"));
});
test("Playground streams tokens and persists messages, run IDs and reported usage", async () => {
  const res = await call("POST", `/agents/${agentId}/chat`, {
    message: "Fixture input",
  });
  assert.equal(res.statusCode, 200);
  assert.ok(String(res.headers["content-type"]).includes("text/event-stream"));
  const stream = events(res.body);
  assert.equal(
    stream.find((e) => e.event === "token")!.data.text,
    "Fixture answer",
  );
  const meta = stream.find((e) => e.event === "meta")!.data;
  assert.equal(meta.traceId.length, 32);
  const history = await call(
    "GET",
    `/conversations/${meta.conversationId}/messages`,
  );
  assert.equal(history.json().length, 2);
  const [run] = await sql`SELECT * FROM agent_runs WHERE id=${meta.runId}`;
  assert.equal(run!.status, "completed");
  assert.equal(run!.input_tokens, 5);
  assert.equal(
    (
      await call(
        "POST",
        `/agents/${agentId}/chat`,
        { message: "Attempt", conversationId: meta.conversationId },
        sessions.outsider,
      )
    ).statusCode,
    403,
  );
});
test("Hosted conversations require opaque token on continuation and keep the pinned published prompt", async () => {
  const first = await call(
    "POST",
    `/public/deployments/${deploymentId}/chat`,
    { message: "Guest fixture" },
    "",
  );
  const meta = events(first.body).find((e) => e.event === "meta")!.data;
  assert.ok(meta.guestToken);
  const [c] =
    await sql`SELECT * FROM conversations WHERE id=${meta.conversationId}`;
  assert.equal(c!.config_snapshot.prompt.instructions, "Original prompt");
  assert.notEqual(c!.guest_token_hash, meta.guestToken);
  const body = { message: "Continue", conversationId: meta.conversationId };
  assert.equal(
    (await call("POST", `/public/deployments/${deploymentId}/chat`, body, ""))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/public/deployments/${deploymentId}/chat`,
        body,
        "",
        "Bearer wrong",
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/public/deployments/${deploymentId}/chat`,
        body,
        "",
        `Bearer ${meta.guestToken}`,
      )
    ).statusCode,
    200,
  );
});
test("Provider failures produce terminal SSE errors and persisted failed runs", async () => {
  fail = true;
  try {
    const res = await call("POST", `/agents/${agentId}/chat`, {
      message: "Failure fixture",
    });
    const stream = events(res.body);
    assert.equal(stream.at(-1)!.event, "error");
    assert.equal(stream.at(-1)!.data.code, "RATE_LIMITED");
    const [run] =
      await sql`SELECT status,error_code FROM agent_runs WHERE id=${stream[0]!.data.runId}`;
    assert.equal(run!.status, "failed");
    assert.equal(run!.error_code, "RATE_LIMITED");
  } finally {
    fail = false;
  }
});
test("Recovery releases crashed runs while preserving active requests", async () => {
  const [conversation] =
    await sql`SELECT id FROM conversations WHERE workspace_id=${workspace} LIMIT 1`;
  const stale = randomUUID(),
    active = randomUUID();
  await sql`INSERT INTO agent_runs(id,conversation_id,organization_id,workspace_id,status,trace_id,started_at) VALUES (${stale},${conversation!.id},${org},${workspace},'running',${randomUUID()},now()-interval '10 minutes')`;
  await recoverInterruptedRuns();
  const [recovered] =
    await sql`SELECT status,error_code,finished_at FROM agent_runs WHERE id=${stale}`;
  assert.equal(recovered!.status, "failed");
  assert.equal(recovered!.error_code, "PROCESS_INTERRUPTED");
  assert.ok(recovered!.finished_at);
  await sql`INSERT INTO agent_runs(id,conversation_id,organization_id,workspace_id,status,trace_id) VALUES (${active},${conversation!.id},${org},${workspace},'running',${randomUUID()})`;
  await recoverInterruptedRuns();
  const [running] = await sql`SELECT status FROM agent_runs WHERE id=${active}`;
  assert.equal(running!.status, "running");
  await sql`DELETE FROM agent_runs WHERE id=${active}`;
});
test("Rollback restores a draft without changing the deployment; disable and archive deny hosted use", async () => {
  const rollback = await call(
    "POST",
    `/agents/${agentId}/rollback/${versionId}`,
    { revision: 2 },
  );
  assert.equal(rollback.statusCode, 200);
  assert.equal(
    (await call("GET", `/agents/${agentId}`)).json().draft_config.prompt
      .instructions,
    "Original prompt",
  );
  const [d] =
    await sql`SELECT version_id FROM deployments WHERE id=${deploymentId}`;
  assert.equal(d!.version_id, versionId);
  assert.equal(
    (await call("DELETE", `/agents/${agentId}/deployments/${deploymentId}`))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/public/deployments/${deploymentId}/chat`,
        { message: "Disabled" },
        "",
      )
    ).statusCode,
    404,
  );
  assert.equal((await call("DELETE", `/agents/${agentId}`)).statusCode, 200);
  assert.equal((await call("GET", `/agents/${agentId}`)).statusCode, 404);
});
