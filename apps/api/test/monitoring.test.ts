import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  HttpMetrics,
  WorkerProgress,
  workerTaskNames,
  monitoringAuthorized,
} from "../src/monitoring-core.js";
import { queueMonitoring, registerMonitoring } from "../src/monitoring.js";
import { workerHealth } from "../../worker/src/health.js";
const token = "fixture-monitoring-token-32-characters";
test("Monitoring authentication requires the exact bearer and can be disabled", () => {
  assert.equal(monitoringAuthorized(`Bearer ${token}`, token), true);
  for (const header of [
    undefined,
    token,
    `Bearer ${token}x`,
    "Bearer wrong",
    [token],
  ])
    assert.equal(monitoringAuthorized(header, token), false);
  assert.equal(monitoringAuthorized(`Bearer ${token}`), false);
});
test("HTTP metrics use bounded methods/statuses, escape templates, and cumulative duration buckets", () => {
  const metrics = new HttpMetrics();
  metrics.record("/agents/:id/chat", "POST", 200, 0.2);
  metrics.record("/agents/:id/chat", "POST", 200, 2);
  const output = metrics.render();
  assert.match(
    output,
    /requests_total\{route="\/agents\/:id\/chat",method="POST",status="2xx"\} 2/,
  );
  assert.match(output, /le="0.5"\} 1/);
  assert.match(output, /le="5"\} 2/);
  assert.match(output, /le="\+Inf"\} 2/);
  assert(!output.includes("user"));
});
test("Worker readiness requires every loop to progress and detects repeated failures, stalls and shutdown", () => {
  let now = 1000000;
  const progress = new WorkerProgress(300, () => now);
  assert.equal(progress.ready(), false);
  for (const task of workerTaskNames) progress.complete(task, true, 5);
  assert.equal(progress.ready(), true);
  for (let i = 0; i < 3; i++) progress.complete("mail", false, 7);
  assert.equal(progress.ready(), false);
  assert.match(progress.render(), /task_errors_total\{task="mail"\} 3/);
  progress.complete("mail", true, 5);
  assert.equal(progress.ready(), true);
  now += 301000;
  assert.equal(progress.ready(), false);
  for (const task of workerTaskNames) progress.complete(task, true, 5);
  progress.stopping = true;
  assert.equal(progress.ready(), false);
});
test("Worker health serves real progress, protects metrics and emits no task internals on readiness", async () => {
  const progress = new WorkerProgress(300),
    server = workerHealth(progress, token);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await fetch(`${base}/health/live`)).status, 200);
    assert.equal((await fetch(`${base}/health/ready`)).status, 503);
    assert.equal((await fetch(`${base}/internal/metrics`)).status, 401);
    for (const task of workerTaskNames) progress.complete(task, true, 5);
    const ready = await fetch(`${base}/health/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ready" });
    const metrics = await fetch(`${base}/internal/metrics`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /agentconnect_worker_ready 1/);
  } finally {
    await new Promise<void>((r, e) =>
      server.close((error) => (error ? e(error) : r())),
    );
  }
});
test("Queue monitoring queries actual schema, coalesces scrapes and exports only aggregates", async () => {
  const queues = queueMonitoring();
  try {
    const values = await Promise.all([queues.collect(), queues.collect()]);
    assert.equal(values[0], values[1]);
    assert.match(values[0]!, /queue="knowledge",state="pending"/);
    assert.match(values[0]!, /queue="retention_objects",state="blocked"/);
    assert(!values[0]!.includes("workspace"));
    assert(!values[0]!.includes("recipient"));
  } finally {
    await queues.close();
  }
});
test("API metrics are opt-in, authenticated, use registered routes and report unavailable collection safely", async () => {
  const app = Fastify();
  registerMonitoring(
    app,
    async () => ({ status: "unavailable", service: "storage" }),
    token,
  );
  app.get("/example/:id", async () => ({ ok: true }));
  try {
    assert.equal(
      (await app.inject({ url: "/internal/metrics" })).statusCode,
      401,
    );
    await app.inject({ url: "/example/private-customer-value" });
    const result = await app.inject({
      url: "/internal/metrics",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.match(result.body, /agentconnect_api_ready 0/);
    assert.match(result.body, /route="\/example\/:id"/);
    assert(!result.body.includes("private-customer-value"));
    assert.equal(result.headers["cache-control"], "no-store");
  } finally {
    await app.close();
  }
  const disabled = Fastify();
  registerMonitoring(
    disabled,
    async () => ({ status: "unavailable", service: "storage" }),
    undefined,
  );
  try {
    assert.equal(
      (await disabled.inject({ url: "/internal/metrics" })).statusCode,
      404,
    );
  } finally {
    await disabled.close();
  }
});

test("Failed collection returns 503 without upstream errors or stale success", async () => {
  const app = Fastify();
  registerMonitoring(
    app,
    async () => ({ status: "unavailable", service: "postgres" }),
    token,
    {
      collect: async () => {
        throw new Error("credential-value-and-private-db-host");
      },
      close: async () => {},
    },
  );
  try {
    const result = await app.inject({
      url: "/internal/metrics",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(result.statusCode, 503);
    assert.equal(result.body, "agentconnect_metrics_collection_success 0\n");
    assert(!result.body.includes("credential-value"));
  } finally {
    await app.close();
  }
});
