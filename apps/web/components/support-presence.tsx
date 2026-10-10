"use client";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { permitted, type Role } from "@agentconnect/schemas/foundation";
import {
  presenceStatus,
  type OperatorProfile,
} from "@agentconnect/schemas/support";
import { requestJson } from "./agent-client";
import { statusLabel } from "./support-utils";
export function SupportPresence({
  workspaceId,
  userId,
  role,
}: {
  workspaceId: string;
  userId: string;
  role: Role;
}) {
  const base = `/workspaces/${workspaceId}/support`,
    cache = useQueryClient(),
    [choice, setChoice] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const self = useQuery({
    queryKey: ["support", workspaceId, "self", userId],
    queryFn: async () =>
      (
        await requestJson<{ profile: OperatorProfile | null }>(
          `${base}/operators/${userId}/profile`,
        )
      ).profile,
    enabled: permitted(role, "support:reply"),
    refetchInterval: 30000,
  });
  const desired =
    self.data?.enabled && self.data.manual_availability
      ? (choice ?? self.data.effective_presence)
      : "offline";
  useEffect(() => {
    if (
      !self.data?.enabled ||
      !self.data.manual_availability ||
      desired === "offline"
    )
      return;
    async function beat() {
      if (document.visibilityState !== "visible") return;
      try {
        await requestJson(`${base}/operators/${userId}/presence`, "POST", {
          status: desired,
        });
        setError("");
      } catch (e) {
        setError((e as Error).message);
      }
    }
    const timer = window.setInterval(() => void beat(), 20000);
    return () => clearInterval(timer);
  }, [
    base,
    userId,
    desired,
    self.data?.enabled,
    self.data?.manual_availability,
  ]);
  if (!permitted(role, "support:reply")) return null;
  return (
    <section className="support-presence" aria-label="My support availability">
      <div>
        <strong>My availability</strong>
        <p>
          {self.data
            ? `${self.data.active_case_count} / ${self.data.capacity_limit} case slots reserved`
            : "A supervisor can add your support profile in Operators & routing."}
        </p>
      </div>
      {self.isPending ? (
        <span role="status">Loading profile…</span>
      ) : self.data ? (
        <label>
          Presence
          <select
            aria-label="My presence"
            value={desired}
            disabled={
              busy || !self.data.enabled || !self.data.manual_availability
            }
            onChange={async (e) => {
              const status = e.target.value;
              setBusy(true);
              setError("");
              try {
                await requestJson(
                  `${base}/operators/${userId}/presence`,
                  "POST",
                  { status },
                );
                setChoice(status);
                await cache.invalidateQueries({
                  queryKey: ["support", workspaceId],
                });
              } catch (error) {
                setError((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {presenceStatus.options.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <small>
        Availability expires when this console stops sending heartbeats. Only
        Available operators receive routed cases.
      </small>
      {(error || self.error) && (
        <p className="error" role="alert">
          {error || self.error?.message}
        </p>
      )}
    </section>
  );
}
