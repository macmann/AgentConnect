import "./telemetry.js";
const { buildApp } = await import("./app.js");
const { config } = await import("./config.js");
const app = await buildApp();
await app.listen({ host: "0.0.0.0", port: config.PORT });
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
