"use client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiBase, requestJson } from "./agent-client";
import { Button } from "./button";
import { HelpTooltip } from "./help-tooltip";
export type ExtractionPage = {
  page: number;
  language: string;
  warnings: string[];
  corrected?: boolean;
  cached?: boolean;
  imageKey?: string;
  blocks: {
    kind: "text" | "table";
    heading: string;
    text: string;
    rows: string[][];
    headerRows: number;
  }[];
};
const unevenRows = (rows: string[][]) =>
  rows.some((row) => row.length !== rows[0]?.length);
export function ExtractionReview({
  knowledgeBaseId,
  sourceId,
  documentId,
  revision,
  pages,
  canEdit,
  onQueued,
}: {
  knowledgeBaseId: string;
  sourceId: string;
  documentId: string;
  revision: number;
  pages: ExtractionPage[];
  canEdit: boolean;
  onQueued: (message?: string) => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(pages));
  const [selected, setSelected] = useState(pages[0]?.page ?? 1);
  const [zoom, setZoom] = useState(100);
  const [image, setImage] = useState("");
  const [imageError, setImageError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const page = draft.find((p) => p.page === selected);
  const dirty = JSON.stringify(draft) !== JSON.stringify(pages);
  const path = `/knowledge-bases/${knowledgeBaseId}/sources/${sourceId}/extraction`;
  const history = useQuery({
    queryKey: ["extraction-edits", sourceId, revision],
    queryFn: () =>
      requestJson<
        {
          id: string;
          source_revision: number;
          reviewer: string | null;
          created_at: string;
        }[]
      >(path + "/edits"),
  });
  useEffect(() => {
    const controller = new AbortController();
    let url = "";
    setImage("");
    setImageError("");
    void fetch(
      apiBase + path + `/page-image?page=${selected}&revision=${revision}`,
      { credentials: "include", signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) {
          const value = await response.json();
          throw new Error(value.error ?? "Unable to load original page");
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setImage(url);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setImageError(e.message);
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, revision, selected]);
  useEffect(() => {
    if (!dirty) return;
    const listener = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const leave = (event: Event) => {
      if (!window.confirm("Discard unsaved extraction corrections?"))
        event.preventDefault();
    };
    const close = (event: Event) => {
      if (!window.confirm("Discard unsaved extraction corrections?"))
        event.preventDefault();
    };
    window.addEventListener("agent-studio:before-leave", leave);
    window.addEventListener("knowledge-review:before-close", close);
    window.addEventListener("beforeunload", listener);
    return () => {
      window.removeEventListener("beforeunload", listener);
      window.removeEventListener("agent-studio:before-leave", leave);
      window.removeEventListener("knowledge-review:before-close", close);
    };
  }, [dirty]);
  function update(fn: (p: ExtractionPage) => void) {
    setDraft((previous) => {
      const next = structuredClone(previous);
      const current = next.find((p) => p.page === selected);
      if (current) fn(current);
      return next;
    });
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      for (const p of draft)
        for (const [index, block] of p.blocks.entries()) {
          if (block.kind === "text" && !block.text.trim()) {
            setSelected(p.page);
            throw new Error(
              `Page ${p.page}, text block ${index + 1}: enter transcription text.`,
            );
          }
          if (
            block.kind === "table" &&
            (!Number.isInteger(block.headerRows) ||
              block.headerRows < 0 ||
              block.headerRows > 6 ||
              block.headerRows >= block.rows.length)
          ) {
            setSelected(p.page);
            throw new Error(
              `Page ${p.page}, table ${index + 1}: header rows must be between 0 and 6 and leave at least one data row.`,
            );
          }
        }
      const changes = draft.filter(
        (p, i) => JSON.stringify(p) !== JSON.stringify(pages[i]),
      );
      await requestJson(path + "/corrections", "PUT", {
        revision,
        documentId,
        pages: changes.map((p) => ({
          page: p.page,
          extraction: {
            language: p.language,
            warnings: p.warnings,
            blocks: p.blocks,
          },
        })),
      });
      onQueued();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save correction");
    } finally {
      setBusy(false);
    }
  }
  if (!page) return null;
  return (
    <section
      className="extraction-review"
      aria-label="Extraction correction workspace"
    >
      <div className="button-row">
        <label>
          Review page
          <select
            aria-label="Review page"
            value={selected}
            onChange={(e) => setSelected(Number(e.target.value))}
          >
            {draft.map((p) => (
              <option key={p.page} value={p.page}>
                Page {p.page}
                {p.corrected ? " · Corrected" : ""}
              </option>
            ))}
          </select>
        </label>
        <span role="status">
          {dirty ? "Unsaved corrections" : "Saved extraction"}
        </span>
        <HelpTooltip>
          Edits persist while switching pages. Saving queues reindexing using
          the corrected artifact, without a vision-model call. Published
          knowledge releases still require the normal review and publication
          process.
        </HelpTooltip>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="extraction-review-columns">
        <div className="extraction-original">
          <h4>Original · page {selected}</h4>
          <label>
            Original page zoom
            <input
              aria-label="Original page zoom"
              type="range"
              min={100}
              max={300}
              step={25}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            />
            <span>{zoom}%</span>
          </label>
          {imageError ? (
            <p role="alert">{imageError}</p>
          ) : image ? (
            <img
              src={image}
              alt={`Original document page ${selected}`}
              style={{ width: `${zoom}%`, maxWidth: "none" }}
            />
          ) : (
            <p role="status">Loading original page…</p>
          )}
        </div>
        <fieldset
          disabled={!canEdit || busy}
          className="extraction-edit-fields"
        >
          <legend>Extracted content</legend>
          <label>
            Detected languages
            <input
              value={page.language}
              maxLength={200}
              onChange={(e) =>
                update((p) => {
                  p.language = e.target.value;
                })
              }
            />
          </label>
          <label>
            Review notes
            <textarea
              value={page.warnings.join("\n")}
              rows={2}
              onChange={(e) =>
                update((p) => {
                  p.warnings = e.target.value.split("\n").filter(Boolean);
                })
              }
            />
          </label>
          {page.blocks.map((block, index) => (
            <section key={index} className="extraction-edit-block">
              <h4>
                {block.kind === "table" ? "Table" : "Text"} {index + 1}
              </h4>
              <label>
                Heading
                <input
                  aria-label={`Block ${index + 1} heading`}
                  maxLength={500}
                  value={block.heading}
                  onChange={(e) =>
                    update((p) => {
                      p.blocks[index]!.heading = e.target.value;
                    })
                  }
                />
              </label>
              {block.kind === "text" ? (
                <label>
                  Transcription
                  <textarea
                    aria-label={`Block ${index + 1} transcription`}
                    rows={5}
                    value={block.text}
                    onChange={(e) =>
                      update((p) => {
                        p.blocks[index]!.text = e.target.value;
                      })
                    }
                  />
                </label>
              ) : (
                <>
                  <label>
                    Header rows
                    <input
                      aria-label={`Table ${index + 1} header rows`}
                      type="number"
                      min={0}
                      max={Math.min(6, block.rows.length - 1)}
                      value={block.headerRows}
                      onChange={(e) =>
                        update((p) => {
                          p.blocks[index]!.headerRows = Number(e.target.value);
                        })
                      }
                    />
                  </label>
                  <div className="table-wrap">
                    <table>
                      <tbody>
                        {block.rows.map((row, r) => (
                          <tr key={r}>
                            {row.map((cell, c) => (
                              <td key={c}>
                                <input
                                  aria-label={`Block ${index + 1} row ${r + 1} column ${c + 1}`}
                                  value={cell}
                                  maxLength={10000}
                                  onChange={(e) =>
                                    update((p) => {
                                      p.blocks[index]!.rows[r]![c] =
                                        e.target.value;
                                    })
                                  }
                                />
                              </td>
                            ))}
                            <td>
                              <button
                                type="button"
                                className="text-button"
                                disabled={
                                  block.rows.length <= block.headerRows + 1
                                }
                                onClick={() =>
                                  update((p) => {
                                    p.blocks[index]!.rows.splice(r, 1);
                                  })
                                }
                              >
                                Remove row {r + 1}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {unevenRows(block.rows) && (
                    <div className="setting-label-row">
                      <span>Rows have different widths.</span>
                      <HelpTooltip>
                        Pad short rows with blank cells, then verify column
                        positions against the original. No values are reordered
                        or inferred.
                      </HelpTooltip>
                      <Button
                        className="secondary"
                        onClick={() =>
                          update((p) => {
                            const rows = p.blocks[index]!.rows;
                            const width = Math.max(
                              ...rows.map((row) => row.length),
                            );
                            rows.forEach((row) => {
                              while (row.length < width) row.push("");
                            });
                          })
                        }
                      >
                        Pad missing cells
                      </Button>
                    </div>
                  )}
                  <div className="button-row">
                    <Button
                      className="secondary"
                      disabled={block.rows.length >= 1000}
                      onClick={() =>
                        update((p) => {
                          p.blocks[index]!.rows.push(
                            Array(
                              Math.max(
                                1,
                                ...block.rows.map((row) => row.length),
                              ),
                            ).fill(""),
                          );
                        })
                      }
                    >
                      Add row
                    </Button>
                    <Button
                      className="secondary"
                      disabled={
                        unevenRows(block.rows) ||
                        (block.rows[0]?.length ?? 0) >= 100
                      }
                      onClick={() =>
                        update((p) => {
                          p.blocks[index]!.rows.forEach((row) => row.push(""));
                        })
                      }
                    >
                      Add column
                    </Button>
                    <Button
                      className="secondary"
                      disabled={
                        unevenRows(block.rows) ||
                        (block.rows[0]?.length ?? 0) <= 1
                      }
                      onClick={() =>
                        update((p) => {
                          p.blocks[index]!.rows.forEach((row) => row.pop());
                        })
                      }
                    >
                      Remove last column
                    </Button>
                  </div>
                </>
              )}
            </section>
          ))}
        </fieldset>
      </div>
      {history.error && (
        <p role="alert">
          Unable to load correction history: {history.error.message}
        </p>
      )}
      {!!history.data?.length && (
        <details>
          <summary>Correction history</summary>
          <ul>
            {history.data.map((edit) => (
              <li key={edit.id}>
                Revision {edit.source_revision} ·{" "}
                {edit.reviewer ?? "Reviewer unavailable"} ·{" "}
                {new Date(edit.created_at).toLocaleString()}
              </li>
            ))}
          </ul>
        </details>
      )}
      {canEdit && (
        <div className="workspace-save-bar">
          <span>{dirty ? "Unsaved corrections" : "No changes"}</span>
          <div className="button-row">
            {pages.some((p) => p.corrected) && (
              <Button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  if (
                    !window.confirm(
                      "Use automatic extraction again? Unsaved corrections will be discarded. Cached pages are reused when possible; provider calls may incur charges.",
                    )
                  )
                    return;
                  setBusy(true);
                  setError("");
                  void requestJson(path + "/corrections", "DELETE", {
                    revision,
                  })
                    .then(() =>
                      onQueued(
                        "Automatic extraction queued. Published releases remain unchanged.",
                      ),
                    )
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                Use automatic extraction
              </Button>
            )}
            <Button
              className="secondary"
              disabled={busy || !dirty}
              onClick={() => setDraft(structuredClone(pages))}
            >
              Discard corrections
            </Button>
            <Button disabled={busy || !dirty} onClick={() => void save()}>
              Save correction and reindex
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
