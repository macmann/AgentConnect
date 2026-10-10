"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { permitted, type Role } from "@agentconnect/schemas/foundation";
import type { SupportCaseView } from "@agentconnect/schemas/support";
import { requestJson } from "./agent-client";
import { Button } from "./button";
import { statusLabel } from "./support-utils";
type Recommendation = {
  strategy: string;
  assignmentMode: string;
  reason: string;
  candidates: {
    userId: string;
    name: string;
    score: number;
    load: number;
    capacity: number;
    factors: Record<string, number>;
  }[];
};
export function SupportRoutingPanel({
  s,
  base,
  workspaceId,
  role,
}: {
  s: SupportCaseView;
  base: string;
  workspaceId: string;
  role: Role;
}) {
  const [show, setShow] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    cache = useQueryClient();
  const recommendation = useQuery({
    queryKey: ["support", workspaceId, "routing", s.id],
    queryFn: () => requestJson<Recommendation>(`${base}/cases/${s.id}/routing`),
    enabled: show && s.status === "queued" && !!s.queue_id,
    staleTime: 0,
  });
  return (
    <div className="support-routing-result">
      <h3>Routing</h3>
      {s.routing_strategy && (
        <>
          <p>
            {statusLabel(s.routing_strategy)} assignment · Score{" "}
            {s.routing_score?.toFixed(2)}
          </p>
          <p>Assignment factors</p>
          {Object.entries(s.routing_explanation?.factors ?? {}).map(
            ([factor, value]) => (
              <small key={factor}>
                {statusLabel(factor)}: {Number(value).toFixed(2)}
              </small>
            ),
          )}
        </>
      )}
      {s.status === "queued" &&
        (s.queue_id ? (
          <>
            <Button
              className="secondary"
              disabled={busy || recommendation.isFetching}
              onClick={() => {
                setShow(true);
                void recommendation.refetch();
              }}
            >
              Check routing match
            </Button>
            {recommendation.isFetching && (
              <p role="status">Checking current availability…</p>
            )}
            {recommendation.data && show && (
              <>
                <p>{recommendation.data.reason}</p>
                {recommendation.data.candidates.slice(0, 3).map((c) => (
                  <p key={c.userId}>
                    <strong>{c.name}</strong>
                    <small>
                      {c.load} / {c.capacity} reserved · Score{" "}
                      {c.score.toFixed(2)}
                    </small>
                  </p>
                ))}
                {permitted(role, "support:assign") &&
                  recommendation.data.strategy !== "manual" &&
                  recommendation.data.assignmentMode !== "manual" &&
                  recommendation.data.candidates.length > 0 && (
                    <Button
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setError("");
                        try {
                          const result = await requestJson<{
                            assigned: boolean;
                            reason?: string;
                          }>(`${base}/cases/${s.id}/route`, "POST", {});
                          if (!result.assigned)
                            setError(result.reason ?? "Case was not assigned");
                          await cache.invalidateQueries({
                            queryKey: ["support", workspaceId],
                          });
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Assign best match
                    </Button>
                  )}
              </>
            )}
            {recommendation.error && (
              <p className="error" role="alert">
                {recommendation.error.message}
              </p>
            )}
          </>
        ) : (
          <p>
            No queue selected. Assign a queue or configure a default queue for
            new requests.
          </p>
        ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
