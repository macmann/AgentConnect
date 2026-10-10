import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest } from "../src/security.js";
import { processEvaluationRun } from "../src/quality-worker.js";
import { example, deterministicScore } from "@agentconnect/schemas/quality";
import {
  ProviderError,
  type ProviderFactory,
} from "@agentconnect/provider-sdk";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  workspace = randomUUID(),
  sessions: Record<string, string> = {},
  users: string[] = [];
const app = await buildApp();
let modelId = "",
  agentId = "",
  datasetId = "",
  revision = 1;
const ev = { mode: "deterministic", minScore: 0.8 };
const provider: ProviderFactory = () => ({
  async *stream() {
    yield { type: "token", text: "Hello world" };
    yield { type: "usage", inputTokens: 12, outputTokens: 3 };
  },
});
async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  role = "owner",
) {
  return app.inject({
    remoteAddress: "127.0.0.8",
    method,
    url: path,
    headers: {
      cookie: sessions[role],
      origin: config.WEB_ORIGIN,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    payload: body ? JSON.stringify(body) : undefined,
  });
}
const base = `/workspaces/${workspace}`;
before(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Quality fixtures')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Quality workspace')`;
    for (const role of ["owner", "builder", "analyst", "outsider"]) {
      const uid = randomUUID(),
        raw = randomUUID();
      users.push(uid);
      sessions[role] = "session=" + raw;
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${uid},${uid + "@example.com"},${role},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(raw)},${uid},now()+interval '1 hour')`;
      if (role !== "outsider")
        await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${role === "owner" ? null : workspace},${uid},${role})`;
    }
  });
  const m = await call("POST", base + "/models", {
    name: "Quality fixture",
    provider: "openai-compatible",
    modelId: "fixture",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.equal(m.statusCode, 201, m.body);
  modelId = m.json().id;
  const a = await call("POST", base + "/agents", {
    name: "Quality agent",
    config: { modelId },
  });
  assert.equal(a.statusCode, 201, a.body);
  agentId = a.json().id;
  const d = await call("POST", base + "/datasets", {
    name: "Greetings",
    examples: [
      {
        input: "hi",
        expectedBehavior: "Greet the user",
        contains: ["hello"],
        forbidden: ["secret"],
        tags: ["greeting"],
      },
    ],
  });
  assert.equal(d.statusCode, 201, d.body);
  datasetId = d.json().id;
});
after(async () => {
  await sql.begin(async (tx) => {
    for (const table of [
      "evaluation_results",
      "evaluation_runs",
      "agent_quality_gates",
      "evaluation_datasets",
      "tool_executions",
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
    for (const uid of users) await tx`DELETE FROM users WHERE id=${uid}`;
  });
  await app.close();
});
async function queue(extra: Record<string, unknown> = {}) {
  const r = await call("POST", base + "/evaluations", {
    agentId,
    datasetId,
    revision,
    evaluator: ev,
    ...extra,
  });
  assert.equal(r.statusCode, 202, r.body);
  return r.json().id as string;
}
async function detail(run: string) {
  const r = await call("GET", base + "/evaluations/" + run);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
test("deterministic checks normalize text and measure retrieval coverage", () => {
  const source = randomUUID(),
    e = example.parse({
      input: "question",
      expectedBehavior: "Answer",
      expectedAnswer: "Hello WORLD",
      contains: [" world "],
      forbidden: ["leak"],
      expectedSourceIds: [source],
    });
  assert.deepEqual(deterministicScore(e, " hello  world ", [source]), {
    score: 1,
    retrievalRecall: 1,
  });
  assert.equal(deterministicScore(e, "hello world leak", []).score, 0.25);
  assert.throws(() => example.parse({ ...e, contains: ["   "] }));
});
test("workspace permissions protect datasets, evaluations and administrator gates", async () => {
  assert.equal(
    (await call("GET", base + "/datasets", undefined, "outsider")).statusCode,
    403,
  );
  assert.equal(
    (await call("POST", base + "/datasets", { name: "Denied" }, "analyst"))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "PUT",
        base + "/quality-gates/" + agentId,
        { enabled: true, datasetId, minPassRate: 1, evaluator: ev },
        "builder",
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await call("GET", base + "/evaluations", undefined, "analyst")).statusCode,
    200,
  );
});
test("quality gate blocks publication until evaluation passes and reports regression", async () => {
  const g = await call("PUT", base + "/quality-gates/" + agentId, {
    enabled: true,
    datasetId,
    minPassRate: 1,
    evaluator: ev,
  });
  assert.equal(g.statusCode, 200, g.body);
  assert.equal(
    (await call("POST", `/agents/${agentId}/publish`, { revision })).statusCode,
    409,
  );
  const run = await queue();
  assert.equal(await processEvaluationRun(provider), true);
  const d = await detail(run);
  assert.equal(d.status, "completed");
  assert.equal(d.summary.passRate, 1);
  assert.equal(d.results[0].output, "Hello world");
  assert.equal(d.summary.cost, null);
  assert.equal(
    (await call("POST", `/agents/${agentId}/publish`, { revision })).statusCode,
    201,
  );
  const regression = await queue({ baselineRunId: run });
  await processEvaluationRun(provider);
  assert.equal((await detail(regression)).summary.regression.passRateDelta, 0);
});
test("provider errors fail cases and cannot pass a publication gate", async () => {
  const run = await queue();
  await processEvaluationRun(() => ({
    async *stream() {
      throw new ProviderError("PROVIDER_HTTP_ERROR", false, 400);
    },
  }));
  const d = await detail(run);
  assert.equal(d.summary.failedCases, 1);
  assert.equal(d.results[0].error_code, "PROVIDER_HTTP_ERROR");
  assert.equal(
    (await call("POST", `/agents/${agentId}/publish`, { revision })).statusCode,
    409,
  );
});
test("dataset revisions invalidate passing gates and reject stale edits", async () => {
  const run = await queue();
  await processEvaluationRun(provider);
  assert.equal((await detail(run)).summary.passRate, 1);
  const d = await call("PUT", base + "/datasets/" + datasetId, {
    revision: 1,
    dataset: {
      name: "Greetings edited",
      examples: [
        { input: "hi", expectedBehavior: "Say goodbye", contains: ["goodbye"] },
      ],
    },
  });
  assert.equal(d.statusCode, 200, d.body);
  assert.equal(
    (
      await call("PUT", base + "/datasets/" + datasetId, {
        revision: 1,
        dataset: { name: "Stale", examples: [] },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await call("POST", `/agents/${agentId}/publish`, { revision })).statusCode,
    409,
  );
  const newRun = await queue();
  await processEvaluationRun(provider);
  assert.equal((await detail(newRun)).summary.passRate, 0);
});
test("changed draft invalidates evaluation and stale revision is rejected", async () => {
  const saved = await call("PUT", `/agents/${agentId}`, {
    name: "Quality changed",
    revision,
    config: { modelId, temperature: 0.5 },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  revision = saved.json().revision;
  assert.equal(
    (
      await call("POST", base + "/evaluations", {
        agentId,
        datasetId,
        revision: 1,
        evaluator: ev,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await call("POST", `/agents/${agentId}/publish`, { revision })).statusCode,
    409,
  );
});
test("cancelled queued runs never call the provider", async () => {
  const run = await queue();
  assert.equal(
    (await call("POST", base + "/evaluations/" + run + "/cancel")).statusCode,
    200,
  );
  let invoked = false;
  await processEvaluationRun(() => {
    invoked = true;
    return provider({
      provider: "openai-compatible",
      modelId: "fixture",
      baseUrl: "",
      capabilities: { temperature: true, topP: true },
    });
  });
  assert.equal(invoked, false);
  assert.equal((await detail(run)).status, "cancelled");
});
test("LLM judge validates structured scores and refuses malformed responses", async () => {
  const judge = await call("POST", base + "/models", {
    name: "Judge fixture",
    provider: "openai-compatible",
    modelId: "judge",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.equal(judge.statusCode, 201, judge.body);
  const run = await queue({
    evaluator: { mode: "judge", judgeModelId: judge.json().id, minScore: 0.8 },
  });
  await processEvaluationRun((conn) =>
    conn.modelId === "judge"
      ? {
          async *stream() {
            yield {
              type: "token",
              text: JSON.stringify({
                correctness: 1,
                relevance: 1,
                groundedness: 1,
                policyCompliance: 1,
                reason: "Appropriate",
              }),
            };
          },
        }
      : provider(conn),
  );
  const d = await detail(run);
  assert.equal(d.results[0].metrics.judge.correctness, 1);
  assert.equal(d.results[0].passed, false);
  const malformed = await queue({
    evaluator: { mode: "judge", judgeModelId: judge.json().id, minScore: 0.8 },
  });
  await processEvaluationRun((conn) =>
    conn.modelId === "judge"
      ? {
          async *stream() {
            yield { type: "token", text: "not JSON" };
          },
        }
      : provider(conn),
  );
  assert.equal((await detail(malformed)).summary.failedCases, 1);
});
test("expired final lease terminates instead of leaving runs running forever", async () => {
  const run = await queue();
  await sql`UPDATE evaluation_runs SET status='running',attempts=3,lease_until=now()-interval '1 second' WHERE id=${run}`;
  await processEvaluationRun(provider);
  assert.equal((await detail(run)).error_code, "RETRY_LIMIT");
});
test("empty deterministic checks are rejected", async () => {
  const d = await call("POST", base + "/datasets", {
    name: "No checks",
    examples: [{ input: "hi", expectedBehavior: "Greet" }],
  });
  assert.equal(d.statusCode, 201, d.body);
  assert.equal(
    (
      await call("POST", base + "/evaluations", {
        agentId,
        datasetId: d.json().id,
        revision,
        evaluator: ev,
      })
    ).statusCode,
    400,
  );
});

test("priced runs freeze rates and report estimated costs", async () => {
  const price = await call("PUT", base + "/operations/prices", {
    modelId,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
  });
  assert.equal(price.statusCode, 200, price.body);
  const run = await queue();
  await call("PUT", base + "/operations/prices", {
    modelId,
    inputUsdPerMillion: 50,
    outputUsdPerMillion: 50,
  });
  await processEvaluationRun(provider);
  const d = await detail(run);
  assert.equal(d.summary.cost, 0.000018);
  assert.equal(d.results[0].metrics.inputTokens, 12);
});
test("model changes invalidate queued evaluations before provider execution", async () => {
  const run = await queue();
  await sql`UPDATE model_configurations SET revision=revision+1 WHERE id=${modelId}`;
  let invoked = false;
  await processEvaluationRun((conn) => {
    invoked = true;
    return provider(conn);
  });
  assert.equal(invoked, false);
  assert.equal(
    (await detail(run)).error_code,
    "EVALUATION_DEPENDENCIES_CHANGED",
  );
});
test("lost requester access prevents queued evaluation execution", async () => {
  const r = await call(
    "POST",
    base + "/evaluations",
    { agentId, datasetId, revision, evaluator: ev },
    "builder",
  );
  assert.equal(r.statusCode, 202, r.body);
  await sql`UPDATE memberships SET role='viewer' WHERE workspace_id=${workspace} AND role='builder'`;
  await processEvaluationRun(provider);
  assert.equal((await detail(r.json().id)).status, "failed");
  await sql`UPDATE memberships SET role='builder' WHERE workspace_id=${workspace} AND role='viewer'`;
});
test("resuming an expired lease keeps completed case checkpoints", async () => {
  const run = await queue();
  await processEvaluationRun(provider);
  const before = await detail(run);
  await sql`UPDATE evaluation_runs SET status='running',attempts=1,lease_until=now()-interval '1 second',summary=NULL WHERE id=${run}`;
  let called = false;
  await processEvaluationRun((conn) => {
    called = true;
    return provider(conn);
  });
  assert.equal(called, false);
  const resumed = await detail(run);
  assert.equal(resumed.status, "completed");
  assert.deepEqual(resumed.results, before.results);
});
test("in-flight cancellation stops later cases and terminal writes", async () => {
  const run = await queue();
  await processEvaluationRun(() => ({
    async *stream() {
      await call("POST", base + "/evaluations/" + run + "/cancel");
      yield { type: "token", text: "Hello world" };
    },
  }));
  const d = await detail(run);
  assert.equal(d.status, "cancelled");
  assert.equal(d.results.length, 0);
});
test("dataset imports reject assistant messages outside the workspace", async () => {
  const ds = (await call("GET", base + "/datasets"))
    .json()
    .find((d: { id: string }) => d.id === datasetId);
  assert.equal(
    (
      await call("POST", base + "/datasets/" + datasetId + "/import-messages", {
        revision: ds.revision,
        messageIds: [randomUUID()],
      })
    ).statusCode,
    404,
  );
});
