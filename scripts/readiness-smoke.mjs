// Read-only local concurrency smoke. This measures probes, not agent throughput.
const endpoint = new URL(process.argv[2] ?? "http://localhost:4000");
if (
  !["http:", "https:"].includes(endpoint.protocol) ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash ||
  endpoint.pathname !== "/"
)
  throw new Error("Supply only the API origin");
const durations = [],
  failures = [];
let next = 0;
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (next++ < 40) {
      const start = performance.now();
      try {
        const response = await fetch(new URL("/health/ready", endpoint), {
          signal: AbortSignal.timeout(6500),
          redirect: "error",
        });
        const body = await response.json();
        if (
          response.status !== 200 ||
          body.status !== "ready" ||
          JSON.stringify(body.services) !==
            JSON.stringify(["postgres", "redis", "storage", "temporal"])
        )
          throw new Error("Probe failed");
        durations.push(performance.now() - start);
      } catch {
        failures.push(true);
      }
    }
  }),
);
durations.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    requests: 40,
    concurrency: 8,
    passed: durations.length,
    failed: failures.length,
    p50Ms: Math.round(durations[Math.floor(durations.length * 0.5)] ?? 0),
    p95Ms: Math.round(
      durations[
        Math.min(durations.length - 1, Math.floor(durations.length * 0.95))
      ] ?? 0,
    ),
  }),
);
if (failures.length) process.exitCode = 1;
