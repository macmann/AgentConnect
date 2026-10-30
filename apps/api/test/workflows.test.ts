import { agentConfig } from "@agentconnect/schemas/agents";
import { capturedSpans } from "./tracing-fixture.js";
import { ProviderError } from "@agentconnect/provider-sdk";
import {
  workflowTemplates,
  workflowFromTemplate,
} from "@agentconnect/schemas/workflow-templates";
import { workflowPresentation } from "@agentconnect/schemas/workflow-results";
import { createServer } from "node:http";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest, hashPassword } from "../src/security.js";
import {
  workflowGraph,
  analyzeWorkflow,
} from "@agentconnect/schemas/workflows";
import {
  processWorkflowRun,
  workflowSaver,
  closeWorkflowSaver,
  claimWorkflowRun,
} from "../src/workflow-runtime.js";
import type { ProviderFactory } from "@agentconnect/provider-sdk";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  workspace = randomUUID(),
  owner = randomUUID(),
  builder = randomUUID(),
  operator = randomUUID(),
  viewer = randomUUID(),
  outsider = randomUUID();
const sessions: Record<string, string> = {};
const runs: string[] = [];
let research = "",
  risk = "",
  final = "",
  active = 0,
  maxActive = 0,
  researchCalls = 0;
let simpleWorkflow = "",
  simpleVersion = "";
