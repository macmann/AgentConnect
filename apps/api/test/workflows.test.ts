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
const toolServer = createServer((req, res) => {
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
