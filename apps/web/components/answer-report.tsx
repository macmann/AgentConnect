"use client";
import { useEffect, useState } from "react";
import { apiBase } from "./agent-client";
import { Button } from "./button";
export function AnswerReport({
  base,
  conversationId,
  messageId,
  token,
  onSupportRequested,
  canRequestSupport,
}: {
  base: string;
  conversationId: string;
  messageId: string;
  token: string;
  onSupportRequested?: () => void;
  canRequestSupport?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [reason, setReason] = useState("incorrect"),
    [comment, setComment] = useState(""),
    [support, setSupport] = useState(false),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    [error, setError] = useState("");
  const path = `${apiBase}${base}/conversations/${conversationId}/answer-reports/${messageId}`;
  useEffect(() => {
    let active = true;
    void fetch(path, { headers: { authorization: "Bearer " + token } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (active && d) {
          setStatus(d.status);
          setReason(d.reason);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [path, token]);
  return (
    <div className="answer-report">
      <button
        type="button"
        className="text-button"
        onClick={() => {
          setOpen(!open);
          setError("");
        }}
        aria-expanded={open}
      >
        Report this answer
      </button>
      {status && (
        <p role="status">
          Report {status.replaceAll("_", " ")}. Your feedback is saved for
          review.
        </p>
      )}
      {open && (
        <form
          className="review-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              const r = await fetch(path, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: "Bearer " + token,
                },
                body: JSON.stringify({
                  reason,
                  comment,
                  requestSupport: support,
                }),
              });
              const d = await r.json();
              if (!r.ok) throw new Error(d.error ?? "Could not save report");
              setStatus(d.status);
              setOpen(false);
              if (d.supportRequested) onSupportRequested?.();
              if (d.supportError) setError(d.supportError);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            What went wrong?
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="incorrect">Incorrect answer</option>
              <option value="not_helpful">Not helpful</option>
              <option value="unresolved">Still unresolved</option>
            </select>
          </label>
          <label>
            Additional details
            <textarea
              maxLength={2000}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </label>
          {canRequestSupport && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={support}
                onChange={(e) => setSupport(e.target.checked)}
              />
              Also request human support
            </label>
          )}
          <small>Tell us what was missing or incorrect.</small>
          <Button disabled={busy}>
            {busy ? "Saving…" : "Submit answer report"}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
