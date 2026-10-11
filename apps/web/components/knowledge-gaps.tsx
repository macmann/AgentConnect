"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { requestJson } from "./agent-client";
import { permitted, type Role } from "@agentconnect/schemas/foundation";
import { Button } from "./button";
type Gap = {
  key: string;
  question: string;
  count: number;
  reasons: string[];
  suggestion: string;
  examples: {
    run_id: string;
    conversation_id: string;
    review_id: string | null;
    corrected_response: string | null;
    question: string;
  }[];
};
type Improvement = {
  id: string;
  question: string;
  answer: string;
  knowledge_name: string;
  status: string;
  author_id: string;
  review_note: string;
};
export function KnowledgeGaps({
  workspaceId,
  role,
}: {
  workspaceId: string;
  role: Role;
}) {
  const cache = useQueryClient(),
    base = `/workspaces/${workspaceId}/operations`,
    [days, setDays] = useState(30),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<{
      reviewId: string;
      question: string;
      answer: string;
      knowledgeBaseId: string;
    } | null>(null),
    [notes, setNotes] = useState<Record<string, string>>({});
  const gaps = useQuery({
      queryKey: ["knowledge-gaps", workspaceId, days],
      queryFn: () =>
        requestJson<{
          groups: Gap[];
          drafts: Improvement[];
          truncated: boolean;
          method: string;
        }>(`${base}/knowledge-gaps?days=${days}`),
    }),
    knowledge = useQuery({
      queryKey: ["gap-knowledge", workspaceId],
      queryFn: () =>
        requestJson<{ id: string; name: string; approval_required: boolean }[]>(
          `/workspaces/${workspaceId}/knowledge-bases`,
        ),
    });
  const canDraft = permitted(role, "knowledge:manage"),
    canApprove = permitted(role, "knowledge:approve");
  async function act(path: string, data: unknown) {
    setBusy(true);
    setError("");
    try {
      await requestJson(base + path, "POST", data);
      setEditing(null);
      await cache.invalidateQueries({
        queryKey: ["knowledge-gaps", workspaceId],
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h3>Knowledge-gap improvement</h3>
      <p className="muted">
        Unanswered and poorly reviewed questions are grouped by normalized text.
        Review proposed content before turning it into approved knowledge.
      </p>
      <label>
        Question review window
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </label>
      {(error || gaps.error) && (
        <p role="alert">{error || gaps.error?.message}</p>
      )}
      {gaps.isPending && <p role="status">Loading knowledge gaps…</p>}
      {gaps.data?.truncated && (
        <p>
          Showing the most recent 1,000 affected runs. Narrow the range to
          review more.
        </p>
      )}
      {gaps.data && !gaps.data.groups.length && (
        <p>No unanswered or poorly reviewed questions in this range.</p>
      )}
      {gaps.data?.groups.map((g) => (
        <details className="knowledge-gap-row" key={g.key}>
          <summary>
            {g.question} · {g.count} occurrences
          </summary>
          <p>{g.reasons.join(" · ")}</p>
          <p>{g.suggestion}</p>
          {g.examples.map((e) => (
            <div key={e.run_id}>
              <p>{e.question}</p>
              {e.corrected_response && e.review_id && canDraft ? (
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setEditing({
                      reviewId: e.review_id!,
                      question: e.question,
                      answer: e.corrected_response!,
                      knowledgeBaseId: "",
                    })
                  }
                >
                  Turn correction into knowledge draft
                </Button>
              ) : (
                <p className="muted">
                  Add a corrected response in Conversations before proposing
                  knowledge.
                </p>
              )}
            </div>
          ))}
        </details>
      ))}
      {editing && (
        <fieldset disabled={busy}>
          <h4>Proposed knowledge correction</h4>
          <label>
            Approval-required knowledge base
            <select
              aria-label="Approval-required knowledge base"
              value={editing.knowledgeBaseId}
              onChange={(e) =>
                setEditing({ ...editing, knowledgeBaseId: e.target.value })
              }
            >
              <option value="">Select knowledge base</option>
              {knowledge.data
                ?.filter((k) => k.approval_required)
                .map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Question
            <textarea
              value={editing.question}
              maxLength={2000}
              onChange={(e) =>
                setEditing({ ...editing, question: e.target.value })
              }
            />
          </label>
          <label>
            Proposed answer
            <textarea
              value={editing.answer}
              maxLength={12000}
              onChange={(e) =>
                setEditing({ ...editing, answer: e.target.value })
              }
            />
          </label>
          <Button
            type="button"
            disabled={!editing.knowledgeBaseId}
            onClick={() => void act("/knowledge-improvements", editing)}
          >
            Create review draft
          </Button>
          <Button
            type="button"
            className="secondary"
            onClick={() => setEditing(null)}
          >
            Cancel
          </Button>
        </fieldset>
      )}
      <h4>Knowledge correction drafts</h4>
      {gaps.data?.drafts.map((d) => (
        <details className="knowledge-gap-row" key={d.id}>
          <summary>
            {d.question} · {d.status}
          </summary>
          <p>{d.knowledge_name}</p>
          <p style={{ whiteSpace: "pre-wrap" }}>{d.answer}</p>
          {d.review_note && <p>Review: {d.review_note}</p>}
          {canApprove && d.status === "draft" && (
            <>
              <label>
                Review note
                <textarea
                  maxLength={2000}
                  value={notes[d.id] ?? ""}
                  onChange={(e) =>
                    setNotes({ ...notes, [d.id]: e.target.value })
                  }
                />
              </label>
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act("/knowledge-improvements/" + d.id, {
                    action: "approve",
                    note: notes[d.id] ?? "",
                  })
                }
              >
                Approve correction
              </Button>
              <Button
                type="button"
                className="secondary"
                disabled={busy || !notes[d.id]?.trim()}
                onClick={() =>
                  void act("/knowledge-improvements/" + d.id, {
                    action: "reject",
                    note: notes[d.id] ?? "",
                  })
                }
              >
                Reject
              </Button>
              <p className="muted">
                The author cannot approve their own draft.
              </p>
            </>
          )}
          {canApprove && d.status === "approved" && (
            <>
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act("/knowledge-improvements/" + d.id, {
                    action: "materialize",
                  })
                }
              >
                Add as unpublished knowledge source
              </Button>
              <p className="muted">
                After indexing, include the source in a reviewed knowledge
                release. It is not live until publication.
              </p>
            </>
          )}
        </details>
      ))}
    </section>
  );
}
