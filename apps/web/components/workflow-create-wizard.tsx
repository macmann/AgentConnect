"use client";
import { ReactFlow, Background } from "@xyflow/react";
import { workflowNodeTypes } from "./workflow-canvas-node";
import { useState } from "react";
import {
  workflowTemplates,
  workflowFromTemplate,
} from "@agentconnect/schemas/workflow-templates";
import type { WorkflowGraph } from "@agentconnect/schemas/workflows";
import { Button } from "./button";
import { HelpTooltip } from "./help-tooltip";

type Setup = { name: string; description: string; graph: WorkflowGraph };
export function WorkflowCreateWizard({
  agents,
  loading,
  error,
  onCreate,
  onBlank,
  onCancel,
}: {
  agents: { id: string; name: string; version: number }[];
  loading: boolean;
  error?: string;
  onCreate: (setup: Setup) => Promise<void>;
  onBlank: () => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState(1),
    [templateId, setTemplate] = useState(workflowTemplates[0]!.id);
  const [name, setName] = useState(""),
    [description, setDescription] = useState("");
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState("");
  const template = workflowTemplates.find((t) => t.id === templateId)!;
  const graph = workflowFromTemplate(templateId);
  const required = graph.nodes.filter((n) => n.type === "agent");
  const ready = required.every((n) =>
    agents.some((a) => a.id === assignments[n.id]),
  );
  const configured = {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.type === "agent"
        ? { ...n, data: { ...n.data, agentVersionId: assignments[n.id] } }
        : n,
    ),
  };
  return (
    <section
      className="workflow-wizard"
      aria-labelledby="workflow-setup-heading"
    >
      <header className="panel-header">
        <div>
          <h3 id="workflow-setup-heading">Create your workflow</h3>
          <p>Start with a purpose, connect your agents, then review.</p>
        </div>
        <Button className="secondary" disabled={busy} onClick={onCancel}>
          Cancel setup
        </Button>
      </header>
      <ol className="workflow-stepper" aria-label="Creation progress">
        {["Purpose", "Setup", "Review"].map((title, i) => (
          <li key={title} aria-current={step === i + 1 ? "step" : undefined}>
            <span>{i + 1}</span>
            {title}
          </li>
        ))}
      </ol>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (step < 3) {
            setStep(step + 1);
            return;
          }
          setBusy(true);
          setFailure("");
          try {
            await onCreate({
              name: name.trim(),
              description,
              graph: configured,
            });
          } catch (e) {
            setFailure(
              e instanceof Error ? e.message : "Unable to create workflow",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {failure && (
          <p role="alert" className="error-banner">
            {failure}
          </p>
        )}
        {step === 1 && (
          <div className="workflow-wizard-body">
            <h4>What should this workflow do?</h4>
            <label htmlFor="workflow-setup-name">Workflow name</label>
            <input
              id="workflow-setup-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
              placeholder="Customer enquiry review"
            />
            <div
              className="workflow-template-grid"
              role="group"
              aria-label="Starter templates"
            >
              {workflowTemplates.map((t) => (
                <button
                  type="button"
                  className="workflow-template-card"
                  aria-pressed={t.id === templateId}
                  key={t.id}
                  onClick={() => {
                    setTemplate(t.id);
                    if (t.id !== templateId) setAssignments({});
                  }}
                >
                  <strong>{t.name}</strong>
                  <span>{t.description}</span>
                  <small>{t.nodes.length} steps</small>
                </button>
              ))}
            </div>
            <label htmlFor="workflow-setup-description">
              Description (optional)
            </label>
            <textarea
              id="workflow-setup-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
              rows={2}
            />
          </div>
        )}
        {step === 2 && (
          <div className="workflow-wizard-body">
            <div className="setting-label-row">
              <h4>Choose published agents</h4>
              <HelpTooltip label="Help for published agents">
                Each step uses an immutable published agent version. Publish an
                agent in Agents if it is missing here. You can use different
                agents for research and synthesis.
              </HelpTooltip>
            </div>
            {loading && <p role="status">Loading published agents…</p>}
            {error && (
              <p role="alert" className="error-banner">
                {error}
              </p>
            )}
            {!loading && !error && !agents.length && (
              <p>
                No published agents available. Publish an agent in Agents, then
                return to setup.
              </p>
            )}
            {required.map((n) => (
              <label key={n.id} htmlFor={`setup-agent-${n.id}`}>
                {n.data.label}
                <select
                  aria-label={n.data.label}
                  id={`setup-agent-${n.id}`}
                  required
                  value={assignments[n.id] ?? ""}
                  onChange={(e) =>
                    setAssignments({ ...assignments, [n.id]: e.target.value })
                  }
                >
                  <option value="">Select a published agent</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · v{a.version}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            {graph.nodes.some((n) => n.type === "approval") && (
              <div className="setting-label-row">
                <span>Staff approval before releasing the answer</span>
                <HelpTooltip>
                  Authorized operators approve or reject a waiting run. Review
                  instructions can be edited on the canvas.
                </HelpTooltip>
              </div>
            )}
          </div>
        )}
        {step === 3 && (
          <div className="workflow-wizard-body">
            <h4>Review {name}</h4>
            <p>
              {template.name} · {graph.nodes.length} steps
            </p>
            <div
              className="workflow-review-canvas"
              aria-label="Workflow preview"
            >
              <ReactFlow
                nodes={configured.nodes.map((n) => ({
                  id: n.id,
                  type: "workflow",
                  position: n.position,
                  data: { label: n.data.label, kind: n.type },
                }))}
                edges={configured.edges}
                nodeTypes={workflowNodeTypes}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                deleteKeyCode={null}
                fitView
                minZoom={0.15}
                maxZoom={1.25}
              >
                <Background />
              </ReactFlow>
            </div>
            <ul className="workflow-review-flow">
              {configured.nodes.map((n) => (
                <li key={n.id}>
                  <strong>{n.data.label}</strong>
                  <span>
                    {n.type === "agent"
                      ? agents.find((a) => a.id === n.data.agentVersionId)?.name
                      : n.type}
                  </span>
                </li>
              ))}
            </ul>
            <p className="muted">
              This creates a saved draft. Test and publish it from the studio
              when ready.
            </p>
          </div>
        )}
        <footer className="workflow-wizard-footer">
          <Button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={step === 1 ? onBlank : () => setStep(step - 1)}
          >
            {step === 1 ? "Open canvas directly" : "Back"}
          </Button>
          <Button
            type="submit"
            disabled={busy || !name.trim() || (step > 1 && (!ready || !!error))}
          >
            {busy ? "Creating…" : step === 3 ? "Create draft" : "Continue"}
          </Button>
        </footer>
      </form>
    </section>
  );
}