const provider: ProviderFactory = (c) => ({
  async *stream(input) {
    active++;
    maxActive = Math.max(active, maxActive);
    if (c.modelId === "research") researchCalls++;
    try {
      await new Promise((r) => setTimeout(r, 30));
      yield {
        type: "token",
        text: `${c.modelId}: ${input.messages.at(-1)?.content}`,
      };
      yield { type: "usage", inputTokens: 8, outputTokens: 5 };
    } finally {
      active--;
    }
  },
});
const originalPrivate = config.TOOL_PRIVATE_HOSTS;
let toolFailures = 0;
const toolServer = createServer((req, res) => {
  if (toolFailures-- > 0) {
    res.writeHead(503).end("temporary outage");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      reference: "fixture reference",
      query: new URL(req.url!, "http://localhost").searchParams.get("query"),
    }),
  );
});
await new Promise<void>((resolve) =>
  toolServer.listen(0, "127.0.0.1", resolve),
);
const toolPort = (toolServer.address() as { port: number }).port;
config.TOOL_PRIVATE_HOSTS = `127.0.0.1:${toolPort}`;
let queueAddress = 30;
const app = await buildApp({ providerFactory: provider });
async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
  session = sessions.owner,
) {
  return app.inject({
    method,
    url,
    remoteAddress:
      method === "POST" && url.endsWith("/runs")
        ? `198.51.100.${queueAddress++}`
        : "198.51.100.24",
    headers: {
      origin: config.WEB_ORIGIN,
      cookie: session ?? "",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    payload: body ? JSON.stringify(body) : undefined,
  });
}
const node = (
  id: string,
  type: string,
  data: Record<string, unknown> = {},
) => ({ id, type, position: { x: 0, y: 0 }, data: { label: id, ...data } });
const graph = (
  nodes: ReturnType<typeof node>[],
  edges: (
    string[] | { source: string; target: string; sourceHandle: string }
  )[],
) =>
  workflowGraph.parse({
    nodes,
    edges: edges.map((e, i) =>
      Array.isArray(e)
        ? { id: "edge" + i, source: e[0], target: e[1] }
        : { id: "edge" + i, ...e },
    ),
  });
const simple = () =>
  graph(
    [node("input", "input"), node("output", "output")],
    [["input", "output"]],
  );
async function create(name: string, g: ReturnType<typeof graph>) {
  const r = await call("POST", `/workspaces/${workspace}/workflows`, {
    name,
    graph: g,
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().id as string;
}
async function run(id: string, extra: Record<string, unknown> = {}) {
  const r = await call("POST", `/workflows/${id}/runs`, {
    input: "refund policy",
    revision: 1,
    ...extra,
  });
  assert.equal(r.statusCode, 202, r.body);
  runs.push(r.json().id);
  return r.json().id as string;
}
async function inspect(id: string) {
  const r = await call("GET", `/workflow-runs/${id}`);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
before(async () => {
  await sql.begin(async (tx) => {
    for (const [name, user] of Object.entries({
      owner,
      builder,
      operator,
      viewer,
      outsider,
    })) {
      const raw = randomUUID();
      sessions[name] = "session=" + raw;
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${user},${user + "@example.com"},${name},${await hashPassword("fixture-only-password")},now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(raw)},${user},now()+interval '1 hour')`;
    }
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Workflow fixtures')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${workspace},${org},'Workflow fixtures')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES (${randomUUID()},${org},${owner},'owner')`;
    for (const [role, user] of [
      ["builder", builder],
      ["operator", operator],
      ["viewer", viewer],
    ])
      await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${workspace},${user!},${role!})`;
  });
  const versions: Record<string, string> = {};
  for (const name of ["research", "risk", "final"]) {
    const m = await call("POST", `/workspaces/${workspace}/models`, {
      name,
      provider: "openai-compatible",
      modelId: name,
      baseUrl: "https://api.openai.com/v1",
    });
    assert.equal(m.statusCode, 201, m.body);
    const a = await call("POST", `/workspaces/${workspace}/agents`, {
      name,
      config: { modelId: m.json().id },
    });
    assert.equal(a.statusCode, 201, a.body);
    const v = await call("POST", `/agents/${a.json().id}/publish`, {
      revision: 1,
    });
    assert.equal(v.statusCode, 201, v.body);
    versions[name] = v.json().id;
  }
  research = versions.research!;
  risk = versions.risk!;
  final = versions.final!;
});
after(async () => {
  const saver = await workflowSaver();
  for (const id of runs) await saver.deleteThread(id);
  await closeWorkflowSaver();
  await sql.begin(async (tx) => {
    for (const t of [
      "tool_executions",
      "workflow_approvals",
      "workflow_node_runs",
      "workflow_runs",
      "workflow_versions",
      "tools",
      "mcp_connectors",
      "workflows",
      "messages",
      "agent_runs",
      "conversations",
      "deployments",
      "agent_versions",
      "agents",
      "model_configurations",
      "secrets",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(t)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    await tx`DELETE FROM users WHERE id=ANY(${[owner, builder, operator, viewer, outsider]})`;
  });
  await app.close();
  config.TOOL_PRIVATE_HOSTS = originalPrivate;
  toolServer.closeAllConnections();
  await new Promise<void>((resolve) => toolServer.close(() => resolve()));
});
test("Workflow graph validation rejects cycles, unreachable nodes, invalid mappings and incomplete branches", () => {
  assert.deepEqual(analyzeWorkflow(simple()).errors, []);
  const cycle = graph(
    [node("input", "input"), node("a", "merge"), node("output", "output")],
    [
      ["input", "a"],
      ["a", "a"],
      ["a", "output"],
    ],
  );
  assert(analyzeWorkflow(cycle).errors.some((e) => e.includes("Cycles")));
  const disconnected = graph(
    [...simple().nodes, node("extra", "tool")],
    [["input", "output"]],
  );
  assert(
    analyzeWorkflow(disconnected).errors.some((e) => e.includes("unreachable")),
  );
  const mapped = simple();
  mapped.nodes[1]!.data.inputFrom = "missing";
  assert(analyzeWorkflow(mapped).errors.some((e) => e.includes("ancestor")));
  const branch = graph(
    [node("input", "input"), node("route", "router"), node("output", "output")],
    [
      ["input", "route"],
      ["route", "output"],
    ],
  );
  assert(analyzeWorkflow(branch).errors.some((e) => e.includes("true")));
});
test("Workflow CRUD/versioning enforces tenancy, roles, optimistic revisions and immutable publication", async () => {
  assert.equal(
    (
      await call(
        "POST",
        `/workspaces/${workspace}/workflows`,
        { name: "Denied", graph: simple() },
        sessions.viewer,
      )
    ).statusCode,
    403,
  );
  simpleWorkflow = await create("Identity", simple());
  assert.equal(
    (
      await call(
        "GET",
        `/workflows/${simpleWorkflow}`,
        undefined,
        sessions.outsider,
      )
    ).statusCode,
    403,
  );
  const published = await call("POST", `/workflows/${simpleWorkflow}/publish`, {
    revision: 1,
  });
  assert.equal(published.statusCode, 201, published.body);
  simpleVersion = published.json().id;
  await assert.rejects(
    sql`UPDATE workflow_versions SET name='mutated' WHERE id=${simpleVersion}`,
    /immutable/,
  );
  const update = { name: "Changed draft", graph: simple(), revision: 1 };
  assert.equal(
    (await call("PUT", `/workflows/${simpleWorkflow}`, update)).statusCode,
    200,
  );
  assert.equal(
    (await call("PUT", `/workflows/${simpleWorkflow}`, update)).statusCode,
    409,
  );
  const [version] =
    await sql`SELECT name FROM workflow_versions WHERE id=${simpleVersion}`;
  assert.equal(version?.name, "Identity");
  const restore = await call(
    "POST",
    `/workflows/${simpleWorkflow}/restore/${simpleVersion}`,
    { revision: 2 },
  );
  assert.equal(restore.statusCode, 200, restore.body);
  assert.equal(
    (
      await call("POST", `/workflows/${simpleWorkflow}/runs`, {
        input: "x",
        revision: 1,
      })
    ).statusCode,
    409,
  );
});
test("Durable LangGraph worker executes a pinned published workflow with persisted node traces", async () => {
  const id = await run(simpleWorkflow, { versionId: simpleVersion });
  assert.equal((await inspect(id)).status, "queued");
  assert.equal(await processWorkflowRun({ providerFactory: provider }), true);
  const finished = await inspect(id);
  assert.equal(finished.status, "completed", JSON.stringify(finished));
  assert.equal(finished.output, "refund policy");
  const spans = capturedSpans().filter(
    (s) => s.attributes["workflow.run.id"] === id,
  );
  const root = spans.find((s) => s.name === "workflow.run")!;
  assert(root);
  assert.equal(
    spans.filter((s) => s.name.startsWith("workflow.node.")).length,
    2,
  );
  for (const child of spans.filter((s) =>
    s.name.startsWith("workflow.node."),
  )) {
    assert.equal(child.spanContext().traceId, root.spanContext().traceId);
    assert.equal(child.parentSpanContext?.spanId, root.spanContext().spanId);
  }

  assert.equal(finished.nodes.length, 2);
  assert(
    finished.nodes.every((n: { status: string }) => n.status === "completed"),
  );
  assert.equal(
    (await call("GET", `/workflow-runs/${id}`, undefined, sessions.outsider))
      .statusCode,
    403,
  );
  assert.equal(
    (await call("GET", `/workflow-runs/${id}`, undefined, sessions.viewer))
      .statusCode,
    403,
  );
});
test("Sequential published agents hand off outputs and keep provider-reported usage per node", async () => {
  const g = graph(
    [
      node("input", "input"),
      node("research", "agent", { agentVersionId: research }),
      node("final", "agent", { agentVersionId: final }),
      node("output", "output"),
    ],
    [
      ["input", "research"],
      ["research", "final"],
      ["final", "output"],
    ],
  );
  const w = await create("Sequential agents", g);
  const id = await run(w);
  await processWorkflowRun({ providerFactory: provider });
  const r = await inspect(id);
  assert.equal(r.status, "completed", JSON.stringify(r));
  assert.equal(r.output, "final: research: refund policy");
  assert.equal(
    r.nodes.find((n: { node_id: string }) => n.node_id === "research")
      .input_tokens,
    8,
  );
});
test("Router and Condition select only one branch; rejected paths do not execute", async () => {
  for (const type of ["router", "condition"]) {
    const g = graph(
      [
        node("input", "input"),
        node("route", type, { operator: "contains", value: "refund" }),
        node("yes", "agent", { agentVersionId: research }),
        node("no", "agent", { agentVersionId: risk }),
        node("merge", "merge"),
        node("output", "output"),
      ],
      [
        ["input", "route"],
        { source: "route", target: "yes", sourceHandle: "true" },
        { source: "route", target: "no", sourceHandle: "false" },
        ["yes", "merge"],
        ["no", "merge"],
        ["merge", "output"],
      ],
    );
    const w = await create(type, g);
    const id = await run(w);
    await processWorkflowRun({ providerFactory: provider });
    const r = await inspect(id);
    assert.equal(r.status, "completed", JSON.stringify(r));
    assert.equal(r.output.yes, "research: refund policy");
    assert(!r.nodes.some((n: { node_id: string }) => n.node_id === "no"));
  }
});
test("Parallel fan-out runs concurrently and Merge waits for all branches including unequal path lengths", async () => {
  maxActive = 0;
  const g = graph(
    [
      node("input", "input"),
      node("parallel", "parallel"),
      node("research", "agent", { agentVersionId: research }),
      node("research2", "agent", { agentVersionId: research }),
      node("risk", "agent", { agentVersionId: risk }),
      node("merge", "merge"),
      node("final", "agent", { agentVersionId: final }),
      node("output", "output"),
    ],
    [
      ["input", "parallel"],
      ["parallel", "research"],
      ["research", "research2"],
      ["parallel", "risk"],
      ["research2", "merge"],
      ["risk", "merge"],
      ["merge", "final"],
      ["final", "output"],
    ],
  );
  assert.deepEqual(analyzeWorkflow(g).errors, []);
  const w = await create("Parallel agents", g),
    id = await run(w);
  await processWorkflowRun({ providerFactory: provider });
  const r = await inspect(id);
  assert.equal(r.status, "completed", JSON.stringify(r));
  assert(maxActive >= 2);
  assert(r.output.includes("research2"));
  assert(r.output.includes("risk"));
  assert.equal(
    r.nodes.filter((n: { node_id: string }) => n.node_id === "merge").length,
    1,
  );
});
test("Human approval pauses in PostgreSQL, survives saver restart and resumes without rerunning prior agents", async () => {
  const g = graph(
    [
      node("input", "input"),
      node("research", "agent", { agentVersionId: research }),
      node("review", "approval"),
      node("final", "agent", { agentVersionId: final }),
      node("output", "output"),
    ],
    [
      ["input", "research"],
      ["research", "review"],
      ["review", "final"],
      ["final", "output"],
    ],
  );
  const w = await create("Human review", g),
    id = await run(w);
  const before = researchCalls;
  await processWorkflowRun({ providerFactory: provider });
  let r = await inspect(id);
  assert.equal(r.status, "waiting", JSON.stringify(r));
  assert.equal(r.approvals.length, 1);
  assert.equal(researchCalls, before + 1);
  const paused = capturedSpans().find(
    (s) =>
      s.name === "workflow.node.approval" &&
      s.attributes["workflow.run.id"] === id,
  )!;
  assert.equal(paused.attributes["execution.status"], "waiting");
  assert.notEqual(paused.status.code, 2);

  assert.equal(
    (
      await call(
        "POST",
        `/workflow-runs/${id}/approval`,
        { decision: "approved" },
        sessions.builder,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/workflow-runs/${id}/approval`,
        {
          decision: "approved",
          comment: "Reviewed",
          editedInput: "approved source",
        },
        sessions.operator,
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call("POST", `/workflow-runs/${id}/approval`, {
        decision: "approved",
      })
    ).statusCode,
    409,
  );
  await closeWorkflowSaver();
  await processWorkflowRun({ providerFactory: provider });
  r = await inspect(id);
  assert.equal(r.status, "completed", JSON.stringify(r));
  assert.equal(r.output, "final: approved source");
  assert.equal(researchCalls, before + 1);
  const rejected = await run(w);
  await processWorkflowRun({ providerFactory: provider });
  assert.equal(
    (
      await call("POST", `/workflow-runs/${rejected}/approval`, {
        decision: "rejected",
        comment: "Needs revision",
      })
    ).statusCode,
    200,
  );
  assert.equal((await inspect(rejected)).status, "rejected");
});
test("Cancellation, expired leases and unavailable published-agent references are explicit", async () => {
  const cancelled = await run(simpleWorkflow, { versionId: simpleVersion });
  assert.equal(
    (await call("POST", `/workflow-runs/${cancelled}/cancel`)).statusCode,
    200,
  );
  assert.equal((await inspect(cancelled)).status, "cancelled");
  const recovery = await run(simpleWorkflow, { versionId: simpleVersion });
  const claimed = await claimWorkflowRun();
  assert.equal(claimed?.id, recovery);
  await sql`UPDATE workflow_runs SET lease_expires_at=now()-interval '1 second' WHERE id=${recovery}`;
  await processWorkflowRun({ providerFactory: provider });
  assert.equal((await inspect(recovery)).status, "completed");
  const foreign = graph(
    [
      node("input", "input"),
      node("agent", "agent", { agentVersionId: randomUUID() }),
      node("output", "output"),
    ],
    [
      ["input", "agent"],
      ["agent", "output"],
    ],
  );
  const w = await create("Invalid agent", foreign);
  assert.equal(
    (await call("POST", `/workflows/${w}/publish`, { revision: 1 })).statusCode,
    400,
  );
});

test("Tool nodes use the reviewed registry and link sanitized executions to workflow nodes", async () => {
  const t = await call("POST", `/workspaces/${workspace}/tools`, {
    name: "Workflow lookup",
    description: "Read references",
    config: {
      kind: "http",
      url: `http://127.0.0.1:${toolPort}/reference`,
      queryParameters: ["query"],
    },
    readOnlyAcknowledged: true,
  });
  assert.equal(t.statusCode, 201, t.body);
  const g = graph(
    [
      node("input", "input"),
      node("lookup", "tool", { toolId: t.json().id, inputArgument: "query" }),
      node("final", "agent", { agentVersionId: final }),
      node("output", "output"),
    ],
    [
      ["input", "lookup"],
      ["lookup", "final"],
      ["final", "output"],
    ],
  );
  const w = await create("Tool handoff", g),
    id = await run(w);
  await processWorkflowRun({ providerFactory: provider });
  const r = await inspect(id);
  assert.equal(r.status, "completed", JSON.stringify(r));
  assert(r.output.includes("fixture reference"));
  assert.equal(r.tools.length, 1);
  assert.equal(r.tools[0].workflow_node_id, "lookup");
});
test("Provider errors produce failed node traces and queued cancellation never claims the run", async () => {
  const g = graph(
    [
      node("input", "input"),
      node("agent", "agent", { agentVersionId: research }),
      node("output", "output"),
    ],
    [
      ["input", "agent"],
      ["agent", "output"],
    ],
  );
  const w = await create("Provider failure", g),
    id = await run(w);
  await processWorkflowRun({
    providerFactory: () => ({
      async *stream() {
        throw new Error("sensitive upstream body");
        yield { type: "token", text: "never" };
      },
    }),
  });
  const r = await inspect(id);
  assert.equal(r.status, "failed");
  assert.equal(
    r.nodes.find((n: { node_id: string }) => n.node_id === "agent").status,
    "failed",
  );
  assert(!JSON.stringify(r).includes("sensitive upstream body"));
});

test("Running cancellation aborts the provider and persists terminal run and node status", async () => {
  const g = graph(
    [
      node("input", "input"),
      node("agent", "agent", { agentVersionId: research }),
      node("output", "output"),
    ],
    [
      ["input", "agent"],
      ["agent", "output"],
    ],
  );
  const w = await create("Running cancellation", g),
    id = await run(w);
  let entered!: () => void,
    aborted = false;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const executing = processWorkflowRun({
    providerFactory: () => ({
      async *stream(input) {
        entered();
        yield { type: "token", text: "Partial response" };
        await new Promise<void>((resolve) =>
          input.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        aborted = input.signal.aborted;
        input.signal.throwIfAborted();
      },
    }),
  });
  await started;
  const cancelled = await call("POST", `/workflow-runs/${id}/cancel`, {});
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  await executing;
  const result = await inspect(id);
  assert(aborted);
  assert.equal(result.status, "cancelled");
  assert.equal(result.error_code, "WORKFLOW_CANCELLED");
  assert.equal(
    result.nodes.find((n: { node_id: string }) => n.node_id === "agent").status,
    "cancelled",
  );
  assert(
    !result.nodes.some((n: { node_id: string }) => n.node_id === "output"),
  );
});

test("Starter templates require real agents, validate when configured, and parallel research executes", async () => {
  for (const template of workflowTemplates) {
    assert(
      analyzeWorkflow(workflowFromTemplate(template.id)).errors.some((e) =>
        e.includes("choose an agent"),
      ),
    );
    assert.deepEqual(
      analyzeWorkflow(workflowFromTemplate(template.id, research)).errors,
      [],
    );
  }
  const id = await run(
    await create(
      "Reusable parallel template",
      workflowFromTemplate("parallel-research", research),
    ),
  );
  await processWorkflowRun({ providerFactory: provider });
  const result = await inspect(id);
  assert.equal(result.status, "completed");
  assert.equal(
    result.nodes.filter((n: { kind: string }) => n.kind === "agent").length,
    3,
  );
  assert(
    result.output.includes("research_a") &&
      result.output.includes("research_b"),
  );
  assert.equal(
    workflowGraph.parse(simple()).nodes[0]!.data.retry.maxAttempts,
    1,
  );
  assert(!workflowNodeInvalidRetry());
  function workflowNodeInvalidRetry() {
    return workflowGraph.safeParse({
      ...simple(),
      nodes: [
        node("input", "input", { retry: { maxAttempts: 4 } }),
        node("output", "output"),
      ],
    }).success;
  }
});

test("Step retries recover transient failures without replaying successful agents; permanent errors and limits stop", async () => {
  const g = graph(
    [
      node("input", "input"),
      node("upstream", "agent", { agentVersionId: risk }),
      node("retry", "agent", {
        agentVersionId: research,
        retry: { maxAttempts: 3, delayMs: 100 },
      }),
      node("final", "agent", { agentVersionId: final }),
      node("output", "output"),
    ],
    [
      ["input", "upstream"],
      ["upstream", "retry"],
      ["retry", "final"],
      ["final", "output"],
    ],
  );
  const workflow = await create("Retry recovery", g);
  const calls: Record<string, number> = {};
  const transient: ProviderFactory = (c) => ({
    async *stream() {
      calls[c.modelId] = (calls[c.modelId] ?? 0) + 1;
      if (c.modelId === "research" && calls[c.modelId] === 1)
        throw new ProviderError("PROVIDER_HTTP_ERROR", true, 503);
      yield { type: "token", text: "Recovered answer" };
      yield { type: "usage", inputTokens: 3, outputTokens: 2 };
    },
  });
  const id = await run(workflow);
  await processWorkflowRun({ providerFactory: transient });
  const result = await inspect(id),
    trace = result.nodes.find(
      (n: { node_id: string }) => n.node_id === "retry",
    );
  assert.equal(result.status, "completed");
  assert.equal(calls.research, 2);
  assert.equal(calls.risk, 1);
  assert.equal(calls.final, 1);
  assert.equal(trace.attempts, 2);
  assert.equal(trace.retry_history.length, 1);
  assert.equal(trace.retry_history[0].code, "PROVIDER_HTTP_ERROR");
  assert.equal(trace.retry_at, null);
  for (const retryable of [false, true]) {
    let count = 0;
    const failed = await run(workflow);
    await processWorkflowRun({
      providerFactory: (c) => ({
        async *stream() {
          if (c.modelId === "research") {
            count++;
            throw new ProviderError(
              retryable ? "PROVIDER_HTTP_ERROR" : "AUTHENTICATION_FAILED",
              retryable,
              retryable ? 503 : 401,
            );
          }
          yield { type: "token", text: "Upstream succeeded" };
        },
      }),
    });
    const inspected = await inspect(failed);
    assert.equal(inspected.status, "failed");
    assert.equal(count, retryable ? 3 : 1);
    assert.equal(
      inspected.nodes.find((n: { node_id: string }) => n.node_id === "retry")
        .attempts,
      count,
    );
    assert(
      !inspected.nodes.some((n: { node_id: string }) => n.node_id === "final"),
    );
  }
});

test("Read-only HTTP tool retries record each execution and do not leak upstream bodies", async () => {
  const tool = await call("POST", `/workspaces/${workspace}/tools`, {
    name: "Retry lookup",
    description: "Read references",
    config: {
      kind: "http",
      url: `http://127.0.0.1:${toolPort}/reference`,
      queryParameters: ["query"],
    },
    readOnlyAcknowledged: true,
  });
  assert.equal(tool.statusCode, 201, tool.body);
  const g = graph(
    [
      node("input", "input"),
      node("lookup", "tool", {
        toolId: tool.json().id,
        inputArgument: "query",
        retry: { maxAttempts: 2, delayMs: 100 },
      }),
      node("output", "output"),
    ],
    [
      ["input", "lookup"],
      ["lookup", "output"],
    ],
  );
  toolFailures = 1;
  const id = await run(await create("Retry tool", g));
  await processWorkflowRun();
  const result = await inspect(id);
  assert.equal(result.status, "completed");
  assert.equal(result.tools.length, 2);
  assert.equal(
    result.nodes.find((n: { node_id: string }) => n.node_id === "lookup")
      .attempts,
    2,
  );
  assert(!JSON.stringify(result).includes("temporary outage"));
});

test("Workflow result presentation supports structured fields and bounded tables without changing output", () => {
  assert.equal(workflowPresentation("Plain answer").kind, "text");
  assert.deepEqual(workflowPresentation('{"case_number":"ABC"}').fields, [
    { label: "Case number", value: "ABC" },
  ]);
  const rows = Array.from({ length: 101 }, (_, i) => ({
    branch_name: "Branch " + i,
    hours: "9–5",
  }));
  const p = workflowPresentation(rows);
  assert.equal(p.kind, "table");
  assert.equal(p.rows!.length, 100);
  assert(p.truncated);
  assert.equal(rows.length, 101);
  assert.equal(workflowPresentation(rows, "json").kind, "json");
  assert.equal(
    workflowPresentation("<script>untrusted</script>").text,
    "<script>untrusted</script>",
  );
});

test("Cancellation during retry backoff aborts waiting and never makes the next attempt", async () => {
  const g = graph(
    [
      node("input", "input"),
      node("agent", "agent", {
        agentVersionId: research,
        retry: { maxAttempts: 3, delayMs: 10000 },
      }),
      node("output", "output"),
    ],
    [
      ["input", "agent"],
      ["agent", "output"],
    ],
  );
  const id = await run(await create("Cancel backoff", g));
  let calls = 0;
  const executing = processWorkflowRun({
    providerFactory: () => ({
      async *stream() {
        calls++;
        throw new ProviderError("PROVIDER_HTTP_ERROR", true, 503);
      },
    }),
  });
  const deadline = Date.now() + 3000;
  while (true) {
    const [n] =
      await sql`SELECT retry_at FROM workflow_node_runs WHERE run_id=${id} AND node_id='agent'`;
    if (n?.retry_at) break;
    if (Date.now() > deadline) throw new Error("Retry did not enter backoff");
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(
    (await call("POST", `/workflow-runs/${id}/cancel`, {})).statusCode,
    200,
  );
  await executing;
  const result = await inspect(id);
  assert.equal(result.status, "cancelled");
  assert.equal(calls, 1);
  assert.equal(
    result.nodes.find((n: { node_id: string }) => n.node_id === "agent")
      .retry_at,
    null,
  );
  assert(
    !result.nodes.some((n: { node_id: string }) => n.node_id === "output"),
  );
});

test("Workflow agents continue after optional attachment revocation while explicit tool nodes remain mandatory", async () => {
  const [tool] =
    await sql`SELECT id FROM tools WHERE workspace_id=${workspace} AND enabled=true AND archived_at IS NULL LIMIT 1`;
  assert(tool);
  const [source] = await sql`SELECT * FROM agent_versions WHERE id=${research}`;
  const snapshot = agentConfig.parse(source!.config);
  snapshot.tools = {
    ...snapshot.tools,
    toolIds: [tool.id],
    usageMode: "automatic",
  };
  const versionId = randomUUID();
  await sql`INSERT INTO agent_versions(id,agent_id,workspace_id,organization_id,version,name,public_description,config,model_snapshot,model_id,published_by) SELECT ${versionId},agent_id,workspace_id,organization_id,99,name,public_description,${sql.json(snapshot)},model_snapshot,model_id,published_by FROM agent_versions WHERE id=${research}`;
  const agentWorkflow = await create(
    "Optional tools workflow",
    graph(
      [
        node("input", "input"),
        node("agent", "agent", { agentVersionId: versionId }),
        node("output", "output"),
      ],
      [
        ["input", "agent"],
        ["agent", "output"],
      ],
    ),
  );
  const toolWorkflow = await create(
    "Explicit tool workflow",
    graph(
      [
        node("input", "input"),
        node("tool", "tool", { toolId: tool.id }),
        node("output", "output"),
      ],
      [
        ["input", "tool"],
        ["tool", "output"],
      ],
    ),
  );
  const [before] =
    await sql`SELECT count(*)::int AS count FROM tool_executions WHERE tool_id=${tool.id}`;
  try {
    await sql`UPDATE tools SET enabled=false WHERE id=${tool.id}`;
    const id = await run(agentWorkflow);
    await processWorkflowRun({ providerFactory: provider });
    const result = await inspect(id);
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.output, "research: refund policy");
    const { validateWorkflowDependencies } =
      await import("../src/workflow-runtime.js");
    const [savedGraph] =
      await sql`SELECT draft_graph FROM workflows WHERE id=${agentWorkflow}`;
    await assert.rejects(
      validateWorkflowDependencies(
        workflowGraph.parse(savedGraph!.draft_graph),
        { workspaceId: workspace, organizationId: org },
      ),
      { code: "TOOL_UNAVAILABLE" },
    );
    await validateWorkflowDependencies(
      workflowGraph.parse(savedGraph!.draft_graph),
      { workspaceId: workspace, organizationId: org, publicAccess: true },
      true,
    );
    const [after] =
      await sql`SELECT count(*)::int AS count FROM tool_executions WHERE tool_id=${tool.id}`;
    assert.equal(after!.count, before!.count);
    const required = await call("POST", `/workflows/${toolWorkflow}/runs`, {
      input: "lookup",
      revision: 1,
    });
    assert.equal(required.statusCode, 400);
    assert.equal(required.json().error, "TOOL_UNAVAILABLE");
  } finally {
    await sql`UPDATE tools SET enabled=true WHERE id=${tool.id}`;
  }
});

test("workspace components version independently, enforce ownership and expand into executable snapshots", async () => {
  const { extractComponent, insertComponent } =
    await import("@agentconnect/schemas/workflow-components");
  const original = graph(
    [
      node("input", "input"),
      node("research", "agent", { agentVersionId: research }),
      node("output", "output"),
    ],
    [
      ["input", "research"],
      ["research", "output"],
    ],
  );
  const component = extractComponent(original, ["research"]);
  assert.throws(
    () => extractComponent(original, ["input", "research"]),
    /exclude Input/,
  );
  const first = await call(
    "POST",
    `/workspaces/${workspace}/workflow-components`,
    { name: "Reusable research", graph: component },
  );
  assert.equal(first.statusCode, 201, first.body);
  const cid = first.json().id;
  assert.equal(
    (
      await call(
        "GET",
        `/workflow-components/${cid}/versions`,
        undefined,
        sessions.outsider,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "POST",
        `/workflow-components/${cid}/versions`,
        { name: "Blocked", graph: component, revision: 1 },
        sessions.viewer,
      )
    ).statusCode,
    403,
  );
  const inserted = insertComponent(simple(), component, "input", "copy");
  assert.deepEqual(analyzeWorkflow(inserted).errors, []);
  assert.equal(
    inserted.nodes.find((n) => n.id === "copy_0")!.data.agentVersionId,
    research,
  );
  assert.throws(
    () => insertComponent(simple(), component, "output", "bad"),
    /single output/,
  );
  const next = structuredClone(component);
  next.nodes[0]!.data.prefix = "New library behavior ";
  const body = { name: "Reusable research v2", graph: next, revision: 1 };
  const saves = await Promise.all([
    call("POST", `/workflow-components/${cid}/versions`, body),
    call("POST", `/workflow-components/${cid}/versions`, body),
  ]);
  assert.deepEqual(saves.map((r) => r.statusCode).sort(), [201, 409]);
  const history = (
    await call("GET", `/workflow-components/${cid}/versions`)
  ).json();
  assert.deepEqual(
    history.map((v: { version: number }) => v.version),
    [2, 1],
  );
  assert.equal(inserted.nodes.find((n) => n.id === "copy_0")!.data.prefix, "");
  const wid = await create("Component copy", inserted),
    runId = await run(wid);
  await processWorkflowRun({ providerFactory: provider });
  assert.equal((await inspect(runId)).status, "completed");
  const foreign = structuredClone(component);
  foreign.nodes[0]!.data.agentVersionId = randomUUID();
  assert.equal(
    (
      await call("POST", `/workspaces/${workspace}/workflow-components`, {
        name: "Foreign",
        graph: foreign,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await call("DELETE", `/workflow-components/${cid}`)).statusCode,
    200,
  );
  assert.equal(
    (await call("GET", `/workflow-components/${cid}/versions`)).statusCode,
    404,
  );
  assert.equal(
    (await call("GET", `/workspaces/${workspace}/workflow-components`))
      .json()
      .some((c: { id: string }) => c.id === cid),
    false,
  );
  assert.deepEqual(analyzeWorkflow(inserted).errors, []);
});

test("field mappings execute against typed inputs and persist explicit missing-field failures", async () => {
  const g = graph(
    [
      node("input", "input"),
      node("mapped", "merge", {
        inputBindings: [
          { target: "name", source: "input", path: "/customer/name" },
          { target: "amount", source: "input", path: "/items/0/amount" },
        ],
      }),
      node("output", "output", { inputPath: "/amount" }),
    ],
    [
      ["input", "mapped"],
      ["mapped", "output"],
    ],
  );
  g.inputFields = [
    { name: "customer", label: "Customer", type: "json", required: true },
    { name: "items", label: "Items", type: "json", required: true },
  ];
  const w = await create("Mapped input", g),
    id = await run(w, {
      input: { customer: { name: "A" }, items: [{ amount: 12 }] },
    });
  await processWorkflowRun();
  const r = await inspect(id);
  assert.equal(r.status, "completed", JSON.stringify(r));
  assert.equal(r.output, 12);
  assert.deepEqual(
    r.nodes.find((n: { node_id: string }) => n.node_id === "mapped").input,
    { name: "A", amount: 12 },
  );
  const missing = await run(w, {
    input: { customer: { name: "A" }, items: [] },
  });
  await processWorkflowRun();
  const failed = await inspect(missing);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error_code, "WORKFLOW_MAPPING_FIELD_MISSING");
  assert.equal(
    failed.nodes.find((n: { node_id: string }) => n.node_id === "mapped")
      .status,
    "failed",
  );
  assert(
    !failed.nodes.some((n: { node_id: string }) => n.node_id === "output"),
  );
});
test("field mappings reach agents as selected content and tool arguments keep declared types", async () => {
  const t = await call("POST", `/workspaces/${workspace}/tools`, {
    name: "Mapped lookup",
    description: "Read references",
    config: {
      kind: "http",
      url: `http://127.0.0.1:${toolPort}/reference`,
      queryParameters: ["query"],
    },
    readOnlyAcknowledged: true,
  });
  assert.equal(t.statusCode, 201, t.body);
  const g = graph(
    [
      node("input", "input"),
      node("lookup", "tool", {
        toolId: t.json().id,
        inputBindings: [{ target: "query", source: "input", path: "/query" }],
      }),
      node("agent", "agent", {
        agentVersionId: final,
        inputFrom: "input",
        inputPath: "/query",
      }),
      node("output", "output"),
    ],
    [
      ["input", "lookup"],
      ["lookup", "agent"],
      ["agent", "output"],
    ],
  );
  g.inputFields = [
    { name: "query", label: "Query", type: "text", required: true },
    { name: "private_notes", label: "Notes", type: "text", required: false },
  ];
  const w = await create("Mapped agent and tool", g),
    id = await run(w, {
      input: {
        query: "Selected query",
        private_notes: "Do not forward this field",
      },
    });
  await processWorkflowRun({ providerFactory: provider });
  const r = await inspect(id);
  assert.equal(r.status, "completed", JSON.stringify(r));
  assert(r.output.includes("Selected query"));
  assert(!r.output.includes("Do not forward"));
  assert.deepEqual(r.tools[0].arguments, { query: "Selected query" });
});

test("Workflow-owned agents run without an Agents entry and pin model settings on publication", async () => {
  const m = await call("POST", `/workspaces/${workspace}/models`, {
    name: "Embedded agent model",
    provider: "openai-compatible",
    modelId: "embedded-original",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.equal(m.statusCode, 201, m.body);
  const beforeAgents = await call("GET", `/workspaces/${workspace}/agents`);
  const g = graph(
    [
      node("input", "input"),
      node("embedded", "agent", {
        inlineAgent: agentConfig.parse({
          modelId: m.json().id,
          prompt: { instructions: "Summarize the input" },
        }),
        inlineModelSnapshot: { modelId: "untrusted-client-model" },
      }),
      node("output", "output"),
    ],
    [
      ["input", "embedded"],
      ["embedded", "output"],
    ],
  );
  assert.deepEqual(analyzeWorkflow(g).errors, []);
  const workflowId = await create("Independent workflow agent", g);
  const published = await call("POST", `/workflows/${workflowId}/publish`, {
    revision: 1,
  });
  assert.equal(published.statusCode, 201, published.body);
  await sql`UPDATE model_configurations SET model_id='embedded-updated' WHERE id=${m.json().id}`;
  const runId = await run(workflowId, { versionId: published.json().id });
  const queued = await inspect(runId);
  assert.equal(
    queued.graph_snapshot.nodes[1].data.inlineModelSnapshot.modelId,
    "embedded-original",
  );
  await processWorkflowRun({ providerFactory: provider });
  const completed = await inspect(runId);
  assert.equal(completed.status, "completed");
  assert.match(JSON.stringify(completed.output), /embedded-original/);
  const afterAgents = await call("GET", `/workspaces/${workspace}/agents`);
  assert.equal(afterAgents.json().length, beforeAgents.json().length);
  const draftRun = await run(workflowId);
  assert.equal(
    (await inspect(draftRun)).graph_snapshot.nodes[1].data.inlineModelSnapshot
      .modelId,
    "embedded-updated",
  );
  await call("POST", `/workflow-runs/${draftRun}/cancel`);
});

test("Workflow-owned agents reject unavailable workspace resources and ambiguous sources", async () => {
  const g = graph(
    [
      node("input", "input"),
      node("embedded", "agent", {
        inlineAgent: agentConfig.parse({ modelId: randomUUID() }),
      }),
      node("output", "output"),
    ],
    [
      ["input", "embedded"],
      ["embedded", "output"],
    ],
  );
  const workflowId = await create("Invalid embedded model", g);
  const response = await call("POST", `/workflows/${workflowId}/publish`, {
    revision: 1,
  });
  assert.equal(response.statusCode, 400, response.body);
  g.nodes[1]!.data.agentVersionId = research;
  assert.ok(
    analyzeWorkflow(g).errors.some((e) =>
      e.includes("choose one agent source"),
    ),
  );
});
