"use client";
import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  type SupportQueue,
  type SupportOperator,
  type SupportPage,
  type SupportCursor,
  type SupportCaseView,
  isOpenCase,
} from "@agentconnect/schemas/support";
import { permitted, type Role } from "@agentconnect/schemas/foundation";
import { SupportEditorFrame } from "./support-team";
import { Button } from "./button";
import { requestJson } from "./agent-client";
import { supportCursor, statusLabel, supportTime } from "./support-utils";
export function SupportCaseOperations({
  s,
  base,
  role,
  control,
  onSaved,
}: {
  s: SupportCaseView;
  base: string;
  role: Role;
  control: boolean;
  onSaved: () => Promise<void>;
}) {
  const [action, setAction] = useState<"transfer" | "priority" | null>(null),
    [queue, setQueue] = useState(s.queue_id ?? ""),
    [operator, setOperator] = useState(""),
    [priority, setPriority] = useState(s.priority),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const queues = useInfiniteQuery({
    queryKey: ["support", s.workspace_id, "transfer-queues"],
    initialPageParam: null as SupportCursor | null,
    queryFn: ({ pageParam }) =>
      requestJson<SupportPage<SupportQueue>>(
        base + "/queues?limit=100" + supportCursor(pageParam),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    enabled: action === "transfer",
  });
  const operators = useInfiniteQuery({
    queryKey: ["support", s.workspace_id, "transfer-operators"],
    initialPageParam: null as SupportCursor | null,
    queryFn: ({ pageParam }) =>
      requestJson<SupportPage<SupportOperator>>(
        base + "/operators?limit=100" + supportCursor(pageParam),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    enabled: action === "transfer",
  });
  return (
    <section aria-label="Case service targets" className="support-brief">
      <h4>Service targets</h4>
      <p>
        SLA: <strong>{statusLabel(s.sla_state)}</strong>
      </p>
      {Object.entries(s.sla_details ?? {}).map(([metric, d]) => (
        <p key={metric}>
          {statusLabel(metric)}: {statusLabel(d.state)} · {d.elapsedSeconds} /{" "}
          {d.targetSeconds} seconds
        </p>
      ))}
      {!Object.keys(s.sla_details ?? {}).length && (
        <small>No SLA targets configured for this case.</small>
      )}
      {s.acceptance_deadline && (
        <p>Accept by {supportTime(s.acceptance_deadline)}</p>
      )}
      <small>
        {s.assignment_timeout_count} expired assignments · {s.transfer_count}{" "}
        transfers · {s.reopen_count} reopens
      </small>
      <div className="button-row">
        {isOpenCase(s.status) &&
          control &&
          permitted(role, "support:transfer") && (
            <Button
              className="secondary"
              onClick={() => {
                setError("");
                setReason("");
                setAction("transfer");
              }}
            >
              Transfer case
            </Button>
          )}
        {isOpenCase(s.status) && permitted(role, "support:supervise") && (
          <Button
            className="secondary"
            onClick={() => {
              setError("");
              setReason("");
              setAction("priority");
            }}
          >
            Change priority
          </Button>
        )}
      </div>
      {action && (
        <SupportEditorFrame
          title={action === "transfer" ? "Transfer case" : "Change priority"}
          description={
            action === "transfer"
              ? "Move this case to an enabled queue or another operator. Human control stays in place."
              : "Record a reason for the priority change."
          }
          busy={busy}
          onClose={() => setAction(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await requestJson(
                  base + "/cases/" + s.id + "/" + action,
                  "POST",
                  action === "transfer"
                    ? { queueId: queue, operatorId: operator || null, reason }
                    : { priority, reason },
                );
                await onSaved();
                setAction(null);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <fieldset disabled={busy}>
              {action === "transfer" ? (
                <>
                  <label>
                    Transfer queue
                    <select
                      aria-label="Transfer queue"
                      required
                      value={queue}
                      onChange={(e) => setQueue(e.target.value)}
                    >
                      <option value="">Choose a queue</option>
                      {queues.data?.pages
                        .flatMap((p) => p.items)
                        .filter((q) => q.enabled)
                        .map((q) => (
                          <option key={q.id} value={q.id}>
                            {q.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Transfer operator
                    <select
                      aria-label="Transfer operator"
                      value={operator}
                      onChange={(e) => setOperator(e.target.value)}
                    >
                      <option value="">Return to queue for assignment</option>
                      {operators.data?.pages
                        .flatMap((p) => p.items)
                        .map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  {queues.hasNextPage && (
                    <Button
                      type="button"
                      onClick={() => void queues.fetchNextPage()}
                    >
                      Load more queues
                    </Button>
                  )}
                  {operators.hasNextPage && (
                    <Button
                      type="button"
                      onClick={() => void operators.fetchNextPage()}
                    >
                      Load more operators
                    </Button>
                  )}
                  {(queues.error || operators.error) && (
                    <p role="alert" className="error">
                      {queues.error?.message ?? operators.error?.message}
                    </p>
                  )}
                </>
              ) : (
                <label>
                  Case priority
                  <select
                    aria-label="Case priority"
                    value={priority}
                    onChange={(e) =>
                      setPriority(e.target.value as typeof priority)
                    }
                  >
                    {["low", "normal", "high", "urgent"].map((p) => (
                      <option key={p} value={p}>
                        {statusLabel(p)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Reason for change
                <textarea
                  required
                  value={reason}
                  maxLength={500}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <div className="dialog-actions">
                <Button
                  type="button"
                  className="secondary"
                  onClick={() => setAction(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!reason.trim() || (action === "transfer" && !queue)}
                >
                  {busy
                    ? "Saving…"
                    : action === "transfer"
                      ? "Confirm transfer"
                      : "Save priority"}
                </Button>
              </div>
            </fieldset>
          </form>
        </SupportEditorFrame>
      )}
    </section>
  );
}
