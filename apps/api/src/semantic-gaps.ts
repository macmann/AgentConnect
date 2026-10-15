// Complete-link clustering avoids chains of loosely related questions being merged.
export function semanticClusters(
  vectors: number[][],
  threshold = 0.85,
): number[][] {
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1)
    throw new Error("Invalid similarity threshold");
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
    if (!norm || !Number.isFinite(norm))
      throw new Error("Empty embedding vector");
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

export function clusterSimilarity(vectors: number[][], members: number[]) {
  const scores: number[] = [];
  for (let a = 0; a < members.length; a++)
    for (let b = a + 1; b < members.length; b++) {
      const va = vectors[members[a]!]!,
        vb = vectors[members[b]!]!;
      const similarity =
        va.reduce((sum, n, i) => sum + n * vb[i]!, 0) /
        (Math.hypot(...va) * Math.hypot(...vb));
      scores.push(Math.max(-1, Math.min(1, similarity)));
    }
  return {
    minimum: scores.length ? Math.min(...scores) : null,
    mean: scores.length
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : null,
  };
}
