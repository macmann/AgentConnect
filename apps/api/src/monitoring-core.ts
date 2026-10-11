import { createHash, timingSafeEqual } from "node:crypto";
export function monitoringAuthorized(header: unknown, token?: string) {
  if (!token || typeof header !== "string") return false;
  return timingSafeEqual(
    createHash("sha256").update(header).digest(),
    createHash("sha256").update(`Bearer ${token}`).digest(),
  );
}
const label = (s: string) =>
  s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
export function sample(
  name: string,
  labels: Record<string, string>,
  value: number,
) {
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid metric");
  const suffix = Object.entries(labels)
    .map(([k, v]) => `${k}="${label(v)}"`)
    .join(",");
  return `${name}${suffix ? `{${suffix}}` : ""} ${value}\n`;
}
export class HttpMetrics {
  private rows = new Map<
    string,
    {
      route: string;
      method: string;
      status: string;
      count: number;
      sum: number;
      buckets: number[];
    }
  >();
  readonly bounds = [0.05, 0.1, 0.5, 1, 5, 30];
  record(route: string, method: string, code: number, seconds: number) {
    // The caller supplies the registered route template, never a request URL.
    const status = `${Math.min(5, Math.max(1, Math.floor(code / 100)))}xx`;
    const verb = [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "OPTIONS",
    ].includes(method)
      ? method
      : "OTHER";
    const key = JSON.stringify([route, verb, status]);
    const row = this.rows.get(key) ?? {
      route,
      method: verb,
      status,
      count: 0,
      sum: 0,
      buckets: this.bounds.map(() => 0),
    };
    const duration = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    row.count++;
    row.sum += duration;
    this.bounds.forEach((b, i) => {
      if (duration <= b) row.buckets[i] = row.buckets[i]! + 1;
    });
    this.rows.set(key, row);
  }
  render() {
    let output =
      "# TYPE agentconnect_http_requests_total counter\n# TYPE agentconnect_http_request_duration_seconds histogram\n";
    for (const row of this.rows.values()) {
      const labels = {
        route: row.route,
        method: row.method,
        status: row.status,
      };
      output += sample("agentconnect_http_requests_total", labels, row.count);
      this.bounds.forEach((b, i) => {
        output += sample(
          "agentconnect_http_request_duration_seconds_bucket",
          { ...labels, le: String(b) },
          row.buckets[i]!,
        );
      });
      output += sample(
        "agentconnect_http_request_duration_seconds_bucket",
        { ...labels, le: "+Inf" },
        row.count,
      );
      output += sample(
        "agentconnect_http_request_duration_seconds_count",
        labels,
        row.count,
      );
      output += sample(
        "agentconnect_http_request_duration_seconds_sum",
        labels,
        row.sum,
      );
    }
    return output;
  }
}
export const workerTaskNames = [
  "support_triage",
  "support_operations",
  "support_routing",
  "retention_cleanup",
  "retention_objects",
  "connector_sync",
  "evaluation",
  "workflow",
  "mail",
  "webhook",
  "knowledge",
  "knowledge_cleanup",
] as const;
export type WorkerTaskName = (typeof workerTaskNames)[number];
export class WorkerProgress {
  private rows = new Map(
    workerTaskNames.map((task) => [
      task,
      { completedAt: 0, failures: 0, iterations: 0, errors: 0, duration: 0 },
    ]),
  );
  stopping = false;
  constructor(
    private stallSeconds: number,
    private now = Date.now,
  ) {}
  complete(task: WorkerTaskName, success: boolean, duration: number) {
    const row = this.rows.get(task)!;
    row.completedAt = this.now();
    row.iterations++;
    row.duration = Math.max(0, duration);
    row.failures = success ? 0 : row.failures + 1;
    if (!success) row.errors++;
  }
  ready() {
    return (
      !this.stopping &&
      [...this.rows.values()].every(
        (r) =>
          r.completedAt > 0 &&
          this.now() - r.completedAt < this.stallSeconds * 1000 &&
          r.failures < 3,
      )
    );
  }
  render() {
    let output =
      "# TYPE agentconnect_worker_ready gauge\n# TYPE agentconnect_worker_task_iterations_total counter\n# TYPE agentconnect_worker_task_errors_total counter\n# TYPE agentconnect_worker_task_last_completed_timestamp_seconds gauge\n# TYPE agentconnect_worker_task_consecutive_failures gauge\n# TYPE agentconnect_worker_task_last_duration_seconds gauge\n" +
      sample("agentconnect_worker_ready", {}, this.ready() ? 1 : 0);
    for (const [task, row] of this.rows) {
      output += sample(
        "agentconnect_worker_task_last_completed_timestamp_seconds",
        { task },
        row.completedAt / 1000,
      );
      output += sample(
        "agentconnect_worker_task_consecutive_failures",
        { task },
        row.failures,
      );
      output += sample(
        "agentconnect_worker_task_iterations_total",
        { task },
        row.iterations,
      );
      output += sample(
        "agentconnect_worker_task_errors_total",
        { task },
        row.errors,
      );
      output += sample(
        "agentconnect_worker_task_last_duration_seconds",
        { task },
        row.duration / 1000,
      );
    }
    return output;
  }
}
