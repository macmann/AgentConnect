"use client";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { permitted, type Role } from "@agentconnect/schemas/foundation";
import type { SupportCaseView } from "@agentconnect/schemas/support";
import { Button } from "./button";
import { requestJson } from "./agent-client";
import { supportTime } from "./support-utils";
export function SupportBrief({
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
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    cache = useQueryClient();
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      await requestJson(base + "/cases/" + s.id + "/brief/refresh", "POST", {});
      await cache.invalidateQueries({ queryKey: ["support", workspaceId] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const brief = s.handoff_brief ?? {},
    provenance = brief.provenance ?? s.triage_provenance,
    pending = ["pending", "running"].includes(s.triage_status);
  return (
    <section className="support-brief" aria-label="AI handoff brief">
      <h4>AI handoff brief</h4>
      {pending && (
        <p role="status">
          Preparing a private brief. Operators can still use the conversation
          and reply.
        </p>
      )}
      {s.triage_status === "failed" && (
        <p>
          AI triage was unavailable. Manual support remains available; use the
          conversation below.
        </p>
      )}
      {s.triage_status === "failed" && s.triage_provenance?.errorCode && (
        <small>Failure code: {s.triage_provenance.errorCode}</small>
      )}
      {brief.summary ? (
        <>
          <p>{brief.summary}</p>
          <dl className="support-context-list">
            <dt>Escalation reason</dt>
            <dd>{brief.reason || "See case issue"}</dd>
            <dt>Detected intent</dt>
            <dd>{brief.intent || "Unknown"}</dd>
            <dt>Language / sentiment</dt>
            <dd>
              {brief.language || "Unknown"} / {brief.sentiment || "Unknown"}
            </dd>
          </dl>
          {!!brief.customerContext?.length && (
            <>
              <h5>Customer context</h5>
              <ul>
                {brief.customerContext.map((v, i) => (
                  <li key={i}>{v}</li>
                ))}
              </ul>
            </>
          )}
          {!!brief.actionsAttempted?.length && (
            <>
              <h5>Actions attempted</h5>
              <ul>
                {brief.actionsAttempted.map((v, i) => (
                  <li key={i}>{v}</li>
                ))}
              </ul>
            </>
          )}
          {brief.suggestedNextAction && (
            <>
              <h5>Suggested next action</h5>
              <p>{brief.suggestedNextAction}</p>
            </>
          )}
          <small>
            AI generated suggestions · Verify against the conversation.
            {provenance?.modelId ? " " + provenance.modelId : ""}
            {provenance?.generatedAt
              ? " · " + supportTime(provenance.generatedAt)
              : ""}
          </small>
        </>
      ) : (
        !pending &&
        s.triage_status !== "failed" && <p>No generated handoff brief yet.</p>
      )}
      {permitted(role, "support:reply") && (
        <Button
          className="secondary"
          disabled={busy || pending}
          onClick={() => void refresh()}
        >
          {busy
            ? "Queuing…"
            : brief.summary
              ? "Refresh brief"
              : "Generate brief"}
        </Button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
