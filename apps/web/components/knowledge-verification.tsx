"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { requestJson } from "./agent-client";
import { Button } from "./button";
type Verification = {
  dataset: { id: string; name: string; revision: number } | null;
  targets: {
    agentId: string;
    name: string;
    revision: number;
    versionId: string | null;
  }[];
  runs: {
    id: string;
    agent_id: string;
    candidate_version_id: string | null;
    status: string;
    error_code: string | null;
    summary: { passRate: number } | null;
  }[];
};
function VerificationChecks({
  baseId,
  releaseId,
  workspaceId,
  canTest,
}: {
  baseId: string;
  releaseId: string;
  workspaceId: string;
  canTest: boolean;
}) {
  const cache = useQueryClient(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const key = ["knowledge-verification", releaseId];
  const v = useQuery({
    queryKey: key,
    queryFn: () =>
      requestJson<Verification>(
        `/knowledge-bases/${baseId}/releases/${releaseId}/verification`,
      ),
    refetchInterval: 5000,
  });
  if (v.isPending) return <p>Loading correction checks…</p>;
  if (v.error) return <p role="alert">{v.error.message}</p>;
  if (!v.data?.dataset) return null;
  return (
    <div className="configure-group">
      <h5>Correction regression gate</h5>
      <p>
        Dataset: {v.data.dataset.name}, revision {v.data.dataset.revision}.
        Review exact-answer defaults in Quality; use required/forbidden terms
        for acceptable paraphrases. Citation reference markers are ignored for
        candidate exact-answer comparisons.
      </p>
      <p>
        Every affected draft and active published version must pass against this
        private candidate before publication. Existing customer chats continue
        using published knowledge.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {v.data.targets.length === 0 && (
        <p>Attach this knowledge base to an agent before verification.</p>
      )}
      {v.data.targets.map((t) => {
        const run = v.data!.runs.find(
          (r) =>
            r.agent_id === t.agentId && r.candidate_version_id === t.versionId,
        );
        return (
          <p key={t.agentId + ":" + t.versionId}>
            {t.name} · {t.versionId ? "Published version" : "Saved draft"} ·{" "}
            {run
              ? `${run.status}${run.summary ? " — " + Math.round(run.summary.passRate * 100) + "% passed" : ""}${run.error_code ? " — " + run.error_code : ""}`
              : "Not tested"}
          </p>
        );
      })}
      {canTest && (
        <Button
          className="secondary"
          disabled={
            busy ||
            v.data.runs.some((r) => ["queued", "running"].includes(r.status)) ||
            !v.data.targets.length
          }
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              for (const t of v.data!.targets)
                await requestJson(
                  `/workspaces/${workspaceId}/evaluations`,
                  "POST",
                  {
                    agentId: t.agentId,
                    revision: t.revision,
                    datasetId: v.data!.dataset!.id,
                    candidateReleaseId: releaseId,
                    ...(t.versionId ? { candidateVersionId: t.versionId } : {}),
                    evaluator: { mode: "deterministic", minScore: 1 },
                  },
                );
              await cache.invalidateQueries({ queryKey: key });
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Queuing checks…" : "Run correction regressions"}
        </Button>
      )}
      <small>
        Inspect case outputs in Quality. Changes to data, agent settings or
        model dependencies require a fresh passing run. Publication enforces the
        gate on the server.
      </small>
    </div>
  );
}

export function KnowledgeVerification(
  props: Parameters<typeof VerificationChecks>[0],
) {
  const [open, setOpen] = useState(false);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Correction verification</summary>
      {open && <VerificationChecks {...props} />}
    </details>
  );
}
