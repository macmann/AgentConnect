"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { requestJson } from "./agent-client";
import { Button } from "./button";
import { HelpTooltip } from "./help-tooltip";
type Proposal = {
  key: string;
  question: string;
  members: { runId: string; question: string }[];
  similarity: { minimum: number | null; mean: number | null };
};
type Preview = {
  previewId: string;
  modelName: string;
  threshold: number;
  proposals: Proposal[];
  grouped: number;
  clusters: number;
  protected: number;
  truncated: boolean;
};
export function GapClusterPreview({
  workspaceId,
  range,
  onApplied,
}: {
  workspaceId: string;
  range?: { from: string; to: string };
  onApplied: () => Promise<void>;
}) {
  const [model, setModel] = useState(""),
    [threshold, setThreshold] = useState(0.85),
    [preview, setPreview] = useState<Preview | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const embeddings = useQuery({
    queryKey: ["gap-embeddings", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(
        `/workspaces/${workspaceId}/embedding-models`,
      ),
  });
  const base = `/workspaces/${workspaceId}/operations/knowledge-gaps`;
  async function generate() {
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      const value = await requestJson<Preview>(base + "/cluster", "POST", {
        modelId: model,
        threshold,
        ...range,
        preview: true,
      });
      setPreview(value);
      setSelected(
        value.proposals.filter((p) => p.members.length > 1).map((p) => p.key),
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="configure-group gap-cluster-settings">
      <summary>Group related questions by meaning</summary>
      <p>
        Preview related questions before changing topics.{" "}
        <HelpTooltip>
          Uses the selected embedding provider for up to 300 recent affected
          runs in this window. Full questions are sent to that provider.
          Pairwise cosine similarity is not calibrated confidence.
          Reviewer-assigned runs are excluded and remain protected. Previews
          expire after ten minutes; changed questions or assignments require a
          new preview. Only selected topics are applied; knowledge is never
          automatically created or published.
        </HelpTooltip>
      </p>
      {(error || embeddings.error) && (
        <p role="alert">{error || embeddings.error?.message}</p>
      )}
      <div className="form-grid">
        <label>
          Grouping embedding model
          <select
            aria-label="Grouping embedding model"
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              setPreview(null);
            }}
            disabled={busy}
          >
            <option value="">Choose a model</option>
            {embeddings.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Grouping minimum similarity
          <input
            type="number"
            min={0.7}
            max={0.99}
            step={0.01}
            value={threshold}
            disabled={busy}
            onChange={(e) => {
              setThreshold(Number(e.target.value));
              setPreview(null);
            }}
          />
        </label>
      </div>
      <Button
        type="button"
        disabled={
          busy ||
          !model ||
          !range ||
          !Number.isFinite(threshold) ||
          threshold < 0.7 ||
          threshold > 0.99
        }
        onClick={() => void generate()}
      >
        {busy ? "Working…" : "Preview related topics"}
      </Button>
      {preview && (
        <section aria-label="Grouping preview" className="gap-cluster-preview">
          <h4>Proposed topics</h4>
          <p>
            {preview.grouped} questions · {preview.clusters} topics ·{" "}
            {preview.protected} reviewer-protected runs · {preview.modelName} ·
            threshold {preview.threshold}
          </p>
          {preview.truncated && (
            <p>
              Only the latest 300 affected runs were considered. Narrow the date
              window for more coverage.
            </p>
          )}
          {!preview.proposals.length && (
            <p>
              No unreviewed affected questions are available for clustering.
            </p>
          )}
          {preview.proposals.map((proposal) => (
            <div key={proposal.key} className="gap-proposal">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={selected.includes(proposal.key)}
                  disabled={busy}
                  onChange={(e) =>
                    setSelected((current) =>
                      e.target.checked
                        ? [...current, proposal.key]
                        : current.filter((key) => key !== proposal.key),
                    )
                  }
                />
                {proposal.question.slice(0, 160)} · {proposal.members.length}{" "}
                questions
              </label>
              <details>
                <summary>Inspect proposed questions</summary>
                <p>
                  Minimum pair similarity:{" "}
                  {proposal.similarity.minimum === null
                    ? "Not applicable (one question)"
                    : proposal.similarity.minimum.toFixed(3)}{" "}
                  · Mean:{" "}
                  {proposal.similarity.mean?.toFixed(3) ?? "Not applicable"}
                </p>
                <ul>
                  {proposal.members.map((member) => (
                    <li key={member.runId}>{member.question}</li>
                  ))}
                </ul>
              </details>
            </div>
          ))}
          <div className="studio-actions">
            <Button
              type="button"
              disabled={busy || !selected.length}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await requestJson(base + "/cluster-apply", "POST", {
                    previewId: preview.previewId,
                    groupKeys: selected,
                  });
                  setPreview(null);
                  await onApplied();
                } catch (cause) {
                  setError((cause as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Apply selected topics
            </Button>
            <Button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              Discard preview
            </Button>
          </div>
        </section>
      )}
    </details>
  );
}
