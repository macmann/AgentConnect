import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { sql } from "./db.js";
import { observe } from "./ai-tracing.js";

type Job = {
  id: string;
  source_id: string;
  knowledge_base_id: string;
  workspace_id: string;
  organization_id: string;
  source_revision: number;
  attempts: number;
};
export const extractionJob = new AsyncLocalStorage<Job>();
type Model = { id: string; provider: string; modelId: string };
export type ExtractionUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
};
export function extractionCost(
  usage: ExtractionUsage,
  prices?: { input_usd_per_million: number; output_usd_per_million: number },
) {
  return prices && usage.inputTokens !== null && usage.outputTokens !== null
    ? (usage.inputTokens * prices.input_usd_per_million +
        usage.outputTokens * prices.output_usd_per_million) /
        1000000
    : null;
}
/** Content and image bytes never enter metadata. Unknown usage/prices remain unknown. */
export async function trackExtraction<T>(
  stage: "vision" | "boundaries" | "correction",
  page: number | null,
  model: Model | null,
  cached: boolean,
  operation: (usage: ExtractionUsage) => Promise<T>,
): Promise<T> {
  return observe(
    `knowledge.extraction.${stage}`,
    cached ? "span" : model ? "generation" : "span",
    {
      "extraction.page": page ?? 0,
      "extraction.cached": cached,
      "model.provider": model?.provider ?? "none",
      "langfuse.observation.model.name": model?.modelId ?? "none",
    },
    async (span) => {
      const job = extractionJob.getStore();
      const id = randomUUID(),
        started = performance.now();
      const usage: ExtractionUsage = {
        inputTokens: cached ? 0 : null,
        outputTokens: cached ? 0 : null,
      };
      const prices =
        job && model
          ? ((
              await sql`SELECT input_usd_per_million::float8,output_usd_per_million::float8 FROM model_prices WHERE model_id=${model.id} AND workspace_id=${job.workspace_id} AND organization_id=${job.organization_id}`
            )[0] as
              | {
                  input_usd_per_million: number;
                  output_usd_per_million: number;
                }
              | undefined)
          : undefined;
      if (job)
        await sql`INSERT INTO knowledge_processing_usage(id,source_id,knowledge_base_id,workspace_id,organization_id,job_id,source_revision,attempt,stage,page,model_id,provider,model_name,status,input_usd_per_million,output_usd_per_million,trace_id) VALUES (${id},${job.source_id},${job.knowledge_base_id},${job.workspace_id},${job.organization_id},${job.id},${job.source_revision},${job.attempts},${stage},${page},${model?.id ?? null},${model?.provider ?? null},${model?.modelId ?? null},'running',${prices?.input_usd_per_million ?? null},${prices?.output_usd_per_million ?? null},${span.spanContext().traceId === "0".repeat(32) ? "" : span.spanContext().traceId})`;
      let errorCode: string | null = null;
      try {
        return await operation(usage);
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        errorCode =
          typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)
            ? code
            : "EXTRACTION_FAILED";
        throw error;
      } finally {
        const cost = cached ? 0 : extractionCost(usage, prices);
        const duration = Math.round(performance.now() - started);
        span.setAttributes({
          "extraction.status": errorCode
            ? "failed"
            : cached
              ? "cached"
              : "completed",
          "extraction.duration_ms": duration,
        });
        const details: Record<string, number> = {};
        if (usage.inputTokens !== null) details.input = usage.inputTokens;
        if (usage.outputTokens !== null) details.output = usage.outputTokens;
        span.setAttribute(
          "langfuse.observation.usage_details",
          JSON.stringify(details),
        );
        if (cost !== null)
          span.setAttribute(
            "langfuse.observation.cost_details",
            JSON.stringify({ total: cost }),
          );
        if (job)
          await sql`UPDATE knowledge_processing_usage SET status=${errorCode ? "failed" : stage === "correction" ? "reused" : cached ? "cached" : "completed"},input_tokens=${usage.inputTokens},output_tokens=${usage.outputTokens},estimated_cost_usd=${cost},duration_ms=${duration},error_code=${errorCode},finished_at=now() WHERE id=${id}`;
      }
    },
  );
}
