"use client";
import { useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { Plus, RefreshCw, Search, Inbox, X } from "lucide-react";
import { permitted, type Role } from "@agentconnect/schemas/foundation";
import {
  supportCaseStatus,
  type SupportPage,
  type SupportCursor,
  type SupportQueue,
  type SupportCaseView,
  type SupportOperator,
} from "@agentconnect/schemas/support";
import { requestJson } from "./agent-client";
import { Button } from "./button";
import { SupportCasePanel } from "./support-case-panel";
import {
  supportCursor,
  caseLabel,
  statusLabel,
  supportTime,
} from "./support-utils";
export function SupportStudio({
  workspaceId,
  userId,
  role,
}: {
  workspaceId: string;
  userId: string;
  role: Role;
}) {
  const base = `/workspaces/${workspaceId}/support`,
    cache = useQueryClient();
  const [selected, setSelected] = useState(""),
    [scope, setScope] = useState("open"),
    [status, setStatus] = useState(""),
    [queue, setQueue] = useState(""),
    [priority, setPriority] = useState(""),
    [channel, setChannel] = useState(""),
    [operator, setOperator] = useState(""),
    [searchDraft, setSearchDraft] = useState(""),
    [search, setSearch] = useState("");
  const draft = useRef(false);
  useEffect(() => {
    const read = () => {
      const value =
        new URLSearchParams(window.location.hash.slice(1)).get("supportCase") ??
        "";
      setSelected(/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(value) ? value : "");
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  function select(id: string) {
    if (draft.current && !window.confirm("Discard the unsaved support draft?"))
      return false;
    draft.current = false;
    const hash = new URLSearchParams(window.location.hash.slice(1));
    if (id) hash.set("supportCase", id);
    else hash.delete("supportCase");
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search + "#" + hash.toString(),
    );
    setSelected(id);
    return true;
  }
  const canView = permitted(role, "support:view");
  const filters = new URLSearchParams({ scope });
  if (status) filters.set("status", status);
  if (queue) filters.set("queueId", queue);
  if (priority) filters.set("priority", priority);
  if (channel) filters.set("channel", channel);
  if (operator) filters.set("assignedOperatorId", operator);
  if (search) filters.set("search", search);
  const queues = useInfiniteQuery({
    queryKey: ["support", workspaceId, "queues"],
    initialPageParam: null as SupportCursor | null,
    queryFn: ({ pageParam }) =>
      requestJson<SupportPage<SupportQueue>>(
        base + "/queues?limit=50" + supportCursor(pageParam),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    enabled: canView,
  });
  const operators = useInfiniteQuery({
    queryKey: ["support", workspaceId, "operators"],
    initialPageParam: null as SupportCursor | null,
    queryFn: ({ pageParam }) =>
      requestJson<SupportPage<SupportOperator>>(
        base + "/operators?limit=50" + supportCursor(pageParam),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    enabled: canView,
  });
  const cases = useInfiniteQuery({
    queryKey: ["support", workspaceId, "cases", filters.toString()],
    initialPageParam: null as SupportCursor | null,
    queryFn: ({ pageParam }) =>
      requestJson<SupportPage<SupportCaseView>>(
        base + "/cases?" + filters + "&limit=25" + supportCursor(pageParam),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    enabled: canView,
    refetchInterval: 5000,
  });
  const summary = useQuery({
    queryKey: ["support", workspaceId, "summary", queue],
    queryFn: () =>
      requestJson<{
        waiting: number;
        active: number;
        unassigned: number;
        mine: number;
      }>(base + "/summary" + (queue ? "?queueId=" + queue : "")),
    enabled: canView,
    refetchInterval: 5000,
  });
  const items = cases.data?.pages.flatMap((p) => p.items) ?? [],
    allQueues = queues.data?.pages.flatMap((p) => p.items) ?? [];
  function filter(change: () => void) {
    if (select("")) change();
  }
  if (!canView)
    return (
      <section className="panel">
        <p className="empty">
          Your workspace role does not have access to Human Support. Ask a
          workspace administrator for access.
        </p>
      </section>
    );
  return (
    <div className="support-studio">
      <section aria-label="Support overview" className="support-summary">
        {(
          [
            ["Waiting", "waiting", "waiting"],
            ["Active", "active", "active"],
            ["Unassigned", "unassigned", "unassigned"],
            ["My cases", "mine", "mine"],
          ] as const
        ).map(([label, key, target]) => (
          <button
            key={key}
            className="support-count"
            onClick={() =>
              filter(() => {
                setScope(target);
                setStatus("");
              })
            }
          >
            <span>{label}</span>
            <strong>{summary.data?.[key] ?? "—"}</strong>
          </button>
        ))}
      </section>
      {summary.error && (
        <p className="error" role="alert">
          {summary.error.message}{" "}
          <Button className="secondary" onClick={() => void summary.refetch()}>
            Retry counts
          </Button>
        </p>
      )}
      <section className="panel support-filters" aria-label="Case filters">
        <label>
          Cases
          <select
            aria-label="Cases"
            value={scope}
            onChange={(e) => filter(() => setScope(e.target.value))}
          >
            <option value="open">Open cases</option>
            <option value="waiting">Waiting cases</option>
            <option value="active">Active cases</option>
            <option value="mine">My open cases</option>
            <option value="unassigned">Unassigned cases</option>
            <option value="all">All cases</option>
          </select>
        </label>
        <label>
          Queue
          <select
            aria-label="Queue"
            value={queue}
            onChange={(e) => filter(() => setQueue(e.target.value))}
          >
            <option value="">All queues</option>
            {allQueues.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
                {q.enabled ? "" : " (disabled)"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Assigned operator
          <select
            aria-label="Assigned operator"
            value={operator}
            onChange={(e) =>
              filter(() => {
                setOperator(e.target.value);
                if (e.target.value) setScope("all");
              })
            }
          >
            <option value="">Any operator</option>
            {operators.data?.pages
              .flatMap((p) => p.items)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Status
          <select
            aria-label="Status"
            value={status}
            onChange={(e) =>
              filter(() => {
                setStatus(e.target.value);
                if (
                  ["resolved", "closed", "cancelled"].includes(e.target.value)
                )
                  setScope("all");
              })
            }
          >
            <option value="">Any status</option>
            {supportCaseStatus.options.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select
            aria-label="Priority"
            value={priority}
            onChange={(e) => filter(() => setPriority(e.target.value))}
          >
            <option value="">Any priority</option>
            {["low", "normal", "high", "urgent"].map((p) => (
              <option key={p} value={p}>
                {statusLabel(p)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Channel
          <select
            aria-label="Channel"
            value={channel}
            onChange={(e) => filter(() => setChannel(e.target.value))}
          >
            <option value="">Any channel</option>
            <option value="widget">Website widget</option>
            <option value="hosted">Hosted chat</option>
            <option value="playground">Playground</option>
          </select>
        </label>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            filter(() => setSearch(searchDraft.trim()));
          }}
          className="support-search"
        >
          <label>
            Search cases
            <input
              maxLength={100}
              placeholder="Name, issue, case or conversation ID"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
            />
          </label>
          <Button type="submit" className="secondary" aria-label="Search cases">
            <Search size={16} />
          </Button>
        </form>
        <div className="support-filter-actions">
          <Button
            className="secondary"
            onClick={() => {
              if (!select("")) return;
              setOperator("");
              setScope("open");
              setStatus("");
              setQueue("");
              setPriority("");
              setChannel("");
              setSearch("");
              setSearchDraft("");
            }}
          >
            Reset filters
          </Button>
          <Button
            className="secondary"
            aria-label="Refresh support inbox"
            disabled={cases.isFetching}
            onClick={() =>
              void cache.invalidateQueries({
                queryKey: ["support", workspaceId],
              })
            }
          >
            <RefreshCw size={16} />
          </Button>
          {permitted(role, "support:queue:manage") && (
            <CreateQueue base={base} workspaceId={workspaceId} />
          )}
        </div>
        {operators.hasNextPage && (
          <Button
            className="secondary"
            disabled={operators.isFetchingNextPage}
            onClick={() => void operators.fetchNextPage()}
          >
            Load more operators
          </Button>
        )}
        {operators.error && (
          <p role="alert" className="error">
            {operators.error.message}{" "}
            <Button onClick={() => void operators.refetch()}>
              Retry operators
            </Button>
          </p>
        )}
        {queues.hasNextPage && (
          <Button
            className="secondary"
            disabled={queues.isFetchingNextPage}
            onClick={() => void queues.fetchNextPage()}
          >
            Load more queues
          </Button>
        )}
        {queues.error && (
          <p className="error" role="alert">
            {queues.error.message}{" "}
            <Button onClick={() => void queues.refetch()}>Retry queues</Button>
          </p>
        )}
        {!queues.isPending && !allQueues.length && (
          <p className="muted">
            No support queues yet.{" "}
            {permitted(role, "support:queue:manage")
              ? "Create a queue to organize requests."
              : "Ask a workspace administrator to create a queue."}{" "}
            Requests can still be claimed from the inbox.
          </p>
        )}
      </section>
      <div className="support-inbox" data-selected={!!selected}>
        <section className="panel support-case-list" aria-label="Support cases">
          <div className="panel-header">
            <h2>Inbox</h2>
            <small>{items.length} loaded</small>
          </div>
          {cases.isPending && (
            <p className="empty" role="status">
              Loading support cases…
            </p>
          )}
          {cases.error && (
            <div className="empty">
              <p className="error" role="alert">
                {cases.error.message}
              </p>
              <Button onClick={() => void cases.refetch()}>Retry cases</Button>
            </div>
          )}
          {!cases.isPending && !cases.error && !items.length && (
            <div className="empty">
              <Inbox size={28} />
              <h3>No matching cases</h3>
              <p>
                New human support requests appear here. Adjust your filters to
                view past requests.
              </p>
            </div>
          )}
          {items.map((s) => (
            <button
              key={s.id}
              className={
                "support-case-card" + (s.id === selected ? " selected" : "")
              }
              aria-pressed={s.id === selected}
              onClick={() => {
                if (s.id !== selected) select(s.id);
              }}
              aria-label={`Open ${caseLabel(s.id)} for ${s.customer_name}`}
            >
              <span className="support-card-heading">
                <strong>{s.customer_name}</strong>
                <span className={"support-badge priority-" + s.priority}>
                  {statusLabel(s.priority)}
                </span>
              </span>
              <span className="support-case-issue">
                {s.reason_text || s.latest_message || s.agent_name}
              </span>
              <span className="support-card-meta">
                <span>{statusLabel(s.status)}</span>
                <span>{s.queue_name ?? "No queue"}</span>
              </span>
              <span className="support-card-meta">
                <span>{s.assigned_operator_name ?? "Unassigned"}</span>
                <time dateTime={s.created_at}>{supportTime(s.created_at)}</time>
              </span>
              <small>
                {caseLabel(s.id)} · {statusLabel(s.channel)}
              </small>
            </button>
          ))}
          {cases.hasNextPage && (
            <Button
              className="secondary support-more"
              disabled={cases.isFetchingNextPage}
              onClick={() => void cases.fetchNextPage()}
            >
              {cases.isFetchingNextPage ? "Loading…" : "Load more cases"}
            </Button>
          )}
        </section>
        {selected ? (
          <SupportCasePanel
            key={workspaceId + selected}
            base={base}
            workspaceId={workspaceId}
            caseId={selected}
            userId={userId}
            role={role}
            queues={allQueues}
            onBack={() => select("")}
            onDraftChange={(dirty) => {
              draft.current = dirty;
            }}
          />
        ) : (
          <section className="panel support-unselected">
            <Inbox size={36} />
            <h2>Select a support case</h2>
            <p>
              Review the conversation, accept a request and continue with the
              customer.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
function CreateQueue({
  base,
  workspaceId,
}: {
  base: string;
  workspaceId: string;
}) {
  const cache = useQueryClient(),
    [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    setError("");
    try {
      await requestJson(base + "/queues", "POST", { name, description });
      await cache.invalidateQueries({
        queryKey: ["support", workspaceId, "queues"],
      });
      setName("");
      setDescription("");
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!busy) {
          setOpen(v);
          setError("");
        }
      }}
    >
      <Dialog.Trigger asChild>
        <Button className="secondary">
          <Plus size={16} />
          Create queue
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title>Create support queue</Dialog.Title>
          <Dialog.Description>
            Organize cases for manual assignment. Automated routing follows in a
            later release.
          </Dialog.Description>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label>
              Queue name
              <input
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </label>
            <label>
              Description
              <textarea
                maxLength={1000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="support-dialog-actions">
              <Button disabled={busy || !name.trim()} type="submit">
                {busy ? "Creating…" : "Create queue"}
              </Button>
              <Dialog.Close asChild>
                <Button disabled={busy} className="secondary" type="button">
                  Cancel
                </Button>
              </Dialog.Close>
            </div>
          </form>
          <Dialog.Close asChild>
            <button
              disabled={busy}
              className="dialog-close"
              aria-label="Close dialog"
            >
              <X size={18} />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
