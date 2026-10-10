export const readinessServices = [
  "postgres",
  "redis",
  "storage",
  "temporal",
] as const;
export type ReadinessService = (typeof readinessServices)[number];
export type ReadinessChecks = Record<
  ReadinessService,
  (signal: AbortSignal) => Promise<unknown>
>;
export type ReadinessResult =
  | { status: "ready"; services: typeof readinessServices }
  | { status: "unavailable"; service: ReadinessService };

// Share concurrent probes and briefly cache the result, including failures.
// Timeouts cannot be turned into successful probes by a late resolution.
export function createReadinessProbe(
  checks: ReadinessChecks,
  timeoutMs = 5000,
  cacheMs = 2000,
) {
  let inFlight: Promise<ReadinessResult> | undefined,
    cached: ReadinessResult | undefined,
    expires = 0;
  return function probe(): Promise<ReadinessResult> {
    if (cached && Date.now() < expires) return Promise.resolve(cached);
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const outcomes = await Promise.all(
        readinessServices.map(async (service) => {
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              Promise.resolve().then(() => checks[service](controller.signal)),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(new Error("Readiness deadline"));
                }, timeoutMs);
              }),
            ]);
            return true;
          } catch {
            return false;
          } finally {
            if (timer) clearTimeout(timer);
          }
        }),
      );
      const failed = outcomes.indexOf(false);
      const result: ReadinessResult =
        failed < 0
          ? { status: "ready", services: readinessServices }
          : { status: "unavailable", service: readinessServices[failed]! };
      cached = result;
      expires = Date.now() + cacheMs;
      return result;
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
