"use client";
import { useState } from "react";
import {
  useQuery,
  useInfiniteQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  type OperatorProfile,
  type SupportPage,
  type SupportCursor,
  type SupportQueue,
} from "@agentconnect/schemas/support";
import { Button } from "./button";
import { requestJson } from "./agent-client";
import { supportCursor, statusLabel, supportTime } from "./support-utils";
export type SupportOperationsView =
  "supervision" | "analytics" | "notifications";
type Notification = {
  id: string;
  support_case_id: string;
  kind: string;
  created_at: string;
  read_at: string | null;
};
type MetricRow = {
  id: string;
  name: string;
  backlog?: number;
  cases_created?: number;
  cases_resolved?: number;
  cases_handled?: number;
  active_cases?: number;
  handling_seconds?: number | null;
  first_response_seconds?: number | null;
  transfers?: number;
  reopens?: number;
  warning?: number;
  breached?: number;
};
type Analytics = {
  days: number;
  totals: Record<string, number | null>;
  journeys: Record<string, number>;
  handoffRate: number | null;
  containmentProxy: number | null;
  deflection: null;
  notes: string;
  queues: MetricRow[];
  operators: MetricRow[];
  reasons: { reason_code: string; count: number }[];
  copilot: { generations: number; completed: number; failed: number };
};
const seconds = (n: number | null | undefined) =>
  n == null ? "—" : Math.round(Number(n)) + " s";
const percent = (n: number | null) =>
  n == null ? "—" : (n * 100).toFixed(1) + "%";
