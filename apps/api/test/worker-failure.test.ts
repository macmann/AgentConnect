import { test } from "node:test";
import assert from "node:assert/strict";
import { workerFailure } from "../../worker/src/failure.js";
test("Worker failures explain schema and connection errors without exposing raw error details", () => {
  const schema = workerFailure(
    { code: "42P01", message: "sensitive connection string" },
    "Workflow execution",
  );
  assert.match(schema, /pnpm db:migrate/);
  assert.match(schema, /42P01/);
  assert(!schema.includes("sensitive"));
  assert.match(
    workerFailure({ code: "ECONNREFUSED" }, "Knowledge ingestion"),
    /infrastructure availability/,
  );
  const unknown = workerFailure(
    { code: "secret value", message: "sensitive password" },
    "Mail delivery",
  );
  assert.match(unknown, /WORKER_TASK_FAILED/);
  assert(!unknown.includes("secret"));
  assert(!unknown.includes("password"));
});
