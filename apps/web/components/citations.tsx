"use client";
export interface Citation {
  id: number;
  chunkId: string;
  title: string;
  page: number | null;
  sourceUrl: string | null;
  content: string;
  score: number;
}
export function Citations({
  sources,
  label = "Sources",
}: {
  sources: Citation[];
  label?: string;
}) {
  if (!sources.length) return null;
  return (
    <div className="citations">
      <h4>{label}</h4>
      {sources.map((s) => (
        <details key={s.chunkId}>
          <summary>
            [{s.id}] {s.title}
            {s.page ? ` · Page ${s.page}` : ""}
          </summary>
          <p className="source-snippet">{s.content}</p>
          {s.sourceUrl && /^https?:\/\//.test(s.sourceUrl) && (
            <a href={s.sourceUrl} target="_blank" rel="noreferrer">
              View source
            </a>
          )}
          {s.sourceUrl?.startsWith("s3://") && (
            <small>Source: {s.sourceUrl}</small>
          )}
          <small>Similarity {s.score.toFixed(3)}</small>
        </details>
      ))}
    </div>
  );
}