export function SupportOperations({
  workspaceId,
  view,
  onSelect,
}: {
  workspaceId: string;
  view: SupportOperationsView;
  onSelect: (id: string) => void;
}) {
  const base = `/workspaces/${workspaceId}/support`,
    cache = useQueryClient();
  const [days, setDays] = useState(30),
    [queue, setQueue] = useState(""),
    [error, setError] = useState("");
  const analytics = useQuery({
    queryKey: ["support", workspaceId, "analytics", days, queue],
    queryFn: () =>
      requestJson<Analytics>(
        base + `/analytics?days=${days}` + (queue ? "&queueId=" + queue : ""),
      ),
    enabled: view === "analytics",
    refetchInterval: 15000,
  });
  const supervision = useQuery({
    queryKey: ["support", workspaceId, "supervision"],
    queryFn: () =>
      requestJson<{
        counts: Record<string, number>;
        operators: OperatorProfile[];
        queues: MetricRow[];
      }>(base + "/supervision"),
    enabled: view === "supervision",
    refetchInterval: 5000,
  });
  const notifications = useInfiniteQuery({
    queryKey: ["support", workspaceId, "notifications"],
    initialPageParam: null as SupportCursor | null,
    queryFn: ({ pageParam }) =>
      requestJson<SupportPage<Notification> & { unread: number }>(
        base + "/notifications?limit=25" + supportCursor(pageParam),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    enabled: view === "notifications",
    refetchInterval: 5000,
  });
  const queues = useInfiniteQuery({
    queryKey: ["support", workspaceId, "queues"],
    initialPageParam: null as SupportCursor | null,
    queryFn: ({ pageParam }) =>
      requestJson<SupportPage<SupportQueue>>(
        base + "/queues?limit=50" + supportCursor(pageParam),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    enabled: view === "analytics",
  });
  const query =
    view === "analytics"
      ? analytics
      : view === "supervision"
        ? supervision
        : notifications;
  return (
    <section
      className="panel support-operations"
      aria-label={statusLabel(view)}
    >
      <div className="panel-heading">
        <div>
          <h2>
            {view === "supervision"
              ? "Supervisor overview"
              : view === "analytics"
                ? "Support analytics"
                : "Support notifications"}
          </h2>
          <p>
            {view === "supervision"
              ? "Live queue health and operator capacity. Open a case from the inbox to act."
              : view === "analytics"
                ? "Retained support journeys, service times and AI continuation."
                : "In-app updates for your assigned cases and eligible queues."}
          </p>
        </div>
        <Button className="secondary" onClick={() => void query.refetch()}>
          Refresh
        </Button>
      </div>
      {(query.error || error) && (
        <p className="error" role="alert">
          {error || query.error?.message}
        </p>
      )}
      {query.isPending && <p role="status">Loading support data…</p>}
      {view === "notifications" && notifications.data && (
        <>
          <p role="status">
            {notifications.data.pages[0]?.unread ?? 0} unread notifications
          </p>
          {notifications.data.pages.flatMap((p) => p.items).length === 0 ? (
            <p className="empty">
              No support notifications yet. Case assignments, customer replies
              and SLA alerts will appear here.
            </p>
          ) : (
            <ul className="support-notifications">
              {notifications.data.pages
                .flatMap((p) => p.items)
                .map((n) => (
                  <li key={n.id} className={n.read_at ? "" : "unread"}>
                    <div>
                      <strong>
                        {statusLabel(n.kind.replaceAll(".", "_"))}
                      </strong>
                      <small>
                        {supportTime(n.created_at)} ·{" "}
                        {n.support_case_id.slice(0, 8)}
                      </small>
                    </div>
                    <Button
                      className="secondary"
                      onClick={async () => {
                        try {
                          await requestJson(
                            base + "/notifications/" + n.id + "/read",
                            "POST",
                            {},
                          );
                          await cache.invalidateQueries({
                            queryKey: ["support", workspaceId, "notifications"],
                          });
                          onSelect(n.support_case_id);
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      Open case
                    </Button>
                  </li>
                ))}
            </ul>
          )}
          {notifications.hasNextPage && (
            <Button
              disabled={notifications.isFetchingNextPage}
              onClick={() => void notifications.fetchNextPage()}
            >
              Load more notifications
            </Button>
          )}
        </>
      )}
      {view === "supervision" && supervision.data && (
        <>
          <div className="support-summary">
            {Object.entries(supervision.data.counts).map(([key, n]) => (
              <div className="support-count" key={key}>
                <span>{statusLabel(key)}</span>
                <strong>{n}</strong>
              </div>
            ))}
          </div>
          <h3>Queue health</h3>
          <MetricTable rows={supervision.data.queues} mode="supervision" />
          <h3>Operator availability and capacity</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Operator</th>
                  <th>Presence</th>
                  <th>Active cases</th>
                  <th>Available capacity</th>
                </tr>
              </thead>
              <tbody>
                {supervision.data.operators.map((p) => (
                  <tr key={p.user_id}>
                    <td>{p.name}</td>
                    <td>{statusLabel(p.effective_presence)}</td>
                    <td>{p.active_case_count}</td>
                    <td>
                      {p.available_capacity} / {p.capacity_limit}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!supervision.data.operators.length && (
            <p className="empty">
              No configured operators. Add profiles under Operators & routing.
            </p>
          )}
          <small>
            Overview lists up to 100 queues and operators. The inbox remains
            paginated.
          </small>
        </>
      )}
      {view === "analytics" && (
        <>
          <div className="form-grid">
            <label>
              Reporting window
              <select
                aria-label="Reporting window"
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                {[7, 30, 90].map((d) => (
                  <option key={d} value={d}>
                    Last {d} days
                  </option>
                ))}
              </select>
            </label>
            <label>
              Analytics queue
              <select
                aria-label="Analytics queue"
                value={queue}
                onChange={(e) => setQueue(e.target.value)}
              >
                <option value="">All queues</option>
                {queues.data?.pages
                  .flatMap((p) => p.items)
                  .map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          {queues.hasNextPage && (
            <Button
              className="secondary"
              onClick={() => void queues.fetchNextPage()}
            >
              Load more queues
            </Button>
          )}
          {analytics.data && (
            <>
              <div className="support-summary">
                {[
                  ["Cases created", analytics.data.totals.cases_created],
                  ["Cases resolved", analytics.data.totals.cases_resolved],
                  ["Backlog (cohort)", analytics.data.totals.backlog],
                  ["Handoff rate", percent(analytics.data.handoffRate)],
                  [
                    "No-handoff proxy",
                    percent(analytics.data.containmentProxy),
                  ],
                  [
                    "AI returns",
                    analytics.data.journeys.returned_to_ai_conversations,
                  ],
                  [
                    "SLA breach rate",
                    percent(
                      analytics.data.totals.sla_eligible_cases
                        ? Number(analytics.data.totals.breached_cases) /
                            Number(analytics.data.totals.sla_eligible_cases)
                        : null,
                    ),
                  ],
                  ["P50 wait", seconds(analytics.data.totals.p50_wait_seconds)],
                  ["P95 wait", seconds(analytics.data.totals.p95_wait_seconds)],
                  [
                    "Average assignment",
                    seconds(analytics.data.totals.assignment_seconds),
                  ],
                  [
                    "Average first response",
                    seconds(analytics.data.totals.first_response_seconds),
                  ],
                  [
                    "Average resolution",
                    seconds(analytics.data.totals.resolution_seconds),
                  ],
                ].map(([label, n]) => (
                  <div className="support-count" key={String(label)}>
                    <span>{label}</span>
                    <strong>{n ?? "—"}</strong>
                  </div>
                ))}
              </div>
              <p className="field-help">
                {analytics.data.notes} No deflection or savings estimate is
                shown without a configured business baseline.
              </p>
              <h3>Queues</h3>
              <MetricTable rows={analytics.data.queues} mode="queues" />
              <h3>Operators</h3>
              <MetricTable rows={analytics.data.operators} mode="operators" />
              <p>
                Copilot: {analytics.data.copilot.completed} completed /{" "}
                {analytics.data.copilot.generations} requests;{" "}
                {analytics.data.copilot.failed} failed.
              </p>
              <h3>Handoff reasons</h3>
              <ul>
                {analytics.data.reasons.map((r) => (
                  <li key={r.reason_code}>
                    {statusLabel(r.reason_code)}: {r.count}
                  </li>
                ))}
              </ul>
              {!analytics.data.reasons.length && (
                <p className="empty">No cases in this reporting window.</p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
function MetricTable({
  rows,
  mode,
}: {
  rows: MetricRow[];
  mode: "supervision" | "queues" | "operators";
}) {
  const columns =
    mode === "supervision"
      ? ["Backlog", "Warning", "Breached"]
      : mode === "queues"
        ? ["Created", "Resolved", "Backlog", "First response", "Breached"]
        : ["Handled", "Resolved", "Active", "Handling", "Transfers", "Reopens"];
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{mode === "operators" ? "Operator" : "Queue"}</th>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              {(mode === "supervision"
                ? [r.backlog, r.warning, r.breached]
                : mode === "queues"
                  ? [
                      r.cases_created,
                      r.cases_resolved,
                      r.backlog,
                      seconds(r.first_response_seconds),
                      r.breached,
                    ]
                  : [
                      r.cases_handled,
                      r.cases_resolved,
                      r.active_cases,
                      seconds(r.handling_seconds),
                      r.transfers,
                      r.reopens,
                    ]
              ).map((v, i) => (
                <td key={i}>{v ?? "—"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (
        <p className="empty">No retained support records yet.</p>
      )}
    </div>
  );
}
