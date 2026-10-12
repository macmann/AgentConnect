"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { permitted, type Role } from "@agentconnect/schemas/foundation";
import { ChatMarkdown } from "./chat-markdown";
import { Citations, type Citation } from "./citations";
import { Button } from "./button";
import { requestJson } from "./agent-client";
type Issue = {
  id: string;
  message_id: string;
  status: string;
  reason: string;
  comment: string;
  question: string;
  answer: string;
  agent_name: string;
  revision: number;
  assigned_to: string | null;
  assignee_name: string | null;
  improvement_id: string | null;
  improvement_status: string | null;
  knowledge_base_id: string | null;
  verification_release_id: string | null;
  resolution: string | null;
};
export function AnswerIssues({
  workspaceId,
  role,
}: {
  workspaceId: string;
  role: Role;
}) {
  const cache = useQueryClient(),
    [status, setStatus] = useState("reported"),
    [cursor, setCursor] = useState<{ before: string; beforeId: string } | null>(
      null,
    ),
    [current, setCurrent] = useState<Issue | null>(null),
    [note, setNote] = useState(""),
    [kb, setKB] = useState(""),
    [answer, setAnswer] = useState(""),
    [question, setQuestion] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const base = `/workspaces/${workspaceId}/operations/answer-issues`;
  const issues = useQuery({
    queryKey: ["answer-issues", workspaceId, status, cursor],
    queryFn: () =>
      requestJson<{
        issues: (Issue & { updated_at: string })[];
        hasMore: boolean;
      }>(base + "?" + new URLSearchParams({ status, ...cursor })),
    refetchInterval: 10000,
  });
  const me = useQuery({
    queryKey: ["auth-me"],
    queryFn: () => requestJson<{ id: string }>("/auth/me"),
  });
  const bases = useQuery({
    queryKey: ["issue-knowledge", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string; approval_required: boolean }[]>(
        `/workspaces/${workspaceId}/knowledge-bases`,
      ),
  });
  const detail = useQuery({
    queryKey: ["answer-issue-events", current?.id, current?.revision],
    queryFn: () =>
      requestJson<{
        answer: string;
        citations: Citation[];
        events: {
          kind: string;
          note: string;
          created_at: string;
          actor: string | null;
        }[];
      }>(base + "/" + current!.id),
    enabled: !!current,
  });
  async function act(path: string, data: unknown) {
    setBusy(true);
    setError("");
    try {
      await requestJson(base + path, "POST", data);
      setCurrent(null);
      setNote("");
      await cache.invalidateQueries({
        queryKey: ["answer-issues", workspaceId],
      });
      await cache.invalidateQueries({
        queryKey: ["knowledge-gaps", workspaceId],
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function navigate(view: string, section?: string) {
    const params = new URLSearchParams(window.location.hash.slice(1));
    params.set("view", view);
    if (section) params.set("operationsSection", section);
    window.location.hash = params.toString();
  }
  return (
    <section aria-label="Answer review queue">
      <h3>Answer review queue</h3>
      <p>
        Claim a report, propose a correction, get independent approval, verify
        it against the affected agents, then publish and close. Customer
        feedback never updates live knowledge automatically.
      </p>
      <label>
        Report status
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setCursor(null);
            setCurrent(null);
          }}
        >
          {[
            "reported",
            "reviewing",
            "fix_ready",
            "verified",
            "closed",
            "all",
          ].map((v) => (
            <option key={v} value={v}>
              {v.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </label>
      {(error || issues.error) && (
        <p role="alert" className="error-banner">
          {error || issues.error?.message}
        </p>
      )}
      {issues.isPending && <p>Loading reports…</p>}
      {issues.data?.issues.length === 0 && <p>No reports in this status.</p>}
      <div className="configure-starters">
        {issues.data?.issues.map((i) => (
          <article key={i.id} className="configure-group">
            <h4>{i.question || "Customer answer report"}</h4>
            <p>
              {i.agent_name} · {i.reason.replaceAll("_", " ")} ·{" "}
              {i.status.replaceAll("_", " ")} ·{" "}
              {i.assignee_name || "Unassigned"}
            </p>
            <p>{i.comment}</p>
            <Button
              className="secondary"
              onClick={() => {
                setCurrent(i);
                setQuestion(i.question || "");
                setAnswer("");
                setNote("");
                setError("");
              }}
            >
              Review report
            </Button>
          </article>
        ))}
      </div>
      {issues.data?.hasMore && (
        <Button
          onClick={() => {
            const i = issues.data!.issues.at(-1)!;
            setCursor({ before: i.updated_at, beforeId: i.id });
            setCurrent(null);
          }}
        >
          Next reports
        </Button>
      )}
      {cursor && (
        <Button className="secondary" onClick={() => setCursor(null)}>
          First reports
        </Button>
      )}
      {current && (
        <div className="configure-group" aria-label="Selected answer report">
          <h4>Review: {current.question}</h4>
          <strong>Original answer</strong>
          <ChatMarkdown content={detail.data?.answer ?? current.answer} />
          {detail.data?.citations && (
            <Citations
              sources={detail.data.citations}
              label="Original answer sources"
            />
          )}
          <p>Customer report: {current.comment || current.reason}</p>
          <p>Status: {current.status.replaceAll("_", " ")}</p>
          <label>
            Review note
            <textarea
              maxLength={2000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="actions">
            {!current.assigned_to && current.status !== "closed" && (
              <Button
                disabled={busy}
                onClick={() =>
                  void act("/" + current.id, {
                    action: "claim",
                    revision: current.revision,
                  })
                }
              >
                Claim report
              </Button>
            )}
            {current.assigned_to === me.data?.id && (
              <>
                <Button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act("/" + current.id, {
                      action: "release",
                      revision: current.revision,
                    })
                  }
                >
                  Release assignment
                </Button>
                {current.status !== "closed" && (
                  <Button
                    className="secondary"
                    disabled={busy || !note.trim()}
                    onClick={() =>
                      void act("/" + current.id, {
                        action: "dismiss",
                        revision: current.revision,
                        note,
                      })
                    }
                  >
                    Dismiss with reason
                  </Button>
                )}
                {current.status === "verified" && (
                  <Button
                    disabled={busy || !note.trim()}
                    onClick={() =>
                      void act("/" + current.id, {
                        action: "close",
                        revision: current.revision,
                        note,
                      })
                    }
                  >
                    Confirm verification and close
                  </Button>
                )}
                {current.status === "closed" && (
                  <Button
                    disabled={busy || !note.trim()}
                    onClick={() =>
                      void act("/" + current.id, {
                        action: "reopen",
                        revision: current.revision,
                        note,
                      })
                    }
                  >
                    Reopen report
                  </Button>
                )}
              </>
            )}
          </div>
          {current.assigned_to === me.data?.id &&
            current.status === "reviewing" &&
            permitted(role, "knowledge:manage") && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act("/" + current.id + "/correction", {
                    revision: current.revision,
                    knowledgeBaseId: kb,
                    question,
                    answer,
                    reason: note,
                  });
                }}
              >
                <label>
                  Correction knowledge base
                  <select
                    required
                    value={kb}
                    onChange={(e) => setKB(e.target.value)}
                  >
                    <option value="">Select reviewed knowledge</option>
                    {bases.data
                      ?.filter((b) => b.approval_required)
                      .map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Regression question
                  <input
                    required
                    maxLength={2000}
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                  />
                </label>
                <label>
                  Approved answer proposal
                  <textarea
                    required
                    maxLength={12000}
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                  />
                </label>
                <Button disabled={busy || !note.trim()}>
                  Propose correction for review
                </Button>
                {!bases.data?.some((b) => b.approval_required) && (
                  <p>
                    Create an approval-required knowledge base in Knowledge
                    first.
                  </p>
                )}
              </form>
            )}
          {current.improvement_id && (
            <p>
              Correction: {current.improvement_status}.{" "}
              <button
                className="text-button"
                onClick={() => navigate("Operations", "Knowledge gaps")}
              >
                Review and ingest correction
              </button>
            </p>
          )}
          {current.status === "fix_ready" && (
            <p>
              After approval and ingestion, review the generated regression
              dataset in{" "}
              <button
                className="text-button"
                onClick={() => navigate("Quality")}
              >
                Quality
              </button>
              , then create, review, test and publish a release in{" "}
              <button
                className="text-button"
                onClick={() => navigate("Knowledge")}
              >
                Knowledge
              </button>
              . Unpinned agents use the current release; pinned agents need an
              explicit version update.
            </p>
          )}
          {current.status === "verified" && (
            <p>
              The correction passed candidate-release regressions and was
              published. Confirm the result before closing; this does not claim
              the customer personally confirmed resolution.
            </p>
          )}
          <details>
            <summary>Review history</summary>
            {detail.error && <p role="alert">{detail.error.message}</p>}
            {detail.data?.events.map((e, i) => (
              <p key={i}>
                {e.actor || "Customer"} · {e.kind.replaceAll("_", " ")} ·{" "}
                {new Date(e.created_at).toLocaleString()}
                <br />
                {e.note}
              </p>
            ))}
          </details>
        </div>
      )}
    </section>
  );
}
