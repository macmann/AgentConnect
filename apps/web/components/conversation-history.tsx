"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { permitted, type Role } from "@agentconnect/schemas/foundation";
import { Button } from "./button";
import { requestJson } from "./agent-client";
import { ChatMarkdown } from "./chat-markdown";
import { Citations, type Citation } from "./citations";
import { GenerativeResponse } from "./generative-response";
import type { RenderedBlock } from "@agentconnect/schemas/generative";
import { MessageReview } from "./message-review";
import { WorkspaceRecordLink } from "./workspace-record-link";
type Cursor = { before: string; beforeId: string };
type Page<T> = { items: T[]; nextCursor: Cursor | null };
type Session = {
  id: string;
  agent_id: string;
  agent_name: string;
  customer_name: string;
  identity_type: string;
  channel: string;
  conversation_mode: string;
  created_at: string;
  latest_message?: string;
  status?: string;
  run_status?: string;
  customer_session_id?: string;
};
type Entry = {
  id: string;
  role: string;
  content: string;
  created_at: string;
  actor_name: string | null;
  origin: string;
  error_code?: string;
  citations: Citation[];
  ui_blocks: RenderedBlock[];
};
type Golden = {
  id: string;
  knowledge_base_id: string;
  message_id: string;
  status: string;
};
const label = (s: string) => s.replaceAll("_", " ");
const time = (s: string) => new Date(s).toLocaleString();
export function Conversations({
  workspaceId,
  role,
  agentId,
}: {
  workspaceId: string;
  role: string;
  agentId?: string;
}) {
  const [selected, setSelected] = useState(""),
    [ready, setReady] = useState(false),
    [filters, setFilters] = useState<Record<string, string>>({
      agentId: agentId ?? "",
      fromDate: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
    }),
    [search, setSearch] = useState(""),
    [live, setLive] = useState(true),
    [follow, setFollow] = useState(true),
    [editing, setEditing] = useState<{ entry: Entry; question: string } | null>(
      null,
    );
  const transcript = useRef<HTMLDivElement>(null),
    cache = useQueryClient(),
    canView = permitted(role as Role, "conversation:view"),
    canSave =
      permitted(role as Role, "conversation:review") &&
      permitted(role as Role, "knowledge:manage");
  useEffect(() => {
    const read = () => {
      const p = new URLSearchParams(location.hash.slice(1));
      setSelected(p.get("conversation") ?? "");
      setFilters((current) => ({
        ...current,
        agentId: agentId ?? p.get("historyAgent") ?? "",
        ...(p.has("conversation") ? { fromDate: "" } : {}),
      }));
      setReady(true);
    };
    read();
    window.addEventListener("hashchange", read);
    window.addEventListener("popstate", read);
    return () => {
      window.removeEventListener("hashchange", read);
      window.removeEventListener("popstate", read);
    };
  }, [agentId]);
  const base = `/workspaces/${workspaceId}/conversation-history`,
    query = new URLSearchParams(
      Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
    );
  const sessions = useInfiniteQuery({
    queryKey: ["history", workspaceId, query.toString()],
    initialPageParam: null as Cursor | null,
    queryFn: ({ pageParam }) =>
      requestJson<Page<Session>>(
        `${base}?${query}&${new URLSearchParams(pageParam ?? {})}`,
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    enabled: canView && ready,
    refetchInterval: live ? 3000 : false,
  });
  const detail = useQuery({
    queryKey: ["history-detail", workspaceId, selected],
    queryFn: () =>
      requestJson<Session & { goldenAnswers: Golden[] }>(`${base}/${selected}`),
    enabled: canView && !!selected,
    refetchInterval: live ? 3000 : false,
  });
  const timeline = useInfiniteQuery({
    queryKey: ["history-timeline", workspaceId, selected],
    initialPageParam: null as Cursor | null,
    queryFn: ({ pageParam }) =>
      requestJson<Page<Entry>>(
        `${base}/${selected}/timeline?limit=50&${new URLSearchParams(pageParam ?? {})}`,
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    enabled: canView && !!selected,
    refetchInterval: live ? 3000 : false,
  });
  const agents = useQuery({
    queryKey: ["agents", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(
        `/workspaces/${workspaceId}/agents`,
      ),
    enabled: canView && !agentId,
  });
  const rows = [
    ...new Map(
      sessions.data?.pages.flatMap((p) => p.items).map((s) => [s.id, s]) ?? [],
    ).values(),
  ];
  const entries = [
    ...new Map(
      timeline.data?.pages.flatMap((p) => p.items).map((m) => [m.id, m]) ?? [],
    ).values(),
  ].sort(
    (a, b) =>
      a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  const newest = entries.at(-1)?.id;
  useEffect(() => {
    if (follow && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [newest, selected, follow]);
  function select(value: string) {
    setSelected(value);
    const p = new URLSearchParams(location.hash.slice(1));
    if (value) p.set("conversation", value);
    else p.delete("conversation");
    history.replaceState({}, "", `#${p}`);
  }
  function filter(key: string, value: string) {
    select("");
    setFilters((current) => ({ ...current, [key]: value }));
  }
  if (!canView)
    return (
      <p className="notice">Your role cannot view conversation history.</p>
    );
  return (
    <section className="conversation-history" aria-label="Conversation history">
      <header className="history-heading">
        <div>
          <h2>Conversation history</h2>
          <p>AI and human conversations, organized by session.</p>
        </div>
        <div className="history-live-controls">
          <label>
            <input
              type="checkbox"
              checked={live}
              onChange={(e) => setLive(e.target.checked)}
            />
            Live updates
          </label>
          <label>
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => setFollow(e.target.checked)}
            />
            Follow newest
          </label>
          <small>{live ? "Refreshes every 3 seconds" : "Updates paused"}</small>
          <Button
            className="secondary"
            onClick={() => {
              void sessions.refetch();
              if (selected) {
                void detail.refetch();
                void timeline.refetch();
              }
            }}
          >
            Refresh
          </Button>
        </div>
      </header>
      <form
        className="panel history-filters"
        aria-label="Conversation filters"
        onSubmit={(e) => {
          e.preventDefault();
          filter("search", search.trim());
        }}
      >
        {!agentId && (
          <label>
            Agent
            <select
              value={filters.agentId ?? ""}
              onChange={(e) => filter("agentId", e.target.value)}
            >
              <option value="">All agents</option>
              {agents.data?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {(
          [
            [
              "channel",
              "Channel",
              [
                "playground",
                "hosted",
                "widget",
                "api",
                "messenger",
                "viber",
                "telegram",
                "teams",
              ],
            ],
            ["identity", "Identity", ["anonymous", "registered", "api_client"]],
            [
              "mode",
              "Handled by",
              ["ai", "waiting_human", "human", "returning_to_ai"],
            ],
            [
              "status",
              "Run status",
              ["running", "completed", "failed", "cancelled"],
            ],
            ["rating", "Rating", ["like", "dislike"]],
          ] as const
        ).map(([key, title, options]) => (
          <label key={key}>
            {title}
            <select
              aria-label={key === "rating" ? "Rating filter" : title}
              value={filters[key] ?? ""}
              onChange={(e) => filter(key, e.target.value)}
            >
              <option value="">All {title.toLowerCase()}</option>
              {options.map((v) => (
                <option key={v} value={v}>
                  {label(v)}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label>
          From (UTC)
          <input
            type="date"
            value={filters.fromDate ?? ""}
            onChange={(e) => filter("fromDate", e.target.value)}
          />
        </label>
        <label>
          Through (UTC)
          <input
            type="date"
            min={filters.fromDate || undefined}
            value={filters.toDate ?? ""}
            onChange={(e) => filter("toDate", e.target.value)}
          />
        </label>
        <label>
          Search sessions
          <input
            value={search}
            maxLength={200}
            placeholder="Name, session ID or message"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <Button type="submit" className="secondary">
          Search
        </Button>
        <Button
          type="button"
          className="secondary"
          onClick={() => {
            select("");
            setFilters({ agentId: agentId ?? "" });
            setSearch("");
          }}
        >
          Reset filters
        </Button>
      </form>
      <div className="history-layout" data-selected={!!selected}>
        <aside
          className="panel history-sessions"
          aria-label="Conversation sessions"
        >
          <div className="panel-header">
            <h3>Sessions</h3>
            <small>{rows.length} loaded</small>
          </div>
          {sessions.isPending && <p role="status">Loading conversations…</p>}
          {sessions.error && (
            <p role="alert" className="error">
              {sessions.error.message}
            </p>
          )}
          {!sessions.isPending && !sessions.error && !rows.length && (
            <p className="empty">No conversations match these filters.</p>
          )}
          {rows.map((s) => (
            <button
              key={s.id}
              className={`history-session ${selected === s.id ? "selected" : ""}`}
              aria-pressed={selected === s.id}
              onClick={() => select(s.id)}
            >
              <strong>{s.customer_name}</strong>
              <span>
                {s.agent_name} · {s.channel}
              </span>
              <p>{s.latest_message || "Waiting for messages…"}</p>
              <small>
                {label(s.conversation_mode)} · {s.status ?? "No AI run"}
              </small>
              <small>
                {time(s.created_at)} · {s.id.slice(0, 8)}
              </small>
            </button>
          ))}
          {sessions.hasNextPage && (
            <Button
              className="secondary"
              disabled={sessions.isFetchingNextPage}
              onClick={() => void sessions.fetchNextPage()}
            >
              Load more sessions
            </Button>
          )}
        </aside>
        <section
          className="panel history-transcript"
          aria-label="Session transcript"
        >
          {!selected ? (
            <div className="empty">
              <h3>Select a conversation</h3>
              <p>
                Review AI and human responses, then curate verified answers.
              </p>
            </div>
          ) : (
            <>
              <div className="panel-header">
                <div>
                  <Button
                    className="secondary history-back"
                    onClick={() => select("")}
                  >
                    Back to sessions
                  </Button>
                  <h3>{detail.data?.customer_name ?? "Conversation"}</h3>
                  <small>
                    {detail.data?.agent_name} · {detail.data?.channel} ·{" "}
                    {label(detail.data?.identity_type ?? "")}
                  </small>
                  <small>Session {selected}</small>
                  {detail.data?.customer_session_id && (
                    <small>
                      Visitor session {detail.data.customer_session_id}
                    </small>
                  )}
                </div>
              </div>
              {detail.error && (
                <p role="alert" className="error">
                  {detail.error.message}
                </p>
              )}
              {timeline.error && (
                <p role="alert" className="error">
                  {timeline.error.message}
                </p>
              )}
              {timeline.isPending && <p role="status">Loading messages…</p>}
              {timeline.hasNextPage && (
                <Button
                  className="secondary"
                  disabled={timeline.isFetchingNextPage}
                  onClick={() => void timeline.fetchNextPage()}
                >
                  Load older messages
                </Button>
              )}
              <div
                className="history-messages"
                role="log"
                aria-label="Session messages"
                aria-live="off"
                ref={transcript}
              >
                {entries.map((m, index) => (
                  <article
                    key={m.id}
                    className={`history-message role-${m.role}`}
                  >
                    <header>
                      <strong>
                        {m.role === "assistant"
                          ? "AI assistant"
                          : m.role === "human"
                            ? (m.actor_name ?? "Support agent")
                            : m.role === "user"
                              ? (detail.data?.customer_name ?? "Customer")
                              : "Support event"}
                      </strong>
                      <time dateTime={m.created_at}>{time(m.created_at)}</time>
                    </header>
                    {m.content ? (
                      <ChatMarkdown content={m.content} />
                    ) : (
                      <p className="muted">No response text</p>
                    )}
                    {m.error_code && <p className="error">{m.error_code}</p>}
                    {m.ui_blocks?.length > 0 && (
                      <GenerativeResponse
                        blocks={m.ui_blocks}
                        messageId={m.id}
                        interactive={false}
                      />
                    )}
                    <Citations sources={m.citations ?? []} />
                    {detail.data?.goldenAnswers
                      .filter((g) => g.message_id === m.id)
                      .map((g) => (
                        <p className="history-golden" key={g.id}>
                          Golden Q&A · {g.status}{" "}
                          <WorkspaceRecordLink
                            workspaceId={workspaceId}
                            view="Knowledge"
                            record={{
                              knowledgeBase: g.knowledge_base_id,
                              knowledgeView: "qa",
                            }}
                          >
                            Open Q&A
                          </WorkspaceRecordLink>
                        </p>
                      ))}
                    {m.role === "assistant" && (
                      <MessageReview
                        messageId={m.id}
                        conversationId={selected}
                        canReview={permitted(
                          role as Role,
                          "conversation:review",
                        )}
                      />
                    )}
                    {canSave &&
                      (m.role === "assistant" || m.role === "human") && (
                        <Button
                          className="secondary"
                          onClick={() =>
                            setEditing({
                              entry: m,
                              question:
                                entries
                                  .slice(0, index)
                                  .reverse()
                                  .find((e) => e.role === "user")?.content ??
                                "",
                            })
                          }
                        >
                          Edit & save golden answer
                        </Button>
                      )}
                  </article>
                ))}
              </div>
              {detail.data?.run_status === "running" && (
                <p role="status">
                  AI response in progress. The completed message will appear
                  here.
                </p>
              )}
              {!timeline.isPending && !timeline.error && !entries.length && (
                <p>No messages recorded yet.</p>
              )}
            </>
          )}
        </section>
      </div>
      {editing && (
        <GoldenEditor
          key={editing.entry.id}
          workspaceId={workspaceId}
          conversationId={selected}
          entry={editing.entry}
          initialQuestion={editing.question}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void cache.invalidateQueries({
              queryKey: ["history-detail", workspaceId, selected],
            });
            void cache.invalidateQueries({ queryKey: ["knowledge-sources"] });
          }}
        />
      )}
    </section>
  );
}
function GoldenEditor({
  workspaceId,
  conversationId,
  entry,
  initialQuestion,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  conversationId: string;
  entry: Entry;
  initialQuestion: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [question, setQuestion] = useState(initialQuestion),
    [answer, setAnswer] = useState(entry.content),
    [kb, setKb] = useState(""),
    [reviewed, setReviewed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const bases = useQuery({
    queryKey: ["history-knowledge", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(
        `/workspaces/${workspaceId}/knowledge-bases`,
      ),
  });
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await requestJson(
        `/workspaces/${workspaceId}/conversation-history/${conversationId}/golden-answers`,
        "POST",
        { knowledgeBaseId: kb, messageId: entry.id, question, answer },
      );
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content history-golden-dialog">
          <Dialog.Title>Edit & save golden answer</Dialog.Title>
          <Dialog.Description>
            The original transcript is preserved. Your reviewed answer is stored
            in Q&A with a link to this session. Normal indexing and
            knowledge-release approvals still apply.
          </Dialog.Description>
          <form onSubmit={(e) => void save(e)}>
            <label>
              Knowledge base
              <select
                required
                value={kb}
                onChange={(e) => setKb(e.target.value)}
              >
                <option value="">Choose a knowledge base</option>
                {bases.data?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            {bases.error && (
              <p role="alert" className="error">
                {bases.error.message}
              </p>
            )}
            {bases.data?.length === 0 && (
              <p>Create a knowledge base before saving golden answers.</p>
            )}
            <label>
              Question
              <textarea
                required
                maxLength={2000}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
            </label>
            <label>
              Golden answer
              <textarea
                required
                maxLength={20000}
                rows={8}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                required
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              I reviewed the answer for accuracy and removed private customer
              information before reusing it.
            </label>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="history-editor-actions">
              <Button type="submit" disabled={busy || !reviewed || !kb}>
                {busy ? "Saving…" : "Save golden Q&A"}
              </Button>
              <Button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
