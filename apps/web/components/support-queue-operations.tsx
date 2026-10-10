"use client";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  type QueueOperations,
  type SupportQueue,
  type SupportPage,
  type SupportCursor,
} from "@agentconnect/schemas/support";
import { requestJson } from "./agent-client";
import { supportCursor, statusLabel } from "./support-utils";
import { Button } from "./button";
export function SupportQueueOperations({
  value,
  onChange,
  base,
  queueId,
}: {
  value: QueueOperations;
  onChange: (v: QueueOperations) => void;
  base: string;
  queueId: string;
}) {
  const queues = useInfiniteQuery({
    queryKey: ["support", base, "fallback-queues"],
    initialPageParam: null as SupportCursor | null,
    queryFn: ({ pageParam }) =>
      requestJson<SupportPage<SupportQueue>>(
        base + "/queues?limit=100" + supportCursor(pageParam),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
  });
  const setHours = (next: Partial<QueueOperations["businessHours"]>) =>
    onChange({ ...value, businessHours: { ...value.businessHours, ...next } });
  return (
    <section aria-label="Queue operations" className="support-queue-operations">
      <h3>SLA targets</h3>
      <p className="field-help">
        Blank targets disable tracking. Targets use elapsed wall-clock seconds;
        the resolution timer can pause while waiting. Changes apply to new
        cases.
      </p>
      <div className="form-grid">
        {(
          [
            ["assignmentSeconds", "Assignment target (seconds)"],
            ["firstResponseSeconds", "First response target (seconds)"],
            ["resolutionSeconds", "Resolution target (seconds)"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              type="number"
              min={1}
              max={2592000}
              value={value.sla[key] ?? ""}
              onChange={(e) =>
                onChange({
                  ...value,
                  sla: {
                    ...value.sla,
                    [key]:
                      e.target.value === "" ? null : Number(e.target.value),
                  },
                })
              }
            />
          </label>
        ))}
        <label>
          SLA warning threshold (%)
          <input
            type="number"
            min={1}
            max={99}
            value={value.sla.warningPercent}
            onChange={(e) =>
              onChange({
                ...value,
                sla: { ...value.sla, warningPercent: Number(e.target.value) },
              })
            }
          />
        </label>
        <label>
          Acceptance timeout (seconds)
          <input
            type="number"
            min={15}
            max={86400}
            value={value.acceptanceTimeoutSeconds}
            onChange={(e) =>
              onChange({
                ...value,
                acceptanceTimeoutSeconds: Number(e.target.value),
              })
            }
          />
        </label>
        <label>
          Maximum automatic assignment attempts
          <input
            type="number"
            min={1}
            max={10}
            value={value.maxAssignmentAttempts}
            onChange={(e) =>
              onChange({
                ...value,
                maxAssignmentAttempts: Number(e.target.value),
              })
            }
          />
        </label>
      </div>
      {(
        [
          [
            "pauseWaitingCustomer",
            "Pause resolution while waiting for customer",
          ],
          [
            "pauseWaitingExternal",
            "Pause resolution while waiting for external work",
          ],
        ] as const
      ).map(([key, label]) => (
        <label key={key} className="checkbox-label">
          <input
            type="checkbox"
            checked={value.sla[key]}
            onChange={(e) =>
              onChange({
                ...value,
                sla: { ...value.sla, [key]: e.target.checked },
              })
            }
          />
          {label}
        </label>
      ))}
      <h3>Business hours</h3>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={value.businessHours.enabled}
          onChange={(e) => setHours({ enabled: e.target.checked })}
        />
        Enforce queue business hours
      </label>
      <div className="form-grid">
        <label>
          Queue timezone
          <input
            value={value.businessHours.timezone}
            onChange={(e) => setHours({ timezone: e.target.value })}
            placeholder="Asia/Kuala_Lumpur"
          />
        </label>
        <label>
          Outside business hours
          <select
            aria-label="Outside business hours"
            value={value.businessHours.afterHours}
            onChange={(e) =>
              setHours({
                afterHours: e.target
                  .value as QueueOperations["businessHours"]["afterHours"],
              })
            }
          >
            {[
              "create_offline_case",
              "continue_with_ai",
              "collect_message",
              "show_business_hours",
              "route_to_fallback_queue",
            ].map((k) => (
              <option key={k} value={k}>
                {statusLabel(k)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Fallback queue
          <select
            aria-label="Fallback queue"
            value={value.businessHours.fallbackQueueId ?? ""}
            onChange={(e) =>
              setHours({ fallbackQueueId: e.target.value || null })
            }
          >
            <option value="">Choose a queue</option>
            {queues.data?.pages
              .flatMap((p) => p.items)
              .filter((q) => q.enabled && q.id !== queueId)
              .map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      {queues.hasNextPage && (
        <Button type="button" onClick={() => void queues.fetchNextPage()}>
          Load more fallback queues
        </Button>
      )}
      {queues.error && (
        <p role="alert" className="error">
          {queues.error.message}
        </p>
      )}
      {value.businessHours.enabled && (
        <div className="support-hours">
          {[
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
          ].map((day, weekday) => {
            const intervals = value.businessHours.weekly.filter(
                (v) => v.weekday === weekday,
              ),
              slot = intervals[0];
            const time = (n: number) =>
              String(Math.floor(n / 60)).padStart(2, "0") +
              ":" +
              String(n % 60).padStart(2, "0");
            const edit = (start: number, end: number) =>
              setHours({
                weekly: [
                  ...value.businessHours.weekly.filter(
                    (v) => v.weekday !== weekday,
                  ),
                  { weekday, startMinute: start, endMinute: end },
                ],
              });
            const minute = (s: string) => {
              const [h, m] = s.split(":").map(Number);
              return (h ?? 0) * 60 + (m ?? 0);
            };
            return (
              <div key={day}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={!!slot}
                    onChange={(e) =>
                      setHours({
                        weekly: e.target.checked
                          ? [
                              ...value.businessHours.weekly,
                              { weekday, startMinute: 540, endMinute: 1020 },
                            ]
                          : value.businessHours.weekly.filter(
                              (v) => v.weekday !== weekday,
                            ),
                      })
                    }
                  />
                  {day}
                </label>
                {slot && (
                  <>
                    <label>
                      Opens
                      <input
                        type="time"
                        aria-label={`${day} opens`}
                        value={time(slot.startMinute)}
                        onChange={(e) =>
                          edit(minute(e.target.value), slot.endMinute)
                        }
                      />
                    </label>
                    <label>
                      Closes
                      <input
                        type="time"
                        aria-label={`${day} closes`}
                        value={time(Math.min(1439, slot.endMinute))}
                        onChange={(e) =>
                          edit(slot.startMinute, minute(e.target.value))
                        }
                      />
                    </label>
                    {intervals.length > 1 && (
                      <small>
                        Multiple saved intervals; editing replaces this day with
                        one interval.
                      </small>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="field-help">
        Closed queues do not automatically assign cases. Offline/message/hours
        modes keep a durable case and show the queue schedule. Holidays can be
        added later.
      </p>
    </section>
  );
}
