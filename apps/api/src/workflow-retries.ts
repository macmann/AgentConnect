import { setTimeout as delay } from "node:timers/promises";
import { ProviderError } from "@agentconnect/provider-sdk";
import { ToolError } from "./tool-errors.js";
import { sql } from "./db.js";
import type { WorkflowNode } from "@agentconnect/schemas/workflows";

// This is a step retry, distinct from checkpoint/lease recovery. Permission,
// validation and approval errors are never automatically replayed.
export async function workflowRetry<T>(
  runId: string,
  node: WorkflowNode,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  const { maxAttempts, delayMs } = node.data.retry;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    signal.throwIfAborted();
    const [trace] =
      await sql`UPDATE workflow_node_runs SET attempts=attempts+1,retry_at=NULL WHERE run_id=${runId} AND node_id=${node.id} RETURNING attempts`;
    const started = performance.now();
    try {
      return await operation();
    } catch (error) {
      const retryable =
        (error instanceof ProviderError || error instanceof ToolError) &&
        error.retryable;
      const willRetry = retryable && attempt < maxAttempts && !signal.aborted;
      const waitMs = Math.min(10000, delayMs * 2 ** (attempt - 1));
      const entry = {
        attempt: trace!.attempts as number,
        code:
          error instanceof ProviderError || error instanceof ToolError
            ? error.code
            : "WORKFLOW_EXECUTION_FAILED",
        durationMs: Math.round(performance.now() - started),
        willRetry,
      };
      await sql`UPDATE workflow_node_runs SET retry_history=retry_history || ${sql.json([entry])},retry_at=${willRetry ? new Date(Date.now() + waitMs) : null} WHERE run_id=${runId} AND node_id=${node.id}`;
      if (!willRetry) throw error;
      await delay(waitMs, undefined, { signal });
    }
  }
  throw new Error("Workflow retry exhausted");
}
