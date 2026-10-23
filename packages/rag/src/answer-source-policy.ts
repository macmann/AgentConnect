import type { Citation } from "./tool.js";
export interface AnswerSourceOptions {
  answerSourcePolicy?: "balanced" | "prefer_approved_qa";
  qaMinScore?: number;
}
export const DEFAULT_QA_MIN_SCORE = 0.75;
export function preferredQa(source: Citation, options: AnswerSourceOptions) {
  return (
    options.answerSourcePolicy === "prefer_approved_qa" &&
    source.sourceKind === "qa" &&
    source.reviewStatus === "approved" &&
    source.vectorScore >= (options.qaMinScore ?? DEFAULT_QA_MIN_SCORE)
  );
}
/** Preserve relevance order inside each authority group and reserve supporting context. */
export function selectEvidence<T extends Citation>(
  sources: T[],
  options: AnswerSourceOptions,
  limit: number,
): T[] {
  if (options.answerSourcePolicy !== "prefer_approved_qa")
    return sources.slice(0, limit);
  const qa = sources.filter((s) => preferredQa(s, options));
  const documents = sources.filter((s) => s.sourceKind !== "qa");
  if (!qa.length) return documents.slice(0, limit);
  const selected = [...qa, ...documents].slice(0, limit);
  if (
    limit > 1 &&
    documents.length &&
    selected.every((s) => preferredQa(s, options))
  )
    selected[selected.length - 1] = documents[0]!;
  return selected;
}
