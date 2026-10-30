"use client";
import { useEffect, useRef, useState } from "react";
import {
  workflowKinds,
  type WorkflowNode,
} from "@agentconnect/schemas/workflows";
import { Button } from "./button";
import { HelpTooltip } from "./help-tooltip";
export function WorkflowCanvasToolbar({
  disabled,
  canAdd,
  onAdd,
  undo,
  redo,
  duplicate,
  layout,
  canUndo,
  canRedo,
  canDuplicate,
  canDelete,
  onDelete,
}: {
  disabled: boolean;
  canAdd: boolean;
  onAdd: (kind: WorkflowNode["type"]) => void;
  undo: () => void;
  redo: () => void;
  duplicate: () => void;
  layout: () => void;
  canUndo: boolean;
  canRedo: boolean;
  canDuplicate: boolean;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (disabled || !canAdd) setOpen(false);
  }, [disabled, canAdd]);
  return (
    <div
      ref={root}
      className="canvas-toolbar nodrag nopan"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          setOpen(false);
          root.current?.querySelector<HTMLButtonElement>("button")?.focus();
          e.stopPropagation();
        }
      }}
    >
      <div className="canvas-toolbar-actions">
        <Button
          className="secondary"
          aria-expanded={open}
          disabled={disabled || !canAdd}
          onClick={() => setOpen(!open)}
        >
          ＋ Add nodes
        </Button>
        <Button
          className="secondary"
          disabled={disabled || !canUndo}
          onClick={undo}
        >
          Undo
        </Button>
        <Button
          className="secondary"
          disabled={disabled || !canRedo}
          onClick={redo}
        >
          Redo
        </Button>
        <Button
          className="secondary"
          disabled={disabled || !canDuplicate}
          onClick={duplicate}
        >
          Duplicate node
        </Button>
        <Button
          className="secondary"
          disabled={disabled || !canDelete}
          onClick={onDelete}
        >
          Delete selected
        </Button>
        <Button className="secondary" disabled={disabled} onClick={layout}>
          Auto layout
        </Button>
      </div>
      {open && (
        <div
          className="canvas-node-palette"
          role="region"
          aria-label="Node palette"
        >
          <div className="setting-label-row">
            <strong>Choose a node</strong>
            <HelpTooltip>
              Click to insert after the selected step. Decisions also create two
              branches and a merge. Drag a node onto the canvas to place an
              unconnected step exactly where you want it.
            </HelpTooltip>
          </div>
          {[
            { name: "AI and integrations", types: ["agent", "tool"] },
            {
              name: "Flow control",
              types: ["condition", "router", "parallel", "merge", "approval"],
            },
            { name: "Input and output", types: ["input", "output"] },
          ].map((group) => (
            <div key={group.name}>
              <small>{group.name}</small>
              <div className="canvas-palette-grid">
                {workflowKinds
                  .filter((k) => group.types.includes(k))
                  .map((k) => (
                    <button
                      type="button"
                      className="secondary"
                      key={k}
                      disabled={disabled || !canAdd}
                      draggable={!disabled}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(
                          "application/x-agentconnex-node",
                          k,
                        );
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      onClick={() => {
                        onAdd(k);
                        setOpen(false);
                        root.current
                          ?.querySelector<HTMLButtonElement>("button")
                          ?.focus();
                      }}
                      aria-label={`Add ${k}`}
                    >
                      {k}
                    </button>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
