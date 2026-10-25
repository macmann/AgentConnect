import { groundedPrompt, type Citation } from "./tool.js";
import type { AnswerSourceOptions } from "./answer-source-policy.js";

/** Full sentences must not require every filler word to occur in a passage. */
export function lexicalSearchQuery(query: string): string {
  if (/["-]|\bOR\b/.test(query)) return query;
  const filler = new Set([
    "what",
    "which",
    "who",
    "how",
    "are",
    "is",
    "the",
    "a",
    "an",
    "of",
    "to",
    "for",
    "in",
    "on",
    "about",
    "all",
    "please",
    "tell",
    "me",
    "assigned",
  ]);
  const terms = [
    ...new Set(
      (query.match(/[\p{L}\p{N}_]+/gu) ?? []).filter(
        (v) => !filler.has(v.toLowerCase()),
      ),
    ),
  ].slice(0, 40);
  return terms.length ? terms.join(" OR ") : query;
}

export function retrievalBreadth(query: string): "specific" | "comprehensive" {
  if (
    /\bweek\s*\d+\b/i.test(query) &&
    !/\b(all|every|across)\s+(the\s+)?weeks\b/i.test(query)
  )
    return "specific";
  return /\b(all|everything|list|tasks|responsibilities|history|summari[sz]e)\b|\bwhat (did .+ work on|does .+ do)\b/i.test(
    query,
  )
    ? "comprehensive"
    : "specific";
}

export function uniqueChunks(sources: Citation[]): Citation[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = `${source.knowledgeBaseId}:${source.sourceId}:${source.documentId}:${source.sourceRevision}:${source.releaseId ?? "current"}:${source.chunkId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Rank first, fit whole passages, then order within each immutable document. */
export function selectContext(
  candidates: Citation[],
  limit: number,
  budget: number,
  countTokens: (text: string) => number,
  options: AnswerSourceOptions = {},
) {
  const selected: Citation[] = [];
  const texts = new Set<string>();
  for (const source of uniqueChunks(candidates)) {
    const text = source.content.replace(/\s+/g, " ").trim();
    // Primary approved Q&A and supporting document provenance remain distinct.
    const textKey = `${source.sourceKind === "qa" ? "qa:" + source.reviewStatus : "document"}:${text}`;
    if (!text || texts.has(textKey)) continue;
    const proposed = [...selected, { ...source, id: selected.length + 1 }];
    if (
      selected.length >= limit ||
      countTokens(groundedPrompt(proposed, options)) > budget
    )
      continue;
    selected.push({ ...source });
    texts.add(textKey);
  }
  const documentKey = (s: Citation) =>
    `${s.knowledgeBaseId}:${s.sourceId}:${s.documentId}:${s.sourceRevision}:${s.releaseId ?? "current"}`;
  const groups = new Map<string, Citation[]>();
  for (const source of selected.filter(
    (source) =>
      !selected.some(
        (other) =>
          other !== source &&
          documentKey(other) === documentKey(source) &&
          other.content.length > source.content.length &&
          other.content.includes(source.content),
      ),
  )) {
    const key = documentKey(source);
    groups.set(key, [...(groups.get(key) ?? []), source]);
  }
  const ordered = [...groups.values()].flatMap((group) =>
    // Legacy snapshots with unknown order stay in relevance order.
    group.every((s) => s.chunkIndex !== undefined)
      ? group.sort((a, b) => a.chunkIndex! - b.chunkIndex!)
      : group,
  );
  for (let i = ordered.length - 1; i > 0; i--) {
    const before = ordered[i - 1]!,
      current = ordered[i]!;
    if (
      documentKey(before) !== documentKey(current) ||
      before.chunkIndex === undefined ||
      current.chunkIndex !== before.chunkIndex + 1
    )
      continue;
    // Strip only an exact, substantial suffix/prefix overlap, never paraphrase.
    for (
      let n = Math.min(2000, before.content.length, current.content.length);
      n >= 40;
      n--
    ) {
      if (
        before.content.endsWith(current.content.slice(0, n)) &&
        (/\s/.test(current.content[n] ?? " ") ||
          /\s/.test(current.content[n - 1]!))
      ) {
        current.content = current.content.slice(n).trimStart();
        break;
      }
    }
  }
  let sources = ordered
    .filter((s) => s.content.trim())
    .map((s, i) => ({ ...s, id: i + 1 }));
  // Ordering can slightly affect tokenization. Never exceed the final budget.
  while (
    sources.length &&
    countTokens(groundedPrompt(sources, options)) > budget
  )
    sources = sources.slice(0, -1);
  return {
    sources,
    estimatedTokens: sources.length
      ? countTokens(groundedPrompt(sources, options))
      : 0,
  };
}
