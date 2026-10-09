// Log only stable codes and instructions, never raw provider/database errors.
export function workerFailure(error: unknown, label: string) {
  const value =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown })
      : {};
  const code =
    typeof value.code === "string" && /^[A-Z0-9_]{2,64}$/.test(value.code)
      ? value.code
      : "WORKER_TASK_FAILED";
  const hint =
    code === "42P01" || code === "42703"
      ? "Database schema is missing or outdated. Run pnpm db:migrate, then restart pnpm dev."
      : code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT"
        ? "Check infrastructure availability and the worker connection settings."
        : "Check service configuration and database migrations.";
  return `${label} failed [${code}]; durable jobs retained. ${hint}`;
}
