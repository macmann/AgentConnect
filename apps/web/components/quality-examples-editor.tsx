"use client";
import { useState } from "react";
import { Button } from "./button";
import { HelpTooltip } from "./help-tooltip";

/** Edit the common fields without discarding advanced assertions or unknown fields. */
export function QualityExamplesEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [page, setPage] = useState(0);
  let rows: Record<string, unknown>[] | undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (row) => row && typeof row === "object" && !Array.isArray(row),
      )
    )
      rows = parsed;
  } catch {
    /* Keep malformed imports editable in the raw editor. */
  }
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil((rows?.length ?? 0) / 5) - 1),
  );
  function update(index: number, field: string, text: string) {
    onChange(
      JSON.stringify(
        rows!.map((row, i) => (i === index ? { ...row, [field]: text } : row)),
        null,
        2,
      ),
    );
  }
  return (
    <div className="quality-examples-editor">
      <div className="section-heading">
        <h4>Test questions</h4>
        <HelpTooltip label="About test examples">
          Example IDs are generated when omitted. Advanced JSON supports
          required terms, forbidden terms, expected sources, citations, document
          checks and tags. Editing a question preserves its other assertions.
        </HelpTooltip>
      </div>
      {!rows && (
        <p className="error-banner" role="alert">
          Examples must be a JSON array of objects. Open Advanced JSON to
          correct the import.
        </p>
      )}
      {rows?.slice(currentPage * 5, currentPage * 5 + 5).map((row, offset) => {
        const index = currentPage * 5 + offset;
        return (
          <fieldset key={index} className="quality-example-row">
            <legend>Question {index + 1}</legend>
            <label>
              Question
              <textarea
                aria-label={`Question ${index + 1}`}
                rows={2}
                value={typeof row.input === "string" ? row.input : ""}
                onChange={(e) => update(index, "input", e.target.value)}
              />
            </label>
            <label>
              Expected behavior
              <textarea
                aria-label={`Expected behavior ${index + 1}`}
                rows={2}
                value={
                  typeof row.expectedBehavior === "string"
                    ? row.expectedBehavior
                    : ""
                }
                onChange={(e) =>
                  update(index, "expectedBehavior", e.target.value)
                }
              />
            </label>
            <details className="settings-guide">
              <summary>Expected answer (optional)</summary>
              <label>
                Expected answer
                <textarea
                  aria-label={`Expected answer ${index + 1}`}
                  rows={2}
                  value={
                    typeof row.expectedAnswer === "string"
                      ? row.expectedAnswer
                      : ""
                  }
                  onChange={(e) =>
                    update(index, "expectedAnswer", e.target.value)
                  }
                />
              </label>
            </details>
            <Button
              className="secondary"
              aria-label={`Remove question ${index + 1}`}
              onClick={() =>
                onChange(
                  JSON.stringify(
                    rows!.filter((_, i) => i !== index),
                    null,
                    2,
                  ),
                )
              }
            >
              Remove
            </Button>
          </fieldset>
        );
      })}
      {rows && rows.length > 5 && (
        <div className="button-row" aria-label="Question pages">
          <Button
            className="secondary"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous questions
          </Button>
          <span>
            Page {currentPage + 1} of {Math.ceil(rows.length / 5)}
          </span>
          <Button
            className="secondary"
            disabled={(currentPage + 1) * 5 >= rows.length}
            onClick={() => setPage(currentPage + 1)}
          >
            Next questions
          </Button>
        </div>
      )}
      {rows && (
        <Button
          className="secondary"
          onClick={() => {
            setPage(Math.floor(rows!.length / 5));
            onChange(
              JSON.stringify(
                [...rows!, { input: "", expectedBehavior: "" }],
                null,
                2,
              ),
            );
          }}
        >
          Add question
        </Button>
      )}
      <details className="settings-guide">
        <summary>Advanced JSON / import</summary>
        <label>
          Examples (JSON array)
          <textarea
            aria-label="Examples (JSON array)"
            rows={8}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
          />
        </label>
      </details>
    </div>
  );
}
