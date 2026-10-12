import { initializeTelemetry } from "@agentconnect/api/telemetry";
initializeTelemetry("agentconnex-worker");
await import("./worker.js");
