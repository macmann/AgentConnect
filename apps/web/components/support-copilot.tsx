"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CopilotView } from "@agentconnect/schemas/support";
import { Button } from "./button";
import { requestJson } from "./agent-client";
import { supportTime } from "./support-utils";
export function SupportCopilot({
  path,
  canUse,
  onUse,
}: {
  path: string;
  canUse: boolean;
  onUse: (text: string) => void;
}) {
  const cache = useQueryClient(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [ignored, setIgnored] = useState<string[]>([]);
  const query = useQuery({
    queryKey: ["copilot", path],
    queryFn: () => requestJson<{ items: CopilotView[] }>(path + "/copilot"),
    enabled: canUse,
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.items.some((i) => i.status === "running") ? 3000 : false,
  });
  async function generate(kind: CopilotView["kind"], regenerate = false) {
    setBusy(true);
    setError("");
    try {
      const generated = await requestJson<CopilotView>(
        path + "/copilot",
        "POST",
        { kind, regenerate },
      );
      setIgnored((v) => v.filter((id) => id !== generated.id));
      await cache.invalidateQueries({ queryKey: ["copilot", path] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const items = query.data?.items.filter((i) => !ignored.includes(i.id)) ?? [],
    latest = items[0],
    pending = busy || items.some((i) => i.status === "running");
  return (
    <section
      className="support-brief support-copilot"
      aria-label="Private operator copilot"
    >
      <h4>Private AI copilot</h4>
      <p>
        Suggestions for your review. Drafts are never sent automatically, and
        recommended tools are never run here.
      </p>
      {!canUse ? (
        <p>
          Activate a case assigned to you to use copilot. Supervisors can assist
          active cases.
        </p>
      ) : (
        <>
          <div className="support-copilot-actions">
            {(
              [
                ["reply", "Suggest reply"],
                ["summary", "Summarize"],
                ["knowledge", "Find knowledge"],
                ["next_action", "Suggest next action"],
              ] as const
            ).map(([kind, label]) => (
              <Button
                key={kind}
                className="secondary"
                disabled={pending}
                onClick={() => void generate(kind)}
              >
                {label}
              </Button>
            ))}
          </div>
          {pending && (
            <p role="status">
              Preparing a private suggestion. You can still reply manually.
            </p>
          )}
          {(error || query.error) && (
            <p className="error" role="alert">
              {error || query.error?.message} Manual replies remain available.
            </p>
          )}
          {latest?.status === "failed" && (
            <p role="alert">
              Copilot unavailable (
              {latest.provenance.errorCode ?? "COPILOT_UNAVAILABLE"}). You can
              still reply manually or regenerate.
            </p>
          )}
          {latest?.result && (
            <div className="support-copilot-result">
              {latest.result.reply && (
                <>
                  <h5>Suggested reply · review before sending</h5>
                  <p className="support-copilot-draft">{latest.result.reply}</p>
                  <Button onClick={() => onUse(latest.result!.reply)}>
                    Use draft in reply composer
                  </Button>
                </>
              )}
              {latest.result.summary && (
                <>
                  <h5>Conversation summary</h5>
                  <p>{latest.result.summary}</p>
                </>
              )}
              <p>
                <strong>Sentiment (AI estimate): </strong>
                {latest.result.sentiment}. Verify against the conversation.
              </p>
              {latest.result.nextAction !== "none" && (
                <p>
                  <strong>Suggested next action: </strong>
                  {latest.result.nextAction.replaceAll("_", " ")}
                </p>
              )}
              {latest.result.rationale && <p>{latest.result.rationale}</p>}
              {!!latest.result.toolRecommendations.length && (
                <>
                  <h5>Recommended tools · advisory only</h5>
                  <ul>
                    {latest.result.toolRecommendations.map((t) => (
                      <li key={t.toolId}>
                        {latest.tools.find((v) => v.id === t.toolId)?.name}:{" "}
                        {t.reason}
                      </li>
                    ))}
                  </ul>
                  <small>
                    Use the approved tool workflow if you have execution
                    permission.
                  </small>
                </>
              )}
              {!!latest.citations.length && (
                <>
                  <h5>Relevant knowledge</h5>
                  {latest.citations.map((c) => (
                    <details key={c.id}>
                      <summary>
                        [{c.id}] {c.title}
                      </summary>
                      <p>{c.content}</p>
                    </details>
                  ))}
                </>
              )}
              <small>
                {latest.provenance.modelId ?? "Knowledge retrieval"} ·{" "}
                {supportTime(
                  latest.provenance.generatedAt ?? latest.created_at,
                )}
                . Suggestions may become outdated as the conversation changes.
              </small>
            </div>
          )}
          {latest && latest.status !== "running" && (
            <div className="support-copilot-actions">
              <Button
                className="secondary"
                disabled={pending}
                onClick={() => void generate(latest.kind, true)}
              >
                Regenerate suggestion
              </Button>
              <Button
                className="secondary"
                disabled={pending}
                onClick={() =>
                  setIgnored((v) => [
                    ...new Set([...v, ...items.map((i) => i.id)]),
                  ])
                }
              >
                Ignore suggestion
              </Button>
            </div>
          )}
          {!latest && !pending && (
            <p>No private suggestions yet. Choose an action above.</p>
          )}
        </>
      )}
    </section>
  );
}
