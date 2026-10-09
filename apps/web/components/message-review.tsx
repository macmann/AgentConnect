"use client";
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { requestJson } from "./agent-client";
import { Button } from "./button";
type Review = {
  id: string;
  message_id: string;
  rating: string | null;
  label: string | null;
  comment: string;
  corrected_response: string | null;
  reason: string;
  reviewer: string;
  created_at: string;
};
export function MessageReview({
  messageId,
  conversationId,
  canReview,
}: {
  messageId: string;
  conversationId: string;
  canReview: boolean;
}) {
  const cache = useQueryClient(),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const reviews = useQuery({
    queryKey: ["conversation-reviews", conversationId],
    queryFn: () =>
      requestJson<Review[]>(`/conversations/${conversationId}/reviews`),
  });
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await requestJson(`/messages/${messageId}/reviews`, "POST", {
        rating: f.get("rating") || null,
        label: f.get("label") || null,
        comment: f.get("comment"),
        correctedResponse: f.get("correction") || null,
        reason: f.get("reason"),
      });
      await cache.invalidateQueries({
        queryKey: ["conversation-reviews", conversationId],
      });
      setOpen(false);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="message-review">
      {reviews.error && (
        <p className="error" role="alert">
          Could not load reviews: {reviews.error.message}
        </p>
      )}
      {reviews.data
        ?.filter((r) => r.message_id === messageId)
        .map((r) => (
          <div className="review-record" key={r.id}>
            <small>
              {r.reviewer} · {new Date(r.created_at).toLocaleString()} ·{" "}
              {[r.rating, r.label?.replaceAll("_", " ")]
                .filter(Boolean)
                .join(" · ")}
            </small>
            {r.comment && <p>{r.comment}</p>}
            {r.corrected_response && (
              <>
                <strong>Suggested correction</strong>
                <p>{r.corrected_response}</p>
                <small>
                  Reason: {r.reason}. Original response is preserved.
                </small>
              </>
            )}
          </div>
        ))}
      {canReview && (
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setOpen(!open);
            setError("");
          }}
        >
          {open ? "Cancel review" : "Review response"}
        </button>
      )}
      {open && (
        <form className="review-form" onSubmit={save}>
          <div className="form-grid">
            <label>
              Rating
              <select name="rating" aria-label="Response rating">
                <option value="">No rating</option>
                <option value="like">Like</option>
                <option value="dislike">Dislike</option>
              </select>
            </label>
            <label>
              Review label
              <select name="label">
                <option value="">No label</option>
                {[
                  "correct",
                  "incorrect",
                  "incomplete",
                  "hallucination",
                  "retrieval_issue",
                  "tool_issue",
                  "policy_issue",
                ].map((label) => (
                  <option key={label} value={label}>
                    {label.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Feedback comment
            <textarea name="comment" maxLength={4000} />
          </label>
          <label>
            Expected response (optional)
            <textarea name="correction" maxLength={24000} />
          </label>
          <label>
            Correction reason
            <input
              name="reason"
              aria-label="Correction reason"
              maxLength={4000}
            />
            <small>Required when providing an expected response.</small>
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <Button disabled={busy}>{busy ? "Saving…" : "Save review"}</Button>
        </form>
      )}
    </div>
  );
}
