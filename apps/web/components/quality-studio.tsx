"use client";
import { SettingsHint } from "./settings-help";
import { MultilingualBenchmarkBuilder } from "./multilingual-benchmark-builder";
import {
  MultilingualReport,
  type MultilingualResults,
} from "./multilingual-results";
import { DocumentBenchmarkBuilder } from "./document-benchmark-builder";
import { HelpTooltip } from "./help-tooltip";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { permitted, type Role } from "@agentconnect/schemas/foundation";
import { requestJson } from "./agent-client";
import { WorkspaceSections, useWorkspaceSection } from "./workspace-sections";
import { Button } from "./button";
type Dataset = {
  id: string;
  name: string;
  description: string;
  revision: number;
  examples: unknown[];
};
type Run = {
  id: string;
  agent_id: string;
  dataset_id: string;
  candidate_release_id?: string | null;
  candidate_version_id?: string | null;
  status: string;
  summary: {
    passRate: number;
    failedCases: number;
    meanLatencyMs: number;
    retrievalRecall: number | null;
    cost: number | null;
    extractionTextSimilarity?: number | null;
    tableCellAccuracy?: number | null;
    citationRecall?: number | null;
    multilingual?: MultilingualResults;
    segments?: {
      tag: string;
      cases: number;
      passRate: number;
      meanLatencyMs: number | null;
      extractionTextSimilarity: number | null;
      tableCellAccuracy: number | null;
      citationRecall: number | null;
    }[];
    regression?: {
      passRateDelta: number;
      languagePairs?: {
        label: string;
        passRateDelta: number;
        retrievalRecallDelta: number | null;
        citationRecallDelta: number | null;
        languageComplianceDelta: number | null;
      }[];
    };
  } | null;
  error_code: string | null;
};
type Detail = Run & {
  examples_snapshot: { id: string; input: string; tags: string[] }[];
  results: {
    example_id: string;
    status: string;
    output: string;
    score: number | null;
    passed: boolean;
    error_code: string | null;
    metrics: Record<string, unknown>;
  }[];
};
const starter = JSON.stringify(
  [
    {
      input: "Hello",
      expectedBehavior: "Greet the user",
      contains: ["hello"],
      tags: ["greeting"],
    },
  ],
  null,
  2,
);
export function QualityStudio({
  workspaceId,
  role,
  onNavigate,
}: {
  workspaceId: string;
  role: Role;
  onNavigate: (view: string) => void;
}) {
  const [section, setSection] = useWorkspaceSection(
    "qualitySection",
    "datasets",
    ["datasets", "evaluate", "gates", "history"],
  );
  const client = useQueryClient(),
    base = `/workspaces/${workspaceId}`;
  const datasets = useQuery({
    queryKey: ["quality-datasets", workspaceId],
    queryFn: () => requestJson<Dataset[]>(base + "/datasets"),
  });
  const agents = useQuery({
    queryKey: ["quality-agents", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string; revision: number }[]>(
        base + "/agents",
      ),
  });
  const models = useQuery({
    queryKey: ["quality-models", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(base + "/quality-models"),
  });
  const runs = useQuery({
    queryKey: ["quality-runs", workspaceId],
    queryFn: () => requestJson<Run[]>(base + "/evaluations"),
    refetchInterval: 3000,
  });
  const gates = useQuery({
    queryKey: ["quality-gates", workspaceId],
    queryFn: () =>
      requestJson<
        {
          agent_id: string;
          settings: {
            enabled: boolean;
            datasetId: string | null;
            minPassRate: number;
          };
        }[]
      >(base + "/quality-gates"),
  });
  const [datasetId, setDatasetId] = useState(""),
    [agentId, setAgentId] = useState(""),
    [name, setName] = useState(""),
    [examples, setExamples] = useState(starter),
    [editing, setEditing] = useState(false),
    [mode, setMode] = useState("deterministic"),
    [judge, setJudge] = useState(""),
    [baseline, setBaseline] = useState(""),
    [selected, setSelected] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [threshold, setThreshold] = useState(100),
    [messageIds, setMessageIds] = useState("");
  const detail = useQuery({
    queryKey: ["quality-detail", workspaceId, selected],
    queryFn: () => requestJson<Detail>(base + "/evaluations/" + selected),
    enabled: !!selected,
    refetchInterval: 3000,
  });
  const dataset = datasets.data?.find((d) => d.id === datasetId),
    agent = agents.data?.find((a) => a.id === agentId),
    gate = gates.data?.find((g) => g.agent_id === agentId);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await client.invalidateQueries({
        predicate: (q) => String(q.queryKey[0]).startsWith("quality-"),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  const evaluator = {
    mode,
    ...(mode === "judge" ? { judgeModelId: judge } : {}),
    minScore: 0.8,
  };
  return (
    <div className="quality-layout">
      <section className="panel">
        <div className="panel-header">
          <div>
            <h3>Quality lab</h3>
            <p>
              Evaluate a saved agent draft before publishing. Runs use real
              provider calls and may incur charges.
            </p>
          </div>
        </div>
        <div className="studio-form">
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {(
            [
              ["Datasets", datasets.error],
              ["Agents", agents.error],
              ["Models", models.error],
              ["Evaluation history", runs.error],
              ["Publication gates", gates.error],
            ] as const
          )
            .filter(([, error]) => error)
            .map(([label, error]) => (
              <p className="error" key={label} role="alert">
                {label}: {error!.message}
              </p>
            ))}
          <WorkspaceSections
            label="Quality sections"
            value={section}
            onChange={setSection}
            sections={[
              {
                id: "datasets",
                label: "Datasets",
                description: "Build repeatable test cases for your agents.",
              },
              {
                id: "evaluate",
                label: "Evaluation",
                description:
                  "Evaluate a saved draft against the selected dataset. Provider calls may incur charges.",
              },
              {
                id: "gates",
                label: "Publication gates",
                description:
                  "Set quality requirements before an agent can be published.",
              },
              {
                id: "history",
                label: "Evaluation history",
                description:
                  "Review completed runs and investigate failed cases.",
              },
            ]}
          />
          <div
            hidden={section !== "datasets"}
            className="workspace-section-body"
          >
            <h4>Choose a dataset</h4>
            <label>
              Dataset
              <select
                aria-label="Dataset"
                value={datasetId}
                onChange={(e) => {
                  setDatasetId(e.target.value);
                  setEditing(false);
                }}
              >
                <option value="">Select dataset</option>
                {datasets.data?.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} · revision {d.revision}
                  </option>
                ))}
              </select>
            </label>
            {datasets.data?.length === 0 && (
              <p>
                No datasets yet. Create examples with a prompt and an expected
                answer, required terms, forbidden terms or expected source IDs.
              </p>
            )}
            {permitted(role, "quality:manage") && (
              <div className="button-row">
                <Button
                  onClick={() => {
                    setEditing(true);
                    setDatasetId("");
                    setName("");
                    setExamples(starter);
                  }}
                >
                  New dataset
                </Button>
                {dataset && (
                  <>
                    <Button
                      onClick={() => {
                        setEditing(true);
                        setName(dataset.name);
                        setExamples(JSON.stringify(dataset.examples, null, 2));
                      }}
                    >
                      Edit examples
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await requestJson(
                            base + "/datasets/" + dataset.id,
                            "DELETE",
                          );
                          setDatasetId("");
                          setNotice(
                            "Dataset archived. Existing evaluation history is retained.",
                          );
                        })
                      }
                    >
                      Archive dataset
                    </Button>
                  </>
                )}
              </div>
            )}
            {dataset && (
              <details>
                <summary>Dataset examples ({dataset.examples.length})</summary>
                <pre>{JSON.stringify(dataset.examples, null, 2)}</pre>
              </details>
            )}
            {editing && (
              <>
                <label>
                  Dataset name
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={100}
                  />
                </label>
                <MultilingualBenchmarkBuilder
                  workspaceId={workspaceId}
                  onAdd={(cases) => {
                    const current: unknown = JSON.parse(examples);
                    if (!Array.isArray(current))
                      throw new Error("Examples must be a JSON array");
                    const rows =
                      JSON.stringify(current) ===
                      JSON.stringify(JSON.parse(starter))
                        ? []
                        : current;
                    if (rows.length + cases.length > 100)
                      throw new Error("A dataset supports at most 100 cases");
                    setExamples(JSON.stringify([...rows, ...cases], null, 2));
                  }}
                />
                <DocumentBenchmarkBuilder
                  workspaceId={workspaceId}
                  onAdd={(example) => {
                    const current: unknown = JSON.parse(examples);
                    if (!Array.isArray(current))
                      throw new Error("Examples must be a JSON array");
                    const rows =
                      JSON.stringify(current) ===
                      JSON.stringify(JSON.parse(starter))
                        ? []
                        : current;
                    setExamples(JSON.stringify([...rows, example], null, 2));
                  }}
                />
                <label>
                  Examples (JSON array)
                  <textarea
                    aria-label="Examples (JSON array)"
                    rows={12}
                    value={examples}
                    onChange={(e) => setExamples(e.target.value)}
                  />
                </label>
                <div className="setting-label-row">
                  <span>
                    Fields: input, expectedBehavior, optional expectedAnswer,
                    contains, forbidden, expectedSourceIds, expectedCitations,
                    documentChecks and tags.
                  </span>
                  <HelpTooltip>
                    Example IDs are generated when omitted. Import by pasting a
                    JSON array; copy the displayed dataset examples to export.
                  </HelpTooltip>
                </div>
                <Button
                  disabled={busy || !name.trim()}
                  onClick={() =>
                    void action(async () => {
                      const data = {
                        name,
                        description: dataset?.description ?? "",
                        examples: JSON.parse(examples),
                      };
                      const saved = dataset
                        ? await requestJson<{ id: string }>(
                            base + "/datasets/" + dataset.id,
                            "PUT",
                            { revision: dataset.revision, dataset: data },
                          )
                        : await requestJson<{ id: string }>(
                            base + "/datasets",
                            "POST",
                            data,
                          );
                      setDatasetId(saved.id);
                      setEditing(false);
                      setNotice("Dataset saved.");
                    })
                  }
                >
                  Save dataset
                </Button>
              </>
            )}
            {dataset && permitted(role, "quality:manage") && (
              <details>
                <summary>Import conversation responses</summary>
                <label>
                  Assistant message IDs (comma separated)
                  <textarea
                    aria-label="Assistant message IDs (comma separated)"
                    value={messageIds}
                    onChange={(e) => setMessageIds(e.target.value)}
                    rows={2}
                  />
                </label>
                <p>
                  Imports the paired prompt and latest reviewed correction, when
                  available. Review imported answers for accuracy before using
                  them as a gate.
                </p>
                <Button
                  disabled={busy || !messageIds.trim()}
                  onClick={() =>
                    void action(async () => {
                      await requestJson(
                        base + "/datasets/" + dataset.id + "/import-messages",
                        "POST",
                        {
                          revision: dataset.revision,
                          messageIds: messageIds
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        },
                      );
                      setMessageIds("");
                      setNotice("Conversation examples imported.");
                    })
                  }
                >
                  Import messages
                </Button>
              </details>
            )}
            <div className="workspace-next-action">
              <Button
                className="secondary"
                onClick={() => setSection("evaluate")}
              >
                Continue to evaluation
              </Button>
            </div>
          </div>
          <div
            hidden={section !== "evaluate"}
            className="workspace-section-body"
          >
            <h4>Evaluate a saved draft</h4>
            <p className="muted">
              Dataset:{" "}
              {datasets.data?.find((d) => d.id === datasetId)?.name ??
                "None selected"}
            </p>
            {!datasetId && (
              <Button
                className="secondary"
                onClick={() => setSection("datasets")}
              >
                Choose a dataset
              </Button>
            )}
            <label>
              Agent
              <select
                aria-label="Agent"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
              >
                <option value="">Select agent</option>
                {agents.data?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · revision {a.revision}
                  </option>
                ))}
              </select>
            </label>
            {agents.data?.length === 0 && (
              <div className="empty">
                <p>No agents yet.</p>
                <Button onClick={() => onNavigate("Agents")}>
                  Create an agent
                </Button>
              </div>
            )}
            <label>
              Evaluator
              <select
                aria-label="Evaluator"
                value={mode}
                onChange={(e) => setMode(e.target.value)}
              >
                <option value="deterministic">Deterministic checks</option>
                <option value="judge">LLM judge + deterministic checks</option>
              </select>
            </label>
            {mode === "judge" && (
              <label>
                Judge model
                <select
                  aria-label="Judge model"
                  value={judge}
                  onChange={(e) => setJudge(e.target.value)}
                >
                  <option value="">Select registered model</option>
                  {models.data?.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Regression baseline (optional)
              <select
                aria-label="Regression baseline (optional)"
                value={baseline}
                onChange={(e) => setBaseline(e.target.value)}
              >
                <option value="">No baseline</option>
                {runs.data
                  ?.filter(
                    (r) =>
                      r.agent_id === agentId &&
                      r.dataset_id === datasetId &&
                      r.status === "completed" &&
                      !r.candidate_release_id,
                  )
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.id.slice(0, 8)}
                    </option>
                  ))}
              </select>
            </label>
            {permitted(role, "quality:execute") && (
              <Button
                disabled={
                  busy || !dataset || !agent || (mode === "judge" && !judge)
                }
                onClick={() =>
                  void action(async () => {
                    const result = await requestJson<{ id: string }>(
                      base + "/evaluations",
                      "POST",
                      {
                        agentId,
                        datasetId,
                        revision: agent!.revision,
                        evaluator,
                        ...(baseline ? { baselineRunId: baseline } : {}),
                      },
                    );
                    setSelected(result.id);
                    setSection("history");
                    setNotice(
                      "Evaluation queued. Results update automatically.",
                    );
                  })
                }
              >
                Run evaluation
              </Button>
            )}
          </div>
          <div hidden={section !== "gates"} className="workspace-section-body">
            <h4>Publication gate</h4>
            <p className="muted">
              Agent:{" "}
              {agents.data?.find((a) => a.id === agentId)?.name ??
                "None selected"}{" "}
              · Dataset:{" "}
              {datasets.data?.find((d) => d.id === datasetId)?.name ??
                "None selected"}
            </p>
            <Button
              className="secondary"
              onClick={() => setSection("evaluate")}
            >
              Change evaluation settings
            </Button>
            <p>
              {gate?.settings.enabled
                ? `Enabled · requires ${Math.round(gate.settings.minPassRate * 100)}% passing cases`
                : "No publication gate enabled for the selected agent."}{" "}
            </p>
            <SettingsHint label="Provider errors block publication">
              When a publication gate is enabled, a provider failure blocks
              publishing regardless of the required pass rate.
            </SettingsHint>
            {permitted(role, "operations:manage") && (
              <>
                <label>
                  Required pass rate (%)
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={threshold}
                    onChange={(e) => setThreshold(Number(e.target.value))}
                  />
                </label>
                <div className="button-row">
                  <Button
                    disabled={
                      busy || !agent || !dataset || (mode === "judge" && !judge)
                    }
                    onClick={() =>
                      void action(async () => {
                        await requestJson(
                          base + "/quality-gates/" + agentId,
                          "PUT",
                          {
                            enabled: true,
                            datasetId,
                            minPassRate: threshold / 100,
                            evaluator,
                          },
                        );
                        setNotice(
                          "Publication gate saved for the selected dataset and evaluator.",
                        );
                      })
                    }
                  >
                    Enable gate
                  </Button>
                  <Button
                    disabled={busy || !agent || !gate?.settings.enabled}
                    onClick={() =>
                      void action(async () => {
                        await requestJson(
                          base + "/quality-gates/" + agentId,
                          "PUT",
                          {
                            enabled: false,
                            datasetId: null,
                            minPassRate: 1,
                            evaluator: { mode: "deterministic", minScore: 0.8 },
                          },
                        );
                        setNotice("Publication gate disabled.");
                      })
                    }
                  >
                    Disable gate
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </section>
      <section className="panel" hidden={section !== "history"}>
        <div className="panel-header">
          <div>
            <h3>Evaluation history</h3>
            <SettingsHint label="Review failed cases before publishing">
              Failed cases highlight prompts and knowledge gaps. LLM scores are
              advisory; review the actual outputs before publication.
            </SettingsHint>
          </div>
        </div>
        <div className="studio-form">
          {runs.data?.length === 0 && <p>No evaluations yet.</p>}
          {runs.data?.map((r) => (
            <button
              className="quality-run"
              key={r.id}
              onClick={() => setSelected(r.id)}
            >
              {r.id.slice(0, 8)} · {r.status}
              {r.candidate_release_id ? " · Private knowledge candidate" : ""}
              {r.summary
                ? ` · ${Math.round(r.summary.passRate * 100)}% pass`
                : ""}
            </button>
          ))}
          {detail.error && <p className="error">{detail.error.message}</p>}
          {detail.data && (
            <>
              <h4>
                Run {selected.slice(0, 8)} · {detail.data.status}
              </h4>
              {detail.data.candidate_release_id && (
                <p>
                  Private knowledge candidate —{" "}
                  {detail.data.candidate_version_id
                    ? "published agent version"
                    : "saved draft"}
                  . This run does not authorize normal agent publication.
                </p>
              )}
              {detail.data.error_code && (
                <p className="error">{detail.data.error_code}</p>
              )}
              {detail.data.summary && (
                <p>
                  Pass rate: {Math.round(detail.data.summary.passRate * 100)}%.
                  Provider failures: {detail.data.summary.failedCases}. Average
                  latency: {Math.round(detail.data.summary.meanLatencyMs)} ms.
                  Retrieval recall:{" "}
                  {detail.data.summary.retrievalRecall === null
                    ? "not measured"
                    : detail.data.summary.retrievalRecall}
                  . Cost:{" "}
                  {detail.data.summary.cost === null
                    ? "unknown (usage or pricing unavailable)"
                    : `$${detail.data.summary.cost.toFixed(6)}`}
                  .{" "}
                  {detail.data.summary.regression &&
                    `Pass rate change: ${(detail.data.summary.regression.passRateDelta * 100).toFixed(1)} percentage points.`}
                </p>
              )}
              {["queued", "running"].includes(detail.data.status) &&
                permitted(role, "quality:execute") && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await requestJson(
                          base + "/evaluations/" + selected + "/cancel",
                          "POST",
                        );
                      })
                    }
                  >
                    Cancel evaluation
                  </Button>
                )}
              {detail.data.summary &&
                [
                  detail.data.summary.extractionTextSimilarity,
                  detail.data.summary.tableCellAccuracy,
                  detail.data.summary.citationRecall,
                ].some((value) => value != null) && (
                  <div className="benchmark-summary">
                    <h4>Document benchmark</h4>
                    <p>
                      Extraction text similarity:{" "}
                      {detail.data.summary.extractionTextSimilarity == null
                        ? "not measured"
                        : `${(detail.data.summary.extractionTextSimilarity * 100).toFixed(1)}%`}
                      . Exact cell accuracy:{" "}
                      {detail.data.summary.tableCellAccuracy == null
                        ? "not measured"
                        : `${(detail.data.summary.tableCellAccuracy * 100).toFixed(1)}%`}
                      . Expected citation coverage:{" "}
                      {detail.data.summary.citationRecall == null
                        ? "not measured"
                        : `${(detail.data.summary.citationRecall * 100).toFixed(1)}%`}
                      .
                    </p>
                    <p>
                      Only authored reference checks are measured; a passing run
                      does not certify every extracted value.
                    </p>
                  </div>
                )}
              <MultilingualReport
                report={detail.data.summary?.multilingual}
                baseline={detail.data.summary?.regression?.languagePairs}
              />
              {!!detail.data.summary?.segments?.length && (
                <div className="table-wrap">
                  <table>
                    <caption>Benchmark results by tag</caption>
                    <thead>
                      <tr>
                        <th>Segment</th>
                        <th>Cases</th>
                        <th>Pass rate</th>
                        <th>Text similarity</th>
                        <th>Exact cells</th>
                        <th>Expected citations</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.data.summary.segments.map((segment) => (
                        <tr key={segment.tag}>
                          <td>{segment.tag}</td>
                          <td>{segment.cases}</td>
                          {[
                            segment.passRate,
                            segment.extractionTextSimilarity,
                            segment.tableCellAccuracy,
                            segment.citationRecall,
                          ].map((value, index) => (
                            <td key={index}>
                              {value == null
                                ? "Not measured"
                                : `${(value * 100).toFixed(1)}%`}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <Button
                className="secondary"
                onClick={() => {
                  const blob = new Blob(
                    [JSON.stringify(detail.data, null, 2)],
                    { type: "application/json" },
                  );
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `benchmark-${selected}.json`;
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}
              >
                Export evaluation JSON
              </Button>
              {detail.data.results.map((r) => {
                const e = detail.data!.examples_snapshot.find(
                  (e) => e.id === r.example_id,
                );
                return (
                  <article className="quality-case" key={r.example_id}>
                    <strong>
                      {r.passed ? "Passed" : "Needs review"} ·{" "}
                      {r.score === null ? "no score" : r.score.toFixed(2)}
                    </strong>
                    <p>{e?.input}</p>
                    {e?.tags.length ? <p>Tags: {e.tags.join(", ")}</p> : null}
                    <pre>{r.output || "No response"}</pre>
                    {r.error_code && <p className="error">{r.error_code}</p>}
                    {r.metrics && (
                      <details>
                        <summary>
                          Measured checks and document revisions
                        </summary>
                        <pre>{JSON.stringify(r.metrics, null, 2)}</pre>
                      </details>
                    )}
                  </article>
                );
              })}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
