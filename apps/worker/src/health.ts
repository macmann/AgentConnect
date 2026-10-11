import { createServer } from "node:http";
import {
  monitoringAuthorized,
  type WorkerProgress,
} from "@agentconnect/api/monitoring-core";
export function workerHealth(progress: WorkerProgress, token?: string) {
  return createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (req.url === "/health/live") {
      res.writeHead(200);
      res.end('{"status":"ok"}');
      return;
    }
    if (req.url === "/health/ready") {
      const ready = progress.ready();
      res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: ready ? "ready" : "unavailable" }));
      return;
    }
    if (req.url === "/internal/metrics" && token) {
      if (!monitoringAuthorized(req.headers.authorization, token)) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      });
      res.end(progress.render());
      return;
    }
    res.writeHead(404);
    res.end();
  });
}
