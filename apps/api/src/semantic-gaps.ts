// Complete-link clustering avoids chains of loosely related questions being merged.
export function semanticClusters(
  vectors: number[][],
  threshold = 0.85,
): number[][] {
  if (!vectors.length) return [];
  const dimensions = vectors[0]!.length;
  const normalized = vectors.map((v) => {
    if (
      !dimensions ||
      v.length !== dimensions ||
      v.some((n) => !Number.isFinite(n))
    )
      throw new Error("Invalid embedding vector");
    const norm = Math.hypot(...v);
    if (!norm) throw new Error("Empty embedding vector");
    return v.map((n) => n / norm);
  });
  const similarity = (a: number, b: number) =>
    normalized[a]!.reduce((sum, n, i) => sum + n * normalized[b]![i]!, 0);
  const groups: number[][] = [];
  normalized.forEach((_v, i) => {
    const target = groups
      .filter((g) => similarity(i, g[0]!) >= threshold)
      .sort((a, b) => similarity(i, b[0]!) - similarity(i, a[0]!))
      .find((g) => g.every((member) => similarity(i, member) >= threshold));
    if (target) target.push(i);
    else groups.push([i]);
  });
  return groups;
}
