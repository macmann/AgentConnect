"use client";
import { useLayoutEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { ArrowLeft, LockKeyhole, Send, UserRoundCheck } from "lucide-react";
import { permitted, type Role } from "@agentconnect/schemas/foundation";
import {
  isOpenCase,
  type SupportCaseView,
  type SupportCursor,
  type SupportPage,
  type SupportQueue,
  type SupportTimelineItem,
} from "@agentconnect/schemas/support";
import { requestJson } from "./agent-client";
import { Button } from "./button";
import { CaseActionDialog } from "./support-case-dialog";
import {
  supportCursor,
  caseLabel,
  statusLabel,
  supportTime,
} from "./support-utils";
const eventNames: Record<string, string> = {
  "case.created": "Human support requested",
  "case.claimed": "Support specialist joined",
  "case.assigned": "Case assigned",
  "case.resolved": "Case resolved · AI control restored",
  "case.status_changed": "Case status changed",
};
export function SupportCasePanel({
  base,
  workspaceId,
  caseId,
  userId,
  role,
  queues,
  onBack,
  onDraftChange,
}: {
  base: string;
  workspaceId: string;
  caseId: string;
  userId: string;
  role: Role;
  queues: SupportQueue[];
  onBack: () => void;
  onDraftChange: (dirty: boolean) => void;
}) {
  const cache = useQueryClient(),
    [text, setText] = useState(""),
    [composer, setComposer] = useState<"reply" | "note">("reply"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [dialog, setDialog] = useState<"resolve" | "assign" | null>(null),
    [statusChoice, setStatusChoice] = useState("");
  const path = base + `/cases/${caseId}`;
  const detail = useQuery({
    queryKey: ["support", workspaceId, "case", caseId],
    queryFn: () => requestJson<SupportCaseView>(path),
    refetchInterval: 5000,
  });
  const timeline = useInfiniteQuery({
    queryKey: ["support", workspaceId, "timeline", caseId],
    initialPageParam: null as SupportCursor | null,
    queryFn: ({ pageParam }) =>
      requestJson<SupportPage<SupportTimelineItem>>(
        path + "/timeline?limit=50" + supportCursor(pageParam),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    refetchInterval: 5000,
    enabled: !!detail.data,
  });
  const s = detail.data,
    supervise = permitted(role, "support:supervise"),
    own = s?.assigned_operator_id === userId,
    control = supervise || own;
  const open = s ? isOpenCase(s.status) : false,
    canReply =
      !!s &&
      control &&
      ["active", "waiting_customer", "waiting_external"].includes(s.status) &&
      permitted(role, "support:reply"),
    canNote = open && control && permitted(role, "support:note");
  async function refresh() {
    await cache.invalidateQueries({ queryKey: ["support", workspaceId] });
    await cache.invalidateQueries({ queryKey: ["handoffs"] });
  }
  async function act(
    action: string,
    body: unknown = {},
    success = "Case updated",
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await requestJson(path + "/" + action, "POST", body);
      setNotice(success);
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      await refresh();
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    const mode = composer;
    if (
      await act(
        mode === "reply" ? "messages" : "notes",
        { content: text },
        mode === "reply"
          ? "Reply sent to the customer."
          : "Internal note saved. Only support staff can see it.",
      )
    ) {
      setText("");
      onDraftChange(false);
    }
  }
  const entries = timeline.data?.pages.flatMap((p) => p.items) ?? [],
    chronological = [...new Map(entries.map((e) => [e.id, e])).values()].sort(
      (a, b) =>
        a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
    );
  const logRef = useRef<HTMLDivElement>(null),
    pinned = useRef(true),
    previous = useRef({ pages: 0, height: 0 });
  const pageCount = timeline.data?.pages.length ?? 0;
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    if (previous.current.pages > 0 && pageCount > previous.current.pages)
      el.scrollTop += el.scrollHeight - previous.current.height;
    else if (pinned.current || previous.current.pages === 0)
      el.scrollTop = el.scrollHeight;
    previous.current = { pages: pageCount, height: el.scrollHeight };
  }, [chronological.length, pageCount]);
  if (detail.isPending)
    return (
      <section className="panel support-detail">
        <p className="empty" role="status">
          Loading case…
        </p>
      </section>
    );
  if (detail.error || !s)
    return (
      <section className="panel support-detail">
        <div className="empty">
          <Button className="secondary" onClick={onBack}>
            Back to inbox
          </Button>
          <p className="error" role="alert">
            {detail.error?.message ?? "Case unavailable"}
          </p>
          <Button onClick={() => void detail.refetch()}>Retry case</Button>
        </div>
      </section>
    );
  const stateOptions =
    s.status === "assigned"
      ? ["active", "queued"]
      : s.status === "active"
        ? ["waiting_customer", "waiting_external", "queued"]
        : ["waiting_customer", "waiting_external"].includes(s.status)
          ? ["active"]
          : s.status === "resolved"
            ? ["active", "closed"]
            : [];
  return (
    <section className="support-detail" aria-label="Selected support case">
      <header className="panel support-detail-header">
        <div>
          <Button className="secondary support-back" onClick={onBack}>
            <ArrowLeft size={16} />
            Back to inbox
          </Button>
          <h2>{s.customer_name}</h2>
          <p>
            {caseLabel(s.id)} · {s.agent_name}
          </p>
        </div>
        <span className={"support-badge status-" + s.status}>
          {statusLabel(s.status)}
        </span>
      </header>
      <div className="support-detail-grid">
        <section
          className="panel support-conversation"
          aria-label="Conversation timeline"
        >
          <div className="panel-header">
            <h3>Conversation</h3>
            <small>Updates every 5 seconds</small>
          </div>
          <div
            ref={logRef}
            onScroll={() => {
              const el = logRef.current;
              if (el)
                pinned.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 100;
            }}
            className="support-timeline"
            role="log"
            aria-label="Case conversation history"
            aria-live="polite"
            aria-relevant="additions"
          >
            {timeline.isPending && (
              <p role="status" className="empty">
                Loading conversation…
              </p>
            )}
            {timeline.error && (
              <div className="empty">
                <p role="alert" className="error">
                  {timeline.error.message}
                </p>
                <Button
                  className="secondary"
                  onClick={() => void timeline.refetch()}
                >
                  Retry timeline
                </Button>
              </div>
            )}
            {timeline.hasNextPage && (
              <Button
                className="secondary support-more"
                disabled={timeline.isFetchingNextPage}
                onClick={() => void timeline.fetchNextPage()}
              >
                {timeline.isFetchingNextPage
                  ? "Loading…"
                  : "Load earlier messages"}
              </Button>
            )}
            {!timeline.isPending &&
              !timeline.error &&
              !chronological.length && (
                <p className="empty">No conversation entries yet.</p>
              )}
            {chronological.map((entry) => (
              <article
                key={entry.id}
                className={"support-entry kind-" + entry.kind}
              >
                <header>
                  <strong>
                    {entry.kind === "customer" ? (
                      "Customer"
                    ) : entry.kind === "ai" ? (
                      "AI agent"
                    ) : entry.kind === "note" ? (
                      <>
                        <LockKeyhole size={13} />
                        Internal note · {entry.actor_name ?? "Support staff"}
                      </>
                    ) : entry.kind === "operator" ? (
                      `${entry.actor_name ?? "Specialist"} · Human support`
                    ) : (
                      "System"
                    )}
                  </strong>
                  <time dateTime={entry.created_at}>
                    {supportTime(entry.created_at)}
                  </time>
                </header>
                <p>
                  {entry.content ||
                    (entry.event_type
                      ? (eventNames[entry.event_type] ??
                        statusLabel(entry.event_type.replaceAll(".", "_")))
                      : "")}
                </p>
                {entry.kind === "ai" && entry.status !== "completed" && (
                  <small>
                    {statusLabel(entry.status ?? "Unknown")} response
                  </small>
                )}
                {entry.case_id && entry.case_id !== caseId && (
                  <small>
                    Previous intervention · {caseLabel(entry.case_id)}
                  </small>
                )}
              </article>
            ))}
          </div>
          <div className="support-composer">
            {notice && (
              <p role="status" className="support-notice">
                {notice}
              </p>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            {canReply || canNote ? (
              <>
                <div
                  className="support-composer-mode"
                  role="group"
                  aria-label="Message visibility"
                >
                  <Button
                    className={composer === "reply" ? "" : "secondary"}
                    disabled={busy || !canReply}
                    aria-pressed={composer === "reply"}
                    onClick={() => setComposer("reply")}
                  >
                    Customer reply
                  </Button>
                  <Button
                    className={composer === "note" ? "" : "secondary"}
                    disabled={busy || !canNote}
                    aria-pressed={composer === "note"}
                    onClick={() => setComposer("note")}
                  >
                    <LockKeyhole size={14} />
                    Internal note
                  </Button>
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                >
                  <label>
                    {composer === "note" ? "Private note" : "Reply to customer"}
                    <textarea
                      rows={3}
                      maxLength={4000}
                      value={text}
                      onChange={(e) => {
                        setText(e.target.value);
                        onDraftChange(!!e.target.value.trim());
                      }}
                      disabled={
                        busy || (composer === "reply" ? !canReply : !canNote)
                      }
                      placeholder={
                        composer === "note"
                          ? "Add context for support staff only…"
                          : "Write a reply to the customer…"
                      }
                    />
                  </label>
                  <div className="support-composer-footer">
                    <small>
                      {composer === "note"
                        ? "Private · Never sent to the customer"
                        : "Visible to the customer"}
                    </small>
                    <Button
                      type="submit"
                      disabled={
                        busy ||
                        !text.trim() ||
                        (composer === "reply" ? !canReply : !canNote)
                      }
                    >
                      <Send size={15} />
                      {busy
                        ? "Saving…"
                        : composer === "note"
                          ? "Save internal note"
                          : "Send reply"}
                    </Button>
                  </div>
                </form>
              </>
            ) : (
              <p className="muted">
                {!open
                  ? "This case is read-only. Review its resolution in the context panel."
                  : s.status === "queued"
                    ? "Claim or assign this case to continue with the customer."
                    : s.status === "assigned"
                      ? "The assigned operator must accept this case before replying."
                      : "Only the assigned operator or a supervisor can reply."}
              </p>
            )}
          </div>
        </section>
        <aside className="panel support-context" aria-label="Case context">
          <h3>Case context</h3>
          <dl>
            <dt>Queue</dt>
            <dd>{s.queue_name ?? "No queue assigned"}</dd>
            <dt>Operator</dt>
            <dd>{s.assigned_operator_name ?? "Unassigned"}</dd>
            <dt>Priority</dt>
            <dd>{statusLabel(s.priority)}</dd>
            <dt>Channel</dt>
            <dd>{statusLabel(s.channel)}</dd>
            <dt>Conversation control</dt>
            <dd>{statusLabel(s.conversation_mode)}</dd>
            <dt>Requested</dt>
            <dd>{supportTime(s.requested_at)}</dd>
            <dt>Issue</dt>
            <dd>{s.reason_text || statusLabel(s.reason_code)}</dd>
            <dt>Conversation ID</dt>
            <dd className="support-id">{s.conversation_id}</dd>
            <dt>Case ID</dt>
            <dd className="support-id">{s.id}</dd>
          </dl>
          {s.resolution_summary && (
            <div className="support-resolution">
              <h4>Resolution</h4>
              <p>{s.resolution_summary}</p>
              <small>
                {statusLabel(s.resolution_code ?? "resolved")}
                {s.resolved_at ? " · " + supportTime(s.resolved_at) : ""}
              </small>
            </div>
          )}
          <div className="support-case-actions">
            {s.status === "queued" && permitted(role, "support:claim") && (
              <Button
                disabled={busy}
                onClick={() =>
                  void act(
                    "claim",
                    {},
                    "Case claimed. You can now reply to the customer.",
                  )
                }
              >
                <UserRoundCheck size={16} />
                Claim case
              </Button>
            )}
            {s.status === "queued" && permitted(role, "support:assign") && (
              <Button
                disabled={busy}
                className="secondary"
                onClick={() => setDialog("assign")}
              >
                Assign case
              </Button>
            )}
            {s.status === "assigned" &&
              control &&
              permitted(role, "support:resolve") && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void act(
                      "status",
                      { status: "active" },
                      "Case accepted. Human support now controls the conversation.",
                    )
                  }
                >
                  Accept case
                </Button>
              )}
            {canReply && permitted(role, "support:resolve") && (
              <Button disabled={busy} onClick={() => setDialog("resolve")}>
                Resolve and return to AI
              </Button>
            )}
            {control &&
              permitted(role, "support:resolve") &&
              stateOptions.length > 0 && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (
                      statusChoice === "queued" &&
                      !window.confirm(
                        "Return this case to the queue? The operator assignment will be removed.",
                      )
                    )
                      return;
                    void act("status", { status: statusChoice });
                  }}
                >
                  <label>
                    Change case status
                    <select
                      value={statusChoice}
                      onChange={(e) => setStatusChoice(e.target.value)}
                      disabled={busy}
                    >
                      <option value="">Choose a status</option>
                      {stateOptions
                        .filter(
                          (status) =>
                            status !== "active" ||
                            s.status !== "resolved" ||
                            !s.active_support_case_id,
                        )
                        .map((status) => (
                          <option key={status} value={status}>
                            {status === "active" && s.status === "resolved"
                              ? "Reopen case"
                              : status === "queued"
                                ? "Return to queue"
                                : statusLabel(status)}
                          </option>
                        ))}
                    </select>
                  </label>
                  <Button
                    className="secondary"
                    type="submit"
                    disabled={busy || !stateOptions.includes(statusChoice)}
                  >
                    Apply status
                  </Button>
                </form>
              )}
          </div>
        </aside>
      </div>
      <CaseActionDialog
        action={dialog}
        onClose={() => setDialog(null)}
        s={s}
        base={base}
        workspaceId={workspaceId}
        queues={queues}
        busy={busy}
        onSubmit={async (action, body) => {
          if (
            await act(
              action,
              body,
              action === "resolve"
                ? "Case resolved. The customer can chat with AI again."
                : "Case assigned. The selected operator can accept it.",
            )
          ) {
            setDialog(null);
            if (action === "resolve") {
              setText("");
              onDraftChange(false);
            }
          }
        }}
        error={error}
      />
    </section>
  );
}
