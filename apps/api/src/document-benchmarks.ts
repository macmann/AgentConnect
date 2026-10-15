import { z } from "zod";
import type { TransactionSql } from "postgres";
import type { Example } from "@agentconnect/schemas/quality";
import { readParsedArtifact } from "./knowledge-artifacts.js";
import { sql } from "./db.js";
import { KnowledgeError } from "@agentconnect/rag/parsers";
import { HttpError } from "./http-error.js";

export const pageSnapshot = z.object({
  sourceId: z.uuid(),
  page: z.number().int().positive(),
  revision: z.number().int().positive(),
  contentHash: z.string(),
  text: z.string(),
  tables: z.array(z.array(z.array(z.string()))),
});
export type PageSnapshot = z.infer<typeof pageSnapshot>;
export async function captureDocumentBenchmarks(
  examples: Example[],
  workspace: string,
  org: string,
  tx: TransactionSql,
) {
  const checks = examples.flatMap((e) => e.documentChecks);
  const ids = [...new Set(checks.map((c) => c.sourceId))];
  if (!ids.length) return [];
  if (ids.length > 20)
    throw new HttpError(
      400,
      "A benchmark can include at most 20 document sources",
    );
  await tx`SELECT k.id FROM knowledge_bases k WHERE k.id IN (SELECT knowledge_base_id FROM knowledge_sources WHERE id IN ${tx(ids)} AND workspace_id=${workspace} AND organization_id=${org}) AND k.workspace_id=${workspace} AND k.archived_at IS NULL ORDER BY k.id FOR SHARE`;
  const rows =
    await tx`SELECT s.id,s.revision,s.knowledge_base_id,d.metadata,d.content_hash FROM knowledge_sources s JOIN knowledge_documents d ON d.source_id=s.id AND d.revision=s.revision JOIN knowledge_bases k ON k.id=s.knowledge_base_id WHERE s.id IN ${tx(ids)} AND s.workspace_id=${workspace} AND s.organization_id=${org} AND s.status='ready' AND k.archived_at IS NULL FOR SHARE OF s`;
  if (new Set(rows.map((r) => r.id)).size !== ids.length)
    throw new HttpError(
      400,
      "Benchmark document sources must be ready and belong to this workspace",
    );
  const result: PageSnapshot[] = [];
  let snapshotBytes = 0;
  for (const row of rows) {
    if (!row.metadata.parsedArtifactKey)
      throw new HttpError(
        400,
        "Reingest benchmark sources once to prepare document snapshots",
      );
    const prefix = `${org}/${workspace}/${row.knowledge_base_id}/${row.id}/`;
    const artifact = await readParsedArtifact(
      row.metadata.parsedArtifactKey,
      prefix,
      AbortSignal.timeout(30000),
    );
    for (const page of [
      ...new Set(
        checks.filter((c) => c.sourceId === row.id).map((c) => c.page),
      ),
    ]) {
      const sections = artifact.document.sections.filter(
        (s) => (s.page ?? 1) === page,
      );
      if (!sections.length)
        throw new HttpError(
          400,
          "Benchmark page is unavailable in the selected source",
        );
      const tables = sections
        .filter((s) => Array.isArray(s.metadata.rawRows))
        .map((s) => s.metadata.rawRows as string[][]);
      const snapshot: PageSnapshot = {
        sourceId: row.id,
        revision: row.revision,
        page,
        contentHash: row.content_hash,
        text: sections
          .map((s) => [s.heading, s.text].filter(Boolean).join("\n"))
          .join("\n"),
        tables,
      };
      snapshotBytes += Buffer.byteLength(JSON.stringify(snapshot));
      if (snapshotBytes > 2000000)
        throw new HttpError(
          400,
          "Benchmark document snapshots exceed 2 MB; use fewer pages per run",
        );
      result.push(snapshot);
    }
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 2000000)
    throw new HttpError(
      400,
      "Benchmark document snapshots exceed 2 MB; use fewer pages per run",
    );
  return result;
}
const normalized = (s: string) =>
  s.normalize("NFC").replace(/\s+/gu, " ").trim();
/** Linear-time character trigram Dice similarity, not a claim of OCR character error rate. */
export function textSimilarity(reference: string, actual: string) {
  const a = normalized(reference),
    b = normalized(actual);
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) return 0;
  const grams = (s: string) => {
    const map = new Map<string, number>();
    const chars = Array.from(s);
    for (let i = 0; i < chars.length - 2; i++) {
      const gram = chars.slice(i, i + 3).join("");
      map.set(gram, (map.get(gram) ?? 0) + 1);
    }
    return map;
  };
  const aa = grams(a),
    bb = grams(b);
  let matched = 0,
    total = 0;
  for (const [gram, n] of aa) {
    matched += Math.min(n, bb.get(gram) ?? 0);
    total += n;
  }
  for (const n of bb.values()) total += n;
  return total ? (2 * matched) / total : 0;
}
export function scoreDocumentBenchmarks(
  example: Example,
  snapshots: PageSnapshot[],
  citations: { sourceId: string; page: number | null }[],
) {
  const pages = example.documentChecks.map((check) => {
    const snapshot = snapshots.find(
      (s) => s.sourceId === check.sourceId && s.page === check.page,
    );
    if (!snapshot) throw new Error("DOCUMENT_BENCHMARK_SNAPSHOT_MISSING");
    const similarity =
      check.expectedText === undefined
        ? null
        : textSimilarity(check.expectedText, snapshot.text);
    const cells = check.cells.map((cell) => {
      const actual =
        snapshot.tables[cell.table]?.[cell.row]?.[cell.column] ?? null;
      return {
        ...cell,
        actual,
        passed:
          actual !== null && normalized(actual) === normalized(cell.value),
      };
    });
    return {
      sourceId: check.sourceId,
      page: check.page,
      revision: snapshot.revision,
      contentHash: snapshot.contentHash,
      textSimilarity: similarity,
      cellAccuracy: cells.length
        ? cells.filter((c) => c.passed).length / cells.length
        : null,
      cells,
      passed:
        (similarity === null || similarity >= check.minTextSimilarity) &&
        cells.every((c) => c.passed),
    };
  });
  const citationRecall = example.expectedCitations.length
    ? example.expectedCitations.filter((expected) =>
        citations.some(
          (c) => c.sourceId === expected.sourceId && c.page === expected.page,
        ),
      ).length / example.expectedCitations.length
    : null;
  const measured = pages.length > 0 || citationRecall !== null;
  return {
    pages,
    citationRecall,
    passed:
      pages.every((p) => p.passed) &&
      (citationRecall === null || citationRecall === 1),
    measured,
  };
}

export async function verifyBenchmarkSources(
  snapshots: PageSnapshot[],
  workspace: string,
  org: string,
) {
  const sources = [
    ...new Map(snapshots.map((s) => [s.sourceId, s.revision])).entries(),
  ];
  if (!sources.length) return;
  const rows =
    await sql`SELECT id,revision FROM knowledge_sources WHERE id IN ${sql(sources.map((s) => s[0]))} AND workspace_id=${workspace} AND organization_id=${org} AND status='ready'`;
  if (
    rows.length !== sources.length ||
    sources.some(
      ([id, revision]) =>
        !rows.some((r) => r.id === id && r.revision === revision),
    )
  )
    throw new KnowledgeError("DOCUMENT_BENCHMARK_SOURCE_CHANGED");
}
