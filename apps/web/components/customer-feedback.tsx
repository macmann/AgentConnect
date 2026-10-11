"use client";
import { useEffect, useState } from "react";
import { apiBase } from "./agent-client";
import { Button } from "./button";
export function CustomerFeedback({
  base,
  conversationId,
  token,
}: {
  base: string;
  conversationId: string;
  token: string;
}) {
  const [rating, setRating] = useState(""),
    [resolved, setResolved] = useState(""),
    [comment, setComment] = useState(""),
    [status, setStatus] = useState(""),
    [busy, setBusy] = useState(false);
  const path = `${apiBase}${base}/conversations/${conversationId}/feedback`;
  useEffect(() => {
    let active = true;
    fetch(path, { headers: { authorization: "Bearer " + token } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (active && d) {
          setRating(d.rating ? String(d.rating) : "");
          setResolved(d.resolved === null ? "" : String(d.resolved));
          setComment(d.comment);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [path, token]);
  return (
    <details className="generated-block">
      <summary>Rate this conversation</summary>
      <form
        className="generated-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setStatus("");
          try {
            const r = await fetch(path, {
              method: "PUT",
              headers: {
                "content-type": "application/json",
                authorization: "Bearer " + token,
              },
              body: JSON.stringify({
                rating: rating ? Number(rating) : null,
                resolved: resolved ? resolved === "true" : null,
                comment,
              }),
            });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error);
            setStatus("Thank you. Your feedback was saved.");
          } catch (e) {
            setStatus((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          How satisfied are you?
          <select value={rating} onChange={(e) => setRating(e.target.value)}>
            <option value="">Prefer not to rate</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n} —{" "}
                {n === 1
                  ? "Very dissatisfied"
                  : n === 5
                    ? "Very satisfied"
                    : n === 3
                      ? "Neutral"
                      : n === 2
                        ? "Dissatisfied"
                        : "Satisfied"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Was your question resolved?
          <select
            value={resolved}
            onChange={(e) => setResolved(e.target.value)}
          >
            <option value="">Not sure yet</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </label>
        <label>
          Optional comments
          <textarea
            maxLength={2000}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </label>
        <Button disabled={busy}>{busy ? "Saving…" : "Save feedback"}</Button>
        <p role="status">{status}</p>
      </form>
    </details>
  );
}
