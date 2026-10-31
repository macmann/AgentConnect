"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  workflowDefinitionV2,
  type WorkflowDefinitionV2,
} from "@agentconnect/schemas/workflow-v2";
import { workflowMappingSummary } from "@agentconnect/schemas/workflow-assistant";
import type {
  WorkflowMutation,
  WorkflowAssistantRequest,
} from "@agentconnect/schemas/workflow-assistant";
import { requestJson } from "./agent-client";
import { Button } from "./button";
type Reply = {
  message: string;
  definition: WorkflowDefinitionV2 | null;
  operations: WorkflowMutation[];
  changes: string[];
  warnings: string[];
  mode: WorkflowAssistantRequest["mode"];
};
export function WorkflowAssistant({
  workspaceId,
  workflowId,
  definition,
  selectedNodeId,
  editable,
  initialMode = "modify",
  onPreview,
  onApply,
}: {
  workspaceId: string;
  workflowId: string;
  definition: WorkflowDefinitionV2;
  selectedNodeId: string;
  editable: boolean;
  initialMode?: "create" | "modify";
  onPreview: (definition: WorkflowDefinitionV2 | null) => void;
  onApply: (definition: WorkflowDefinitionV2) => void;
}) {
  const settings = useQuery({
    queryKey: ["creation-settings", workspaceId],
    queryFn: () =>
      requestJson<{ enabled: boolean; available: boolean; modelName: string }>(
        `/workspaces/${workspaceId}/creation-settings`,
      ),
  });
  const [mode, setMode] = useState<WorkflowAssistantRequest["mode"]>(
      editable ? initialMode : "explain",
    ),
    [prompt, setPrompt] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [reviewed, setReviewed] = useState(false);
  const [proposal, setProposal] = useState<{
    reply: Reply;
    base: string;
    selected: string;
  } | null>(null);
  const sequence = useRef(0),
    current = useRef(definition);
  current.current = definition;
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  const stale =
    !!proposal &&
    (proposal.base !== JSON.stringify(definition) ||
      (proposal.reply.mode === "configure" &&
        proposal.selected !== selectedNodeId));
  const ready = settings.data?.enabled && settings.data.available;
  function cancel() {
    sequence.current++;
    setProposal(null);
    setError("");
    setNotice("Proposal canceled. The workflow is unchanged.");
    setBusy(false);
    onPreview(null);
  }
  async function generate() {
    const turn = ++sequence.current,
      source = JSON.stringify(definition),
      selected = selectedNodeId;
    setBusy(true);
    setError("");
    setNotice("");
    setProposal(null);
    setReviewed(false);
    onPreview(null);
    try {
      const response = await requestJson<Reply>(
        `/workspaces/${workspaceId}/workflow-assistant`,
        "POST",
        {
          mode,
          prompt:
            prompt.trim() ||
            (mode === "explain"
              ? "Explain this workflow in plain language."
              : ""),
          definition,
          workflowId: workflowId || undefined,
          selectedNodeId: selected || undefined,
        },
      );
      if (turn !== sequence.current) return;
      if (response.definition)
        response.definition = workflowDefinitionV2.parse(response.definition);
      setProposal({ reply: response, base: source, selected });
      if (current.current && source === JSON.stringify(current.current))
        onPreview(response.definition);
    } catch (e) {
      if (turn === sequence.current) setError((e as Error).message);
    } finally {
      if (turn === sequence.current) setBusy(false);
    }
  }
  async function apply() {
    if (!proposal?.reply.definition || stale || busy) return;
    const turn = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      const checked = await requestJson<{ valid: boolean; warnings: string[] }>(
        `/workspaces/${workspaceId}/workflow-assistant/validate`,
        "POST",
        {
          definition: proposal.reply.definition,
          workflowId: workflowId || undefined,
        },
      );
      if (turn !== sequence.current) return;
      if (proposal.base !== JSON.stringify(current.current))
        throw new Error(
          "The workflow changed. Request a fresh proposal before applying.",
        );
      if (checked.warnings.some((w) => !proposal.reply.warnings.includes(w))) {
        setProposal({
          ...proposal,
          reply: { ...proposal.reply, warnings: checked.warnings },
        });
        setReviewed(false);
        throw new Error(
          "Validation found new warnings. Review them before applying.",
        );
      }
      onApply(proposal.reply.definition);
      onPreview(null);
      setProposal(null);
      setNotice("Proposal applied to the canvas. Save draft when ready.");
    } catch (e) {
      if (turn === sequence.current) setError((e as Error).message);
    } finally {
      if (turn === sequence.current) setBusy(false);
    }
  }
  return (
    <div className="workflow-assistant">
      <h3>Workflow AI assistant</h3>
      <p>
        Describe the workflow or a change. Review the proposed canvas before
        applying. Nothing is saved, published or run automatically.
      </p>
      {settings.isPending && <p>Loading assistant settings…</p>}
      {settings.error && <p role="alert">{settings.error.message}</p>}
      {settings.data && !ready && (
        <p role="note">
          Ask a workspace administrator to enable AI creation and select an
          assistant model in Settings. Manual editing remains available.
        </p>
      )}
      {ready && <p>Assistant model: {settings.data?.modelName}</p>}
      <label>
        Assistant task
        <select
          aria-label="Assistant task"
          value={mode}
          disabled={busy}
          onChange={(e) => {
            setMode(e.target.value as typeof mode);
            setProposal(null);
            setError("");
            setNotice("");
            onPreview(null);
          }}
        >
          {editable && (
            <>
              <option value="create">Create workflow from description</option>
              <option value="modify">Modify current workflow</option>
              <option value="configure" disabled={!selectedNodeId}>
                Configure selected node
              </option>
            </>
          )}
          <option value="explain">Explain workflow</option>
        </select>
      </label>
      {mode === "configure" && (
        <p>
          Selected step:{" "}
          {definition.execution.nodes.find((n) => n.id === selectedNodeId)
            ?.label ?? "Select a node on the canvas"}
        </p>
      )}
      <label>
        Instructions
        <textarea
          aria-label="Workflow AI instructions"
          rows={5}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={4000}
          placeholder="Map the extracted invoice number, supplier and total into the database action."
        />
      </label>
      <Button
        disabled={
          !ready ||
          busy ||
          (!prompt.trim() && mode !== "explain") ||
          (mode === "configure" && !selectedNodeId)
        }
        onClick={() => void generate()}
      >
        {busy
          ? "Validating proposal…"
          : mode === "explain"
            ? "Explain workflow"
            : "Propose changes"}
      </Button>
      {busy && <Button onClick={cancel}>Cancel request</Button>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {proposal && (
        <section aria-label="AI proposal preview">
          <h4>
            {proposal.reply.definition
              ? "Review proposed changes"
              : "Assistant response"}
          </h4>
          <p style={{ whiteSpace: "pre-wrap" }}>{proposal.reply.message}</p>
          {proposal.reply.definition && (
            <>
              <p>
                The canvas previews this proposal. Your draft stays unchanged
                until Apply.
              </p>
              <ul>
                {proposal.reply.changes.map((change, i) => (
                  <li key={i}>{change}</li>
                ))}
              </ul>
              {!!workflowMappingSummary(proposal.reply.definition).length && (
                <details open>
                  <summary>Proposed field mappings</summary>
                  <ul>
                    {workflowMappingSummary(proposal.reply.definition).map(
                      (mapping, i) => (
                        <li key={i}>{mapping}</li>
                      ),
                    )}
                  </ul>
                </details>
              )}
              {!!proposal.reply.warnings.length && (
                <div role="note" className="warning-banner">
                  <strong>Review required</strong>
                  <ul>
                    {proposal.reply.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                  <label>
                    <input
                      type="checkbox"
                      checked={reviewed}
                      onChange={(e) => setReviewed(e.target.checked)}
                    />
                    I reviewed the warnings and side effects
                  </label>
                </div>
              )}
              <details>
                <summary>Proposed definition and mappings</summary>
                <pre>{JSON.stringify(proposal.reply.definition, null, 2)}</pre>
              </details>
              {!!proposal.reply.operations.length && (
                <details>
                  <summary>Structured mutations</summary>
                  <pre>
                    {JSON.stringify(proposal.reply.operations, null, 2)}
                  </pre>
                </details>
              )}
              {stale && (
                <p role="alert">
                  The workflow or selected node changed. Request a fresh
                  proposal.
                </p>
              )}
              <Button
                disabled={
                  !editable ||
                  busy ||
                  stale ||
                  (!!proposal.reply.warnings.length && !reviewed)
                }
                onClick={() => void apply()}
              >
                Apply proposal
              </Button>
            </>
          )}
          <Button disabled={busy} onClick={cancel}>
            {proposal.reply.definition ? "Cancel proposal" : "Dismiss response"}
          </Button>
        </section>
      )}
    </div>
  );
}
