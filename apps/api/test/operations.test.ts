import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest, decrypt } from "../src/security.js";
import { processWebhookDelivery } from "../src/webhooks.js";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  workspace = randomUUID(),
  owner = randomUUID();
const sessions: Record<string, string> = {},
  users: Record<string, string> = { owner },
  memberships: Record<string, string> = {};
let model = "",
  agent = "",
  otherAgent = "",
  conversation = "",
  message = "",
  hook = "",
  signingSecret = "";
const originalHosts = config.WEBHOOK_ALLOWED_HOSTS;
const app = await buildApp({
  providerFactory: () => ({
    async *stream() {
      yield { type: "token", text: "Original fixture answer" };
      yield { type: "usage", inputTokens: 100, outputTokens: 200 };
    },
  }),
});
async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
  role = "owner",
  bearer?: string,
  origin = true,
) {
  return app.inject({
    method,
    url,
    headers: {
      ...(origin ? { origin: config.WEB_ORIGIN } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(role ? { cookie: sessions[role] } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
}
function events(body: string) {
  return body
    .split("\n\n")
    .filter((s) => s.startsWith("event:"))
    .map((s) => JSON.parse(s.split("\n")[1]!.slice(6)));
}
const base = `/workspaces/${workspace}/operations`;
before(async () => {
  config.WEBHOOK_ALLOWED_HOSTS = "hooks.example.com";
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Operations fixture')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Operations workspace')`;
    for (const role of [
      "owner",
      "builder",
      "operator",
      "analyst",
      "viewer",
      "outsider",
      "workspace_admin",
    ]) {
      const userId = role === "owner" ? owner : randomUUID(),
        raw = randomUUID();
      users[role] = userId;
      sessions[role] = `session=${raw}`;
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${userId},${userId + "@example.com"},${role},'unused-test-password',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(raw)},${userId},now()+interval '1 hour')`;
      if (role !== "outsider") {
        memberships[role] = randomUUID();
        await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${memberships[role]},${org},${role === "owner" ? null : workspace},${userId},${role})`;
      }
    }
  });
  const m = await call("POST", `/workspaces/${workspace}/models`, {
    name: "Operations model",
    provider: "openai-compatible",
    modelId: "fixture",
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 4096,
    maxOutputTokens: 1024,
  });
  assert.equal(m.statusCode, 201);
  model = m.json().id;
  for (const name of ["Operations agent", "Second agent"]) {
    const a = await call("POST", `/workspaces/${workspace}/agents`, {
      name,
      config: { modelId: model },
    });
    assert.equal(a.statusCode, 201);
    if (!agent) agent = a.json().id;
    else otherAgent = a.json().id;
  }
  const chat = await call("POST", `/agents/${agent}/chat`, {
    message: "Fixture chat",
  });
  assert.equal(chat.statusCode, 200);
  conversation = events(chat.body)[0].conversationId;
  const [mrow] =
    await sql`SELECT id FROM messages WHERE conversation_id=${conversation} AND role='assistant'`;
  message = mrow!.id;
});
after(async () => {
  config.WEBHOOK_ALLOWED_HOSTS = originalHosts;
  await sql.begin(async (tx) => {
    for (const table of [
      "webhook_deliveries",
      "workspace_webhooks",
      "workspace_api_keys",
      "conversation_reviews",
      "messages",
      "agent_runs",
      "conversations",
      "deployments",
      "agent_versions",
      "agents",
      "model_prices",
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
test("Operations permissions deny foreign tenants, separate read and administration", async () => {
  for (const role of [
    "owner",
    "workspace_admin",
    "builder",
    "operator",
    "analyst",
  ])
    assert.equal(
      (await call("GET", `${base}/analytics`, undefined, role)).statusCode,
      200,
    );
  for (const role of ["viewer", "outsider"])
    assert.equal(
      (await call("GET", `${base}/analytics`, undefined, role)).statusCode,
      403,
    );
  assert.equal(
    (
      await call(
        "PUT",
        `${base}/prices`,
        { modelId: model, inputUsdPerMillion: 2, outputUsdPerMillion: 4 },
        "operator",
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await call("GET", `${base}/api-keys`, undefined, "builder")).statusCode,
    403,
  );
});
test("Feedback and corrections remain separate from historical assistant content", async () => {
  const body = {
    rating: "dislike",
    label: "incomplete",
    comment: "Review comment",
    correctedResponse: "Expected fixture response",
    reason: "Missing details",
  };
  assert.equal(
    (await call("POST", `/messages/${message}/reviews`, body, "outsider"))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/messages/${message}/reviews`,
        { ...body, reason: "" },
        "operator",
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (await call("POST", `/messages/${message}/reviews`, body, "operator"))
      .statusCode,
    201,
  );
  const reviews = await call(
    "GET",
    `/conversations/${conversation}/reviews`,
    undefined,
    "analyst",
  );
  assert.equal(reviews.statusCode, 200);
  assert.equal(
    reviews.json()[0].corrected_response,
    "Expected fixture response",
  );
  const [row] = await sql`SELECT content FROM messages WHERE id=${message}`;
  assert.equal(row!.content, "Original fixture answer");
  const list = await call(
    "GET",
    `${base}/conversations?status=completed&rating=dislike&channel=playground&agentId=${agent}`,
  );
  assert.equal(list.statusCode, 200);
  assert.equal(list.json()[0].id, conversation);
  assert.equal(
    (await call("GET", `${base}/conversations?rating=like`)).json().length,
    0,
  );
  assert.equal(
    (await call("GET", `${base}/conversations?beforeId=${randomUUID()}`))
      .statusCode,
    400,
  );
});
test("Pricing records completion-time rates and keeps unavailable usage explicit", async () => {
  assert.equal(
    (
      await call("PUT", `${base}/prices`, {
        modelId: randomUUID(),
        inputUsdPerMillion: 2,
        outputUsdPerMillion: 4,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call("PUT", `${base}/prices`, {
        modelId: model,
        inputUsdPerMillion: 2,
        outputUsdPerMillion: 4,
      })
    ).statusCode,
    200,
  );
  const chat = await call("POST", `/agents/${agent}/chat`, {
      message: "Priced fixture",
    }),
    runId = events(chat.body)[0].runId;
  let result = (await call("GET", `${base}/analytics`)).json();
  assert.equal(result.summary.unpriced_runs, 1);
  assert.equal(result.summary.estimated_cost_usd, 0.001);
  assert.equal(result.feedback.corrections, 1);
  await call("PUT", `${base}/prices`, {
    modelId: model,
    inputUsdPerMillion: 20,
    outputUsdPerMillion: 40,
  });
  const [row] =
    await sql`SELECT input_usd_per_million,output_usd_per_million FROM agent_runs WHERE id=${runId}`;
  assert.equal(Number(row!.input_usd_per_million), 2);
  assert.equal(Number(row!.output_usd_per_million), 4);
  result = (await call("GET", `${base}/analytics`)).json();
  assert.equal(result.summary.estimated_cost_usd, 0.001);
});
test("Workspace role management protects self, inherited roles and administrator grants", async () => {
  const path = `/workspaces/${workspace}/members/${memberships.operator}/role`;
  assert.equal(
    (await call("PUT", path, { role: "builder" }, "builder")).statusCode,
    403,
  );
  assert.equal(
    (await call("PUT", path, { role: "workspace_admin" }, "workspace_admin"))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "PUT",
        `/workspaces/${workspace}/members/${memberships.workspace_admin!}/role`,
        { role: "builder" },
        "workspace_admin",
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await call(
        "PUT",
        `/workspaces/${workspace}/members/${memberships.owner}/role`,
        { role: "builder" },
      )
    ).statusCode,
    404,
  );
  assert.equal((await call("PUT", path, { role: "viewer" })).statusCode, 200);
  assert.equal(
    (
      await call(
        "POST",
        `/messages/${message}/reviews`,
        { rating: "like" },
        "operator",
      )
    ).statusCode,
    403,
  );
  assert.equal((await call("PUT", path, { role: "operator" })).statusCode, 200);
});
test("API keys are hashed, agent scoped, expire and revoke, and require live issuer permissions", async () => {
  const made = await call("POST", `${base}/api-keys`, {
    label: "Fixture application",
    agentId: agent,
    expiresInDays: 1,
  });
  assert.equal(made.statusCode, 201);
  const raw = made.json().key,
    keyId = made.json().id;
  const [row] =
    await sql`SELECT token_hash FROM workspace_api_keys WHERE id=${keyId}`;
  assert.equal(row!.token_hash, digest(raw));
  const list = await call("GET", `${base}/api-keys`);
  assert.ok(!list.body.includes(raw));
  assert.ok(!list.body.includes(digest(raw)));
  assert.equal(
    (
      await call(
        "POST",
        `/agents/${agent}/chat`,
        { message: "Key chat" },
        "",
        raw,
        false,
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/agents/${otherAgent}/chat`,
        { message: "Wrong scope" },
        "",
        raw,
        false,
      )
    ).statusCode,
    401,
  );
  assert.equal(
    (await call("GET", `${base}/analytics`, undefined, "", raw, false))
      .statusCode,
    401,
  );
  await sql`UPDATE workspace_api_keys SET expires_at=now()-interval '1 second' WHERE id=${keyId}`;
  assert.equal(
    (
      await call(
        "POST",
        `/agents/${agent}/chat`,
        { message: "Expired" },
        "",
        raw,
        false,
      )
    ).statusCode,
    401,
  );
  await sql`UPDATE workspace_api_keys SET expires_at=now()+interval '1 hour' WHERE id=${keyId}`;
  assert.equal(
    (await call("DELETE", `${base}/api-keys/${keyId}`)).statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/agents/${agent}/chat`,
        { message: "Revoked" },
        "owner",
        raw,
        false,
      )
    ).statusCode,
    401,
  );
  const adminKey = (
    await call(
      "POST",
      `${base}/api-keys`,
      { label: "Admin application", agentId: agent },
      "workspace_admin",
    )
  ).json().key;
  await sql`UPDATE memberships SET role='operator' WHERE id=${memberships.workspace_admin!}`;
  assert.equal(
    (
      await call(
        "POST",
        `/agents/${agent}/chat`,
        { message: "Permission revoked" },
        "",
        adminKey,
        false,
      )
    ).statusCode,
    403,
  );
  await sql`UPDATE memberships SET role='workspace_admin' WHERE id=${memberships.workspace_admin!}`;
});
test("Webhooks validate endpoint approval, omit secrets and enqueue safe run metadata", async () => {
  assert.equal(
    (
      await call("POST", `${base}/webhooks`, {
        name: "Blocked",
        url: "https://unapproved.example/events",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call("POST", `${base}/webhooks`, {
        name: "Unsafe query",
        url: "https://hooks.example.com/events?token=secret",
      })
    ).statusCode,
    400,
  );
  const made = await call("POST", `${base}/webhooks`, {
    name: "Fixture listener",
    url: "https://hooks.example.com/events",
  });
  assert.equal(made.statusCode, 201);
  hook = made.json().id;
  signingSecret = made.json().signingSecret;
  const list = await call("GET", `${base}/webhooks`);
  assert.ok(!list.body.includes(signingSecret));
  assert.ok(!list.body.includes("signing_secret"));
  await call("POST", `/agents/${agent}/chat`, {
    message: "Do not send this content to the webhook",
  });
  const [delivery] =
    await sql`SELECT payload FROM webhook_deliveries WHERE webhook_id=${hook}`;
  assert.equal(delivery!.payload.type, "agent.run.finished");
  assert.ok(!JSON.stringify(delivery).includes("Do not send"));
  assert.ok(!JSON.stringify(delivery).includes("Original fixture"));
});
test("Signed webhook delivery retries transient failures, supports manual retry and secret rotation", async () => {
  const [job] =
    await sql`SELECT id FROM webhook_deliveries WHERE webhook_id=${hook}`;
  let status = 503;
  const send = async (
    _url: string,
    headers: Record<string, string>,
    payload: unknown,
  ) => {
    assert.equal(
      headers["x-agentconnect-signature"],
      `sha256=${createHmac("sha256", signingSecret)
        .update(
          `${headers["x-agentconnect-timestamp"]}.${JSON.stringify(payload)}`,
        )
        .digest("hex")}`,
    );
    return { status, body: (async function* () {})(), close: async () => {} };
  };
  assert.equal(await processWebhookDelivery(send), true);
  const [retry] =
    await sql`SELECT status,attempts,error_code,next_attempt_at FROM webhook_deliveries WHERE id=${job!.id}`;
  assert.equal(retry!.status, "pending");
  assert.equal(retry!.attempts, 1);
  assert.equal(retry!.error_code, "WEBHOOK_HTTP_ERROR");
  await sql`UPDATE webhook_deliveries SET next_attempt_at=now() WHERE id=${job!.id}`;
  signingSecret = (await call("POST", `${base}/webhooks/${hook}/rotate`)).json()
    .signingSecret;
  status = 400;
  await processWebhookDelivery(send);
  assert.equal(
    (await call("GET", `${base}/webhook-deliveries`)).json()[0].status,
    "failed",
  );
  assert.equal(
    (await call("POST", `${base}/webhook-deliveries/${job!.id}/retry`))
      .statusCode,
    200,
  );
  status = 204;
  await processWebhookDelivery(send);
  const [done] =
    await sql`SELECT status,attempts FROM webhook_deliveries WHERE id=${job!.id}`;
  assert.equal(done!.status, "delivered");
  assert.equal(done!.attempts, 1);
  assert.equal(
    (await call("POST", `${base}/webhook-deliveries/${job!.id}/retry`))
      .statusCode,
    409,
  );
  await call("PUT", `${base}/webhooks/${hook}`, { enabled: false });
  const chat = await call("POST", `/agents/${agent}/chat`, {
    message: "Disabled hook",
  });
  const runId = events(chat.body)[0].runId;
  const [found] =
    await sql`SELECT count(*)::int AS n FROM webhook_deliveries WHERE payload->>'runId'=${runId}`;
  assert.equal(found!.n, 0);
  const [stored] =
    await sql`SELECT signing_secret FROM workspace_webhooks WHERE id=${hook}`;
  assert.equal(
    decrypt(stored!.signing_secret, `webhook:${hook}`),
    signingSecret,
  );
});
test("Deployment environment promotion only accepts published versions of the same agent", async () => {
  const published = await call("POST", `/agents/${agent}/publish`, {
    revision: 1,
  });
  assert.equal(published.statusCode, 201);
  const versionId = published.json().id;
  const made = await call("POST", `/agents/${agent}/deployments`, {
    name: "Staging release",
    versionId,
    environment: "staging",
  });
  assert.equal(made.statusCode, 201);
  const deployment = made.json().id;
  const path = `${base}/deployments/${deployment}`;
  assert.equal(
    (
      await call("PUT", path, {
        versionId: randomUUID(),
        environment: "production",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call(
        "PUT",
        path,
        { versionId, environment: "production" },
        "builder",
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await call("PUT", path, { versionId, environment: "production" }))
      .statusCode,
    200,
  );
  assert.equal(
    (await call("GET", `${base}/deployments`)).json()[0].environment,
    "production",
  );
});

test("Audit access is scoped and webhook final-attempt crashes leave a retryable failure record", async () => {
  const ownerAudit = await call("GET", `${base}/audit?action=api_key.created`);
  assert.equal(ownerAudit.statusCode, 200);
  assert.ok(ownerAudit.json().length > 0);
  assert.ok(!ownerAudit.body.includes("token_hash"));
  assert.ok(!ownerAudit.body.includes("Review comment"));
  assert.equal(
    (await call("GET", `${base}/audit`, undefined, "builder")).statusCode,
    403,
  );
  assert.equal(
    (await call("GET", `${base}/audit`, undefined, "analyst")).statusCode,
    200,
  );
  assert.equal(
    (await call("GET", `${base}/audit`, undefined, "outsider")).statusCode,
    403,
  );
  const [delivery] =
    await sql`SELECT id FROM webhook_deliveries WHERE webhook_id=${hook} LIMIT 1`;
  await sql`UPDATE webhook_deliveries SET status='sending',attempts=5,lease_until=now()-interval '1 second' WHERE id=${delivery!.id}`;
  assert.equal(await processWebhookDelivery(), false);
  const [failed] =
    await sql`SELECT status,error_code FROM webhook_deliveries WHERE id=${delivery!.id}`;
  assert.equal(failed!.status, "failed");
  assert.equal(failed!.error_code, "WEBHOOK_LEASE_EXPIRED");
});

test("API key rate limits apply independently to distinct keys", async () => {
  const make = async (label: string) =>
    (await call("POST", `${base}/api-keys`, { label, agentId: agent })).json()
      .key as string;
  const first = await make("Rate limit fixture"),
    second = await make("Independent fixture");
  for (let i = 0; i < 30; i++)
    assert.equal(
      (
        await call(
          "POST",
          `/agents/${agent}/chat`,
          { message: "Rate limit request" },
          "",
          first,
          false,
        )
      ).statusCode,
      200,
    );
  assert.equal(
    (
      await call(
        "POST",
        `/agents/${agent}/chat`,
        { message: "Over limit" },
        "",
        first,
        false,
      )
    ).statusCode,
    429,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/agents/${agent}/chat`,
        { message: "Independent key" },
        "",
        second,
        false,
      )
    ).statusCode,
    200,
  );
});
