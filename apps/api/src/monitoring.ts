import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import type { ReadinessResult } from "./readiness.js";
import { config } from "./config.js";
import {
  HttpMetrics,
  monitoringAuthorized,
  sample,
} from "./monitoring-core.js";

export function queueMonitoring(databaseUrl = config.DATABASE_URL) {
  const db = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 2,
    idle_timeout: 2,
    connection: {
      statement_timeout: 2000,
      application_name: "agentconnect-monitoring",
    },
  });
  let failedUntil = 0;
  let cached = "",
    expires = 0,
    pending: Promise<string> | undefined;
  async function query() {
    // Fixed table/state labels only. This operational endpoint aggregates all
    // tenants and never returns identifiers, content, URLs or arbitrary errors.
    const rows = await db<
      {
        queue: string;
        pending: number;
        running: number;
        failed: number;
        oldest: number;
      }[]
    >`
      SELECT 'knowledge' AS queue, count(*) FILTER (WHERE status='queued')::int AS pending, count(*) FILTER (WHERE status='running')::int AS running, count(*) FILTER (WHERE status='failed' AND finished_at > now()-interval '24 hours')::int AS failed, coalesce(extract(epoch FROM now()-min(created_at) FILTER (WHERE status='queued' AND available_at<=now())),0)::float AS oldest FROM knowledge_jobs
      UNION ALL SELECT 'workflow',count(*) FILTER (WHERE status='queued')::int,count(*) FILTER (WHERE status='running')::int,count(*) FILTER (WHERE status='failed' AND finished_at>now()-interval '24 hours')::int,coalesce(extract(epoch FROM now()-min(created_at) FILTER (WHERE status='queued')),0)::float FROM workflow_runs
      UNION ALL SELECT 'evaluation',count(*) FILTER (WHERE status='queued')::int,count(*) FILTER (WHERE status='running')::int,count(*) FILTER (WHERE status='failed' AND finished_at>now()-interval '24 hours')::int,coalesce(extract(epoch FROM now()-min(created_at) FILTER (WHERE status='queued')),0)::float FROM evaluation_runs
      UNION ALL SELECT 'connector',count(*) FILTER (WHERE status='queued')::int,count(*) FILTER (WHERE status='running')::int,count(*) FILTER (WHERE status='failed' AND finished_at>now()-interval '24 hours')::int,coalesce(extract(epoch FROM now()-min(created_at) FILTER (WHERE status='queued')),0)::float FROM connector_syncs
      UNION ALL SELECT 'webhook',count(*) FILTER (WHERE status='pending')::int,count(*) FILTER (WHERE status='sending')::int,count(*) FILTER (WHERE status='failed' AND created_at>now()-interval '24 hours')::int,coalesce(extract(epoch FROM now()-min(created_at) FILTER (WHERE status='pending' AND next_attempt_at<=now())),0)::float FROM webhook_deliveries
      UNION ALL SELECT 'mail',count(*) FILTER (WHERE sent_at IS NULL)::int,0,0,coalesce(extract(epoch FROM now()-min(created_at) FILTER (WHERE sent_at IS NULL)),0)::float FROM mail_outbox
      UNION ALL SELECT 'retention',count(*) FILTER (WHERE status='queued')::int,0,count(*) FILTER (WHERE status='failed' AND finished_at>now()-interval '24 hours')::int,coalesce(extract(epoch FROM now()-min(created_at) FILTER (WHERE status='queued')),0)::float FROM retention_runs
      UNION ALL SELECT 'support_triage',count(*) FILTER (WHERE triage_status='pending')::int,count(*) FILTER (WHERE triage_status='running')::int,count(*) FILTER (WHERE triage_status='failed')::int,coalesce(extract(epoch FROM now()-min(created_at) FILTER (WHERE triage_status='pending')),0)::float FROM support_cases
      UNION ALL SELECT 'retention_objects',count(*) FILTER (WHERE status='pending')::int,0,count(*) FILTER (WHERE status='blocked')::int,coalesce(extract(epoch FROM now()-min(created_at) FILTER (WHERE status='pending' AND next_attempt_at<=now())),0)::float FROM retention_object_deletions
    `;
    let output =
      "# TYPE agentconnect_queue_jobs gauge\n# TYPE agentconnect_queue_failures_24h gauge\n# TYPE agentconnect_queue_oldest_due_age_seconds gauge\n# TYPE agentconnect_agent_runs_1h gauge\n";
    for (const r of rows) {
      output += sample(
        "agentconnect_queue_jobs",
        { queue: r.queue, state: "pending" },
        r.pending,
      );
      if (!["mail", "retention", "retention_objects"].includes(r.queue))
        output += sample(
          "agentconnect_queue_jobs",
          { queue: r.queue, state: "running" },
          r.running,
        );
      if (r.queue === "retention_objects")
        output += sample(
          "agentconnect_queue_jobs",
          { queue: r.queue, state: "blocked" },
          r.failed,
        );
      else if (r.queue === "support_triage")
        output += sample(
          "agentconnect_queue_jobs",
          { queue: r.queue, state: "failed" },
          r.failed,
        );
      else if (r.queue !== "mail")
        output += sample(
          "agentconnect_queue_failures_24h",
          { queue: r.queue },
          r.failed,
        );
      output += sample(
        "agentconnect_queue_oldest_due_age_seconds",
        { queue: r.queue },
        Math.max(0, r.oldest),
      );
    }
    const runs = await db<
      { status: string; count: number }[]
    >`SELECT status,count(*)::int FROM agent_runs WHERE finished_at>now()-interval '1 hour' GROUP BY status`;
    for (const status of ["completed", "failed", "cancelled"])
      output += sample(
        "agentconnect_agent_runs_1h",
        { status },
        runs.find((r) => r.status === status)?.count ?? 0,
      );
    return output;
  }
  return {
    async collect() {
      if (Date.now() < expires) return cached;
      if (Date.now() < failedUntil) throw new Error("METRICS_UNAVAILABLE");
      if (!pending)
        pending = query()
          .then((value) => {
            cached = value;
            expires = Date.now() + 15000;
            return value;
          })
          .catch((error) => {
            failedUntil = Date.now() + 5000;
            throw error;
          })
          .finally(() => {
            pending = undefined;
          });
      return pending;
    },
    close: () => db.end({ timeout: 3 }),
  };
}
export function registerMonitoring(
  app: FastifyInstance,
  probe: () => Promise<ReadinessResult>,
  token = config.MONITORING_TOKEN,
  collector?: ReturnType<typeof queueMonitoring>,
) {
  if (!token) return;
  const http = new HttpMetrics(),
    queues = collector ?? queueMonitoring();
  app.addHook("onResponse", async (r, reply) => {
    const route = r.routeOptions.url ?? "unmatched";
    if (!route.startsWith("/health/") && route !== "/internal/metrics")
      http.record(route, r.method, reply.statusCode, reply.elapsedTime / 1000);
  });
  app.get(
    "/internal/metrics",
    { config: { rateLimit: false }, schema: { hide: true } },
    async (r, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!monitoringAuthorized(r.headers.authorization, token))
        return reply.code(401).send({ error: "Access denied" });
      try {
        const [queuesText, ready] = await Promise.all([
          queues.collect(),
          probe(),
        ]);
        return reply
          .type("text/plain; version=0.0.4; charset=utf-8")
          .send(
            http.render() +
              queuesText +
              sample(
                "agentconnect_api_ready",
                {},
                ready.status === "ready" ? 1 : 0,
              ) +
              sample("agentconnect_metrics_collection_success", {}, 1),
          );
      } catch {
        return reply
          .code(503)
          .type("text/plain; version=0.0.4; charset=utf-8")
          .send(sample("agentconnect_metrics_collection_success", {}, 0));
      }
    },
  );
  app.addHook("onClose", () => queues.close());
}
