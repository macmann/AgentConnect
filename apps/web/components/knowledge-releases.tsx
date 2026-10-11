"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { requestJson } from "./agent-client";
import { Button } from "./button";
type Release = {
  id: string;
  version: number;
  name: string;
  notes: string;
  status: string;
  author_id: string;
  review_note: string;
  chunk_count: number;
  source_count: number;
  created_at: string;
};
export function KnowledgeReleases({
  baseId,
  role,
  sources,
  publishedId,
}: {
  baseId: string;
  role: string;
  sources: { id: string; title: string; status: string }[];
  publishedId?: string | null;
}) {
  const cache = useQueryClient(),
    [selected, setSelected] = useState<string[]>([]),
    [name, setName] = useState(""),
    [notes, setNotes] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [preview, setPreview] = useState<
      { title: string; content: string; source_revision: number }[] | null
    >(null),
    [reviewNote, setReviewNote] = useState("");
  const manage = ["owner", "org_admin", "workspace_admin", "builder"].includes(
      role,
    ),
    approve = ["owner", "org_admin", "workspace_admin"].includes(role);
  const path = `/knowledge-bases/${baseId}/releases`;
  const releases = useQuery({
    queryKey: ["knowledge-releases", baseId],
    queryFn: () => requestJson<Release[]>(path),
  });
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await cache.invalidateQueries({
        queryKey: ["knowledge-releases", baseId],
      });
      await cache.invalidateQueries({ queryKey: ["knowledge"] });
      await cache.invalidateQueries({ queryKey: ["knowledge-base", baseId] });
      setNotice("Knowledge release updated.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Knowledge releases">
      <h3>Reviewed knowledge releases</h3>
      <p className="muted">
        A release freezes the selected indexed passages. Submit it for a
        different administrator to review, then publish. Publishing an older
        reviewed version rolls back the live release; pinned agents stay on
        their selected version.
      </p>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {manage && (
        <details>
          <summary>Create a release</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await requestJson(path, "POST", {
                  name,
                  notes,
                  sourceIds: selected,
                });
                setName("");
                setNotes("");
                setSelected([]);
              });
            }}
          >
            <label>
              Release name
              <input
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              Change notes
              <textarea
                maxLength={2000}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
            <fieldset>
              <legend>Select ready sources</legend>
              {sources
                .filter((s) => s.status === "ready")
                .map((s) => (
                  <label className="checkbox-label" key={s.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(s.id)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, s.id]
                            : selected.filter((id) => id !== s.id),
                        )
                      }
                    />
                    {s.title}
                  </label>
                ))}
              {!sources.some((s) => s.status === "ready") && (
                <p>Index a source before creating a release.</p>
              )}
            </fieldset>
            <Button disabled={busy || !selected.length}>
              Create frozen draft
            </Button>
          </form>
        </details>
      )}
      {approve && (
        <label>
          Review note
          <textarea
            maxLength={2000}
            value={reviewNote}
            onChange={(e) => setReviewNote(e.target.value)}
            placeholder="Required when rejecting; included in release history."
          />
        </label>
      )}
      {releases.error && <p role="alert">{releases.error.message}</p>}
      {releases.isPending && <p>Loading releases…</p>}
      {releases.data?.length === 0 && (
        <p>
          No releases yet. Create a draft from ready sources to start review.
        </p>
      )}
      <div className="configure-starters">
        {releases.data?.map((r) => (
          <article className="configure-group" key={r.id}>
            <h4>
              Version {r.version} · {r.name}
            </h4>
            <p>
              {r.status}
              {publishedId === r.id
                ? " · Current published release"
                : ""} · {r.source_count} sources · {r.chunk_count} passages
            </p>
            <p>{r.notes}</p>
            {r.review_note && <p>Reviewer: {r.review_note}</p>}
            <div className="actions">
              <Button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () =>
                    setPreview(await requestJson(path + `/${r.id}/chunks`)),
                  )
                }
              >
                Review passages
              </Button>
              {manage && r.status === "draft" && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      requestJson(path + `/${r.id}/transition`, "POST", {
                        action: "submit",
                      }),
                    )
                  }
                >
                  Submit for review
                </Button>
              )}
              {approve && r.status === "review" && (
                <>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        requestJson(path + `/${r.id}/transition`, "POST", {
                          action: "approve",
                          note: reviewNote,
                        }),
                      )
                    }
                  >
                    Approve
                  </Button>
                  <Button
                    className="secondary"
                    disabled={busy || !reviewNote.trim()}
                    onClick={() =>
                      void run(() =>
                        requestJson(path + `/${r.id}/transition`, "POST", {
                          action: "reject",
                          note: reviewNote,
                        }),
                      )
                    }
                  >
                    Reject
                  </Button>
                </>
              )}
              {approve &&
                ["approved", "published"].includes(r.status) &&
                publishedId !== r.id && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        requestJson(path + `/${r.id}/transition`, "POST", {
                          action: "publish",
                        }),
                      )
                    }
                  >
                    {r.status === "published"
                      ? "Restore this release"
                      : "Publish release"}
                  </Button>
                )}
            </div>
          </article>
        ))}
      </div>
      {preview && (
        <section aria-label="Release passage preview">
          <h4>Frozen passage preview (first 100)</h4>
          <Button className="secondary" onClick={() => setPreview(null)}>
            Close preview
          </Button>
          {preview.map((p, i) => (
            <article key={i}>
              <strong>
                {p.title} · Source revision {p.source_revision}
              </strong>
              <p className="source-snippet">{p.content}</p>
            </article>
          ))}
        </section>
      )}
    </section>
  );
}
