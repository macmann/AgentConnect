"use client";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Bot,
  Wrench,
  GitBranch,
  UserCheck,
  LogIn,
  LogOut,
  Merge,
  Split,
  Shuffle,
} from "lucide-react";
export type CanvasNode = Node<
  { label: string; kind: string; status?: string },
  "workflow"
>;
function CanvasItem({ data, selected, isConnectable }: NodeProps<CanvasNode>) {
  const icons: Record<string, typeof Bot> = {
    input: LogIn,
    output: LogOut,
    agent: Bot,
    tool: Wrench,
    condition: GitBranch,
    router: Shuffle,
    approval: UserCheck,
    merge: Merge,
    parallel: Split,
  };
  const Icon = icons[data.kind] ?? Bot;
  return (
    <div
      className={`workflow-node kind-${data.kind} ${selected ? "selected" : ""} status-${data.status ?? "idle"}`}
    >
      {data.kind !== "input" && (
        <Handle
          isConnectable={isConnectable}
          type="target"
          position={Position.Left}
        />
      )}
      {data.kind !== "input" &&
        [
          { id: "in-top", position: Position.Top, style: { left: "35%" } },
          {
            id: "in-bottom",
            position: Position.Bottom,
            style: { left: "35%" },
          },
          { id: "in-right", position: Position.Right, style: { top: "35%" } },
        ].map((port) => (
          <Handle
            key={port.id}
            id={port.id}
            type="target"
            position={port.position}
            style={port.style}
            isConnectable={isConnectable}
            aria-label={`Connect into ${data.label} at ${port.id.slice(3)}`}
          />
        ))}
      {!["output", "router", "condition"].includes(data.kind) &&
        [
          { id: "out-top", position: Position.Top, style: { left: "65%" } },
          {
            id: "out-bottom",
            position: Position.Bottom,
            style: { left: "65%" },
          },
          { id: "out-left", position: Position.Left, style: { top: "75%" } },
        ].map((port) => (
          <Handle
            key={port.id}
            id={port.id}
            type="source"
            position={port.position}
            style={port.style}
            isConnectable={isConnectable}
            aria-label={`Connect from ${data.label} at ${port.id.slice(4)}`}
          />
        ))}
      <Icon className="workflow-node-icon" size={18} aria-hidden="true" />
      <small>{data.kind}</small>
      <strong>{data.label}</strong>
      {data.status && <span>{data.status}</span>}
      {!["output", "router", "condition"].includes(data.kind) && (
        <Handle
          isConnectable={isConnectable}
          type="source"
          position={Position.Right}
        />
      )}
      {["router", "condition"].includes(data.kind) && (
        <>
          <Handle
            isConnectable={isConnectable}
            id="true"
            type="source"
            position={Position.Right}
            style={{ top: "35%" }}
          />
          <span className="branch-label branch-true">true</span>
          <Handle
            isConnectable={isConnectable}
            id="false"
            type="source"
            position={Position.Right}
            style={{ top: "75%" }}
          />
          <span className="branch-label branch-false">false</span>
        </>
      )}
    </div>
  );
}
export const workflowNodeTypes = { workflow: CanvasItem };
