import { initializeTelemetry, shutdownTelemetry } from "./telemetry.js";
initializeTelemetry("agentconnex-api");
const { buildApp } = await import("./app.js");
const { config } = await import("./config.js");
const app = await buildApp({ runMessagingWorker: true });
await app.listen({ host: "0.0.0.0", port: config.PORT });
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await app.close();
    await shutdownTelemetry();
    process.exit(0);
  });
