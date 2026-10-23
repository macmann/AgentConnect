"use client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KnowledgeUploadQueue, uploadFile } from "./knowledge-upload-queue";
import { apiBase } from "./agent-client";
import { Button } from "./button";
import { HelpTooltip } from "./help-tooltip";
export function useKnowledgeUploads(workspaceId: string) {
  const cache = useQueryClient();
  const queue = useMemo(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const q = new KnowledgeUploadQueue(uploadFile(apiBase), () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        void cache.invalidateQueries({ queryKey: ["knowledge", workspaceId] });
        void cache.invalidateQueries({ queryKey: ["knowledge-sources"] });
      }, 1000);
    });
    return {
      q,
      cleanup: () => {
        if (timer) clearTimeout(timer);
        q.dispose();
      },
    };
  }, [workspaceId, cache]);
  useEffect(() => {
    queue.q.activate();
    const unload = (e: BeforeUnloadEvent) => {
      if (queue.q.hasPending()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const leave = (e: Event) => {
      if (
        queue.q.hasPending() &&
        !window.confirm(
          "Uploads are unfinished. Leave and stop pending uploads? Files already received will continue ingestion.",
        )
      )
        e.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    window.addEventListener("agent-studio:before-leave", leave);
    return () => {
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("agent-studio:before-leave", leave);
      queue.cleanup();
    };
  }, [queue]);
  return queue.q;
}
export function KnowledgeUploads({
  queue,
  sources,
}: {
  queue: KnowledgeUploadQueue;
  sources: { id: string; status: string; error_code: string | null }[];
}) {
  const state = useSyncExternalStore(
    queue.subscribe,
    queue.getSnapshot,
    queue.getSnapshot,
  );
  if (!state.rows.length) return null;
  const pending = state.rows.filter(
      (r) => r.status === "waiting" || r.status === "uploading",
    ).length,
    uploaded = state.rows.filter((r) => r.status === "uploaded").length,
    failed = state.rows.filter((r) => r.status === "failed").length;
  return (
    <section
      className="knowledge-upload-queue"
      aria-label="Document upload queue"
    >
      <div className="upload-queue-heading">
        <div>
          <h3>Document uploads</h3>
          <p role="status">
            {uploaded} uploaded · {pending} remaining · {failed} failed
            {state.paused ? " · Paused" : ""}
          </p>
        </div>
        <HelpTooltip>
          Uploads are separate from ingestion. Keep Knowledge open until uploads
          finish. Pausing stops new transfers; active transfers finish. Files
          already received continue processing even after you leave.
        </HelpTooltip>
      </div>
      <div className="upload-queue-actions">
        <label>
          Simultaneous uploads
          <select
            value={state.concurrency}
            onChange={(e) => queue.concurrency(Number(e.target.value))}
          >
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          className="secondary"
          disabled={!pending}
          onClick={() => queue.pause(!state.paused)}
        >
          {state.paused ? "Resume uploads" : "Pause uploads"}
        </Button>
        <Button
          type="button"
          className="secondary"
          disabled={
            !state.rows.some((r) => r.status === "failed" && !r.invalid)
          }
          onClick={() => {
            for (const row of state.rows)
              if (row.status === "failed") queue.retry(row.id);
          }}
        >
          Retry failed uploads
        </Button>
        <Button
          type="button"
          className="secondary"
          disabled={!pending}
          onClick={() => queue.cancelPending()}
        >
          Cancel pending uploads
        </Button>
        <Button
          type="button"
          className="ghost"
          onClick={() => queue.clearFinished()}
        >
          Clear finished files
        </Button>
      </div>
      <p className="muted">
        Up to 100 files · 10 MB each. Uploaded files process in the background;
        check Sources for ingestion errors. Clearing this list keeps uploaded
        sources.
      </p>
      <ul className="upload-queue-files">
        {state.rows.map((row) => {
          const source = sources.find((s) => s.id === row.sourceId);
          return (
            <li key={row.id}>
              <div className="upload-file-identity">
                <strong>{row.name}</strong>
                <small>
                  {row.knowledgeBaseName} · {(row.size / 1000000).toFixed(2)} MB
                </small>
              </div>
              <div className="upload-file-state">
                <span>
                  {row.status === "uploaded"
                    ? source
                      ? `Uploaded · Ingestion ${source.status}`
                      : "Uploaded"
                    : row.status === "uploading"
                      ? row.progress === 100
                        ? "Upload sent · Waiting for server"
                        : `Uploading ${row.progress}%`
                      : row.status === "waiting"
                        ? "Waiting"
                        : row.status === "cancelled"
                          ? "Cancelled"
                          : "Upload failed"}
                </span>
                {row.status === "uploading" && (
                  <progress
                    max={100}
                    value={row.progress}
                    aria-label={`Upload progress for ${row.name}`}
                  />
                )}
                {(row.error || source?.error_code) && (
                  <span className="error-text">
                    {row.error ?? source?.error_code}
                  </span>
                )}
              </div>
              <div className="upload-file-actions">
                {(row.status === "waiting" || row.status === "uploading") && (
                  <Button
                    type="button"
                    className="ghost"
                    onClick={() => queue.cancel(row.id)}
                    aria-label={`Cancel upload ${row.name}`}
                  >
                    Cancel
                  </Button>
                )}
                {((row.status === "failed" && !row.invalid) ||
                  row.status === "cancelled") && (
                  <Button
                    type="button"
                    className="secondary"
                    onClick={() => queue.retry(row.id)}
                    aria-label={`Retry upload ${row.name}`}
                  >
                    Retry
                  </Button>
                )}
                {!["waiting", "uploading"].includes(row.status) && (
                  <Button
                    type="button"
                    className="ghost"
                    onClick={() => queue.remove(row.id)}
                    aria-label={`Remove upload ${row.name}`}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
