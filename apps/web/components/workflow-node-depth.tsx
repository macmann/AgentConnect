"use client";
import { HelpTooltip } from "./help-tooltip";
import type { WorkflowNode } from "@agentconnect/schemas/workflows";
export function WorkflowNodeDepth({
  node,
  onChange,
}: {
  node: WorkflowNode;
  onChange: (data: Partial<WorkflowNode["data"]>) => void;
}) {
  return (
    <>
      {["agent", "tool"].includes(node.type) && (
        <details className="configure-group">
          <summary>Failure recovery</summary>
          <div className="setting-label-row">
            <span>Retry temporary provider failures.</span>
            <HelpTooltip>
              Invalid settings, unavailable credentials and rejected approvals
              stop immediately. Retries can increase model cost.
            </HelpTooltip>
          </div>
          <label>
            Total attempts
            <input
              type="number"
              min={1}
              max={3}
              value={node.data.retry.maxAttempts}
              onChange={(e) =>
                onChange({
                  retry: {
                    ...node.data.retry,
                    maxAttempts: Number(e.target.value),
                  },
                })
              }
            />
          </label>
          <label>
            Initial retry delay (milliseconds)
            <input
              type="number"
              min={100}
              max={10000}
              step={100}
              value={node.data.retry.delayMs}
              onChange={(e) =>
                onChange({
                  retry: {
                    ...node.data.retry,
                    delayMs: Number(e.target.value),
                  },
                })
              }
            />
          </label>
          <small>
            One attempt disables retries. Delays double between attempts, up to
            10 seconds. Retries repeat this step only.
          </small>
        </details>
      )}
      {node.type === "output" && (
        <>
          <label>
            Result title
            <input
              value={node.data.resultTitle}
              maxLength={120}
              onChange={(e) => onChange({ resultTitle: e.target.value })}
            />
          </label>
          <label>
            Result description
            <textarea
              value={node.data.resultSummary}
              maxLength={400}
              onChange={(e) => onChange({ resultSummary: e.target.value })}
            />
          </label>
          <label>
            Result display
            <select
              aria-label="Result display"
              value={node.data.resultFormat}
              onChange={(e) =>
                onChange({
                  resultFormat: e.target
                    .value as WorkflowNode["data"]["resultFormat"],
                })
              }
            >
              <option value="auto">Automatic: text, fields or table</option>
              <option value="text">Plain text</option>
              <option value="json">Technical JSON</option>
            </select>
          </label>
          <p>
            Controls how the existing output is displayed. No new model call or
            change to the returned data.
          </p>
        </>
      )}
    </>
  );
}
