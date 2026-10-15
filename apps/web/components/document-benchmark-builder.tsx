"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { requestJson } from "./agent-client";
import { Button } from "./button";
import { HelpTooltip } from "./help-tooltip";
export function DocumentBenchmarkBuilder({
  workspaceId,
  onAdd,
}: {
  workspaceId: string;
  onAdd: (example: unknown) => void;
}) {
  const [kb, setKb] = useState(""),
    [source, setSource] = useState(""),
    [page, setPage] = useState(1),
    [question, setQuestion] = useState(""),
    [answer, setAnswer] = useState(""),
    [reference, setReference] = useState(""),
    [similarity, setSimilarity] = useState(0.98),
    [citation, setCitation] = useState(true),
    [tags, setTags] = useState("document"),
    [cells, setCells] = useState<
      { table: number; row: number; column: number; value: string }[]
    >([]),
    [error, setError] = useState("");
  const bases = useQuery({
    queryKey: ["benchmark-bases", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(
        `/workspaces/${workspaceId}/knowledge-bases`,
      ),
  });
  const sources = useQuery({
    queryKey: ["benchmark-sources", kb],
    queryFn: () =>
      requestJson<
        { id: string; title: string; status: string; kind: string }[]
      >(`/knowledge-bases/${kb}/sources`),
    enabled: !!kb,
  });
  return (
    <details className="configure-group">
      <summary>Add a real-document benchmark case</summary>
      <p>
        Use a document you have inspected and provide trusted reference values.
        These are ground truth for repeatable checks, not model-generated
        answers.
      </p>
      {(bases.error || sources.error) && (
        <p role="alert" className="error">
          {bases.error?.message ?? sources.error?.message}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="form-grid">
        <label>
          Benchmark knowledge base
          <select
            value={kb}
            onChange={(e) => {
              setKb(e.target.value);
              setSource("");
            }}
          >
            <option value="">Select knowledge</option>
            {bases.data?.map((b) => (
              <option value={b.id} key={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Benchmark source
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">Select a ready source</option>
            {sources.data
              ?.filter((s) => s.status === "ready" && s.kind !== "website")
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
          </select>
        </label>
      </div>
      <label>
        Benchmark page
        <input
          type="number"
          min={1}
          max={200}
          value={page}
          onChange={(e) => setPage(Number(e.target.value))}
        />
      </label>
      <label>
        Benchmark question
        <textarea
          value={question}
          rows={2}
          onChange={(e) => setQuestion(e.target.value)}
        />
      </label>
      <label>
        Required answer text (optional)
        <textarea
          value={answer}
          rows={2}
          onChange={(e) => setAnswer(e.target.value)}
        />
      </label>
      <label>
        Reference transcription (optional)
        <textarea
          value={reference}
          rows={4}
          maxLength={20000}
          onChange={(e) => setReference(e.target.value)}
        />
      </label>
      <div className="setting-label-row">
        <label>
          Minimum text similarity
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={similarity}
            onChange={(e) => setSimilarity(Number(e.target.value))}
          />
        </label>
        <HelpTooltip>
          Whitespace-normalized Unicode character-trigram similarity, from 0 to
          1. This is an approximate text similarity measure, not a certified OCR
          character error rate. For financial values, add exact cell checks.
        </HelpTooltip>
      </div>
      <h4>Expected table cells</h4>
      <p>
        Positions start at 1 and include header rows. Values compare exactly
        after Unicode and whitespace normalization; numeric separators are
        preserved.
      </p>
      {cells.map((cell, index) => (
        <div className="benchmark-cell-row" key={index}>
          {(["table", "row", "column"] as const).map((key) => (
            <label key={key}>
              {key}
              <input
                aria-label={`Expected cell ${index + 1} ${key}`}
                type="number"
                min={1}
                max={key === "table" ? 200 : key === "row" ? 1000 : 100}
                value={cell[key] + 1}
                onChange={(e) =>
                  setCells((previous) =>
                    previous.map((v, i) =>
                      i === index
                        ? { ...v, [key]: Number(e.target.value) - 1 }
                        : v,
                    ),
                  )
                }
              />
            </label>
          ))}
          <label>
            Value
            <input
              aria-label={`Expected cell ${index + 1} value`}
              value={cell.value}
              onChange={(e) =>
                setCells((previous) =>
                  previous.map((v, i) =>
                    i === index ? { ...v, value: e.target.value } : v,
                  ),
                )
              }
            />
          </label>
          <Button
            className="secondary"
            onClick={() =>
              setCells((previous) => previous.filter((_, i) => i !== index))
            }
          >
            Remove cell {index + 1}
          </Button>
        </div>
      ))}
      <Button
        className="secondary"
        disabled={cells.length >= 100}
        onClick={() =>
          setCells((previous) => [
            ...previous,
            { table: 0, row: 0, column: 0, value: "" },
          ])
        }
      >
        Add expected cell
      </Button>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={citation}
          onChange={(e) => setCitation(e.target.checked)}
        />
        Require a citation to this source page
      </label>
      <label>
        Benchmark tags
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="multilingual, financial, unanswerable"
        />
      </label>
      <Button
        disabled={!source || !question.trim()}
        onClick={() => {
          setError("");
          try {
            if (
              !reference.trim() &&
              !cells.length &&
              !answer.trim() &&
              !citation
            )
              throw new Error(
                "Add an expected answer, reference text, cell check or citation check.",
              );
            onAdd({
              input: question,
              expectedBehavior: answer.trim()
                ? "Match the verified answer"
                : "Answer using the verified document evidence",
              ...(answer.trim() ? { contains: [answer] } : {}),
              tags: tags
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
              expectedSourceIds: citation ? [source] : [],
              expectedCitations: citation ? [{ sourceId: source, page }] : [],
              documentChecks:
                reference.trim() || cells.length
                  ? [
                      {
                        sourceId: source,
                        page,
                        ...(reference.trim()
                          ? { expectedText: reference }
                          : {}),
                        minTextSimilarity: similarity,
                        cells,
                      },
                    ]
                  : [],
            });
            setQuestion("");
            setAnswer("");
            setReference("");
            setCells([]);
          } catch (e) {
            setError(e instanceof Error ? e.message : "Unable to add case");
          }
        }}
      >
        Add benchmark case to dataset
      </Button>
    </details>
  );
}
