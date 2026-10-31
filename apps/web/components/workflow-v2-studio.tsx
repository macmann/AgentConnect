"use client";
import { WorkflowRunDetail, type RunDetail } from "./workflow-operations";
import { useEffect, useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  applyNodeChanges,
  type Node,
  type Edge,
  type Connection,
  Handle,
  Position,
  type NodeProps,
  type ReactFlowInstance,
  useUpdateNodeInternals,
} from "@xyflow/react";
import {
  workflowDefinitionV2,
  validateWorkflowDefinition,
  type WorkflowDefinitionV2,
} from "@agentconnect/schemas/workflow-v2";
import {
  WorkflowV2NodePanel,
  type WorkflowCatalog,
} from "./workflow-v2-node-panel";
import {
  FieldPicker,
  StructuredFields,
  type ValueSchema,
} from "./workflow-v2-fields";
import { requestJson, apiBase } from "./agent-client";
import { Button } from "./button";
import { WorkflowResult } from "./workflow-result";
import { WorkflowActionConnections } from "./workflow-action-connections";
import { WorkflowAssistant } from "./workflow-assistant";
import { WorkflowTriggers } from "./workflow-triggers";
type Step = WorkflowDefinitionV2["execution"]["nodes"][number];
type VNode = Node<
  {
    label: string;
    kind: string;
    routes: { id: string; label: string }[];
    invalid: boolean;
    errorCapable: boolean;
  },
  "v2"
>;
type Run = {
  input?: unknown;
  actionExecutions?: {
    id: string;
    node_id: string;
    connector: string;
    operation: string;
    side_effect: string;
    risk_level: string;
    status: string;
    attempts: number;
    duration_ms: number;
    error_code?: string;
    attempt_history: {
      attempt: number;
      status: string;
      error_code?: string;
      duration_ms: number;
    }[];
  }[];
  parent_run_id?: string;
  suspensions?: {
    id: string;
    node_id: string;
    kind: string;
    status: string;
    due_at: string;
    event_name?: string;
    resumed_at?: string;
  }[];
  children?: {
    id: string;
    parent_node_id: string;
    iteration_index: number;
    status: string;
  }[];
  id: string;
  status: string;
  output: unknown;
  error_code?: string;
  graph_snapshot: {
    programV2?: { execution: WorkflowDefinitionV2["execution"] };
  };
  approvals: {
    node_id: string;
    prompt: string;
    input: unknown;
    decision: string;
  }[];
  nodes: {
    node_id: string;
    label: string;
    status: string;
    error_code?: string;
  }[];
};
function StepNode({ id, data, selected, isConnectable }: NodeProps<VNode>) {
  const updateInternals = useUpdateNodeInternals();
  const handles = data.routes.map((r) => r.id).join("|");
  useEffect(() => {
    updateInternals(id);
  }, [id, handles, updateInternals]);
  return (
    <div
      className={`workflow-node ${selected ? "selected" : ""}`}
      style={{
        borderColor: data.invalid ? "#d97706" : undefined,
        minHeight: 80 + data.routes.length * 18,
      }}
    >
      <small>{data.kind}</small>
      <strong>{data.label}</strong>
      {data.invalid && <span>Needs configuration</span>}
      {data.kind !== "input" &&
        [Position.Left, Position.Top, Position.Bottom, Position.Right].map(
          (position, i) => (
            <Handle
              key={position}
              id={["in-left", "in-top", "in-bottom", "in-right"][i]}
              type="target"
              position={position}
              isConnectable={isConnectable}
              style={position === Position.Right ? { top: "25%" } : undefined}
            />
          ),
        )}
      {data.errorCapable && (
        <Handle
          id="error"
          type="source"
          position={Position.Bottom}
          isConnectable={isConnectable}
          style={{ left: "85%", background: "var(--danger)" }}
          aria-label={`Error route from ${data.label}`}
        />
      )}
      {data.kind !== "output" &&
        (data.routes.length
          ? data.routes.map((route, i) => (
              <div key={route.id}>
                <span style={{ fontSize: 10 }}>{route.label}</span>
                <Handle
                  id={route.id}
                  type="source"
                  position={Position.Right}
                  style={{ top: `${45 + (i / data.routes.length) * 45}%` }}
                  isConnectable={isConnectable}
                />
              </div>
            ))
          : [Position.Right, Position.Top, Position.Bottom, Position.Left].map(
              (position, i) => (
                <Handle
                  key={position}
                  id={["out-right", "out-top", "out-bottom", "out-left"][i]}
                  type="source"
                  position={position}
                  isConnectable={isConnectable}
                  style={
                    position === Position.Left ? { top: "75%" } : undefined
                  }
                />
              ),
            ))}
    </div>
  );
}
const errorCapable = (kind: string) =>
  ![
    "input",
    "output",
    "parallel",
    "merge",
    "condition",
    "switch",
    "approval",
    "human-task",
  ].includes(kind);
const nodeTypes = { v2: StepNode };
function connectionPorts(
  connection: Connection,
): NonNullable<WorkflowDefinitionV2["editor"]>["edges"][string] {
  return {
    ...(["out-top", "out-bottom", "out-left"].includes(
      connection.sourceHandle ?? "",
    )
      ? {
          sourcePort: connection.sourceHandle as
            "out-top" | "out-bottom" | "out-left",
        }
      : {}),
    ...(["in-top", "in-bottom", "in-right"].includes(
      connection.targetHandle ?? "",
    )
      ? {
          targetPort: connection.targetHandle as
            "in-top" | "in-bottom" | "in-right",
        }
      : {}),
  };
}

function errorAffectsNode(node: Step, error: string) {
  return (
    error.startsWith(node.id + ":") ||
    error.startsWith(node.label + ":") ||
    ("resource" in node.config &&
      error.startsWith(node.config.resource + ":")) ||
    ("actionId" in node.config && error.startsWith(node.config.actionId + ":"))
  );
}
const initial = (): WorkflowDefinitionV2 =>
  workflowDefinitionV2.parse({
    schemaVersion: 2,
    execution: {
      nodes: [
        { id: "input", label: "Input", kind: "input", config: {} },
        { id: "output", label: "Output", kind: "output", config: {} },
      ],
      edges: [{ id: "input_output", source: "input", target: "output" }],
    },
    editor: { nodes: { input: { x: 50, y: 120 }, output: { x: 450, y: 120 } } },
  });
const kinds = [
  "agent",
  "structured-ai",
  "action",
  "human-task",
  "transform",
  "set-variable",
  "condition",
  "switch",
  "parallel",
  "merge",
  "input",
  "output",
  "for-each",
  "wait",
  "wait-for-event",
  "subworkflow",
] as const;
const outputSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};
export function WorkflowV2Studio({
  workspaceId,
  workflowId,
  role,
  onBack,
  startWithAI = false,
}: {
  workspaceId: string;
  workflowId: string;
  role: string;
  onBack: () => void;
  startWithAI?: boolean;
}) {
  const flow = useRef<ReactFlowInstance<VNode> | null>(null);
  const editable = [
    "owner",
    "org_admin",
    "workspace_admin",
    "builder",
  ].includes(role);
  const canExecute = [
    "owner",
    "org_admin",
    "workspace_admin",
    "builder",
    "operator",
  ].includes(role);
  const approver = [
    "owner",
    "org_admin",
    "workspace_admin",
    "operator",
  ].includes(role);
  const [definition, setDefinition] = useState(initial),
    [id, setId] = useState(workflowId),
    [name, setName] = useState("New workflow"),
    [revision, setRevision] = useState(1),
    [description, setDescription] = useState("");
  const [assistantOpen, setAssistantOpen] = useState(startWithAI);
  const [assistantPreview, setAssistantPreview] =
    useState<WorkflowDefinitionV2 | null>(null);
  const canvasEditable = editable && !assistantPreview;
  const [selectedEdges, setSelectedEdges] = useState<string[]>([]);
  const [selected, setSelected] = useState("input"),
    [minimized, setMinimized] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [ready, setReady] = useState(!workflowId),
    [serverErrors, setServerErrors] = useState<string[]>([]);
  const [kind, setKind] = useState<(typeof kinds)[number]>("agent"),
    [variableName, setVariableName] = useState(""),
    [testOpen, setTestOpen] = useState(false),
    [input, setInput] = useState<unknown>(""),
    [runId, setRunId] = useState(""),
    [edited, setEdited] = useState<unknown>(),
    [versionId, setVersionId] = useState("");
  const catalog = useQuery({
    queryKey: ["workflow-catalog", workspaceId],
    queryFn: () =>
      requestJson<WorkflowCatalog>(
        `/workspaces/${workspaceId}/workflow-catalog`,
      ),
  });
  const versions = useQuery({
    queryKey: ["v2-versions", id, revision],
    enabled: !!id,
    queryFn: () =>
      requestJson<
        {
          id: string;
          version: number;
          definitionVersion?: 2;
          graph: import("@agentconnect/schemas/workflows").WorkflowGraph;
        }[]
      >(`/workflows/${id}/versions`),
  });
  const runs = useQuery({
    queryKey: ["v2-runs", id],
    enabled: !!id,
    queryFn: () =>
      requestJson<{ id: string; status: string }[]>(`/workflows/${id}/runs`),
    refetchInterval: runId ? 2500 : false,
  });
  const run = useQuery({
    queryKey: ["v2-run", runId],
    enabled: !!runId,
    queryFn: () => requestJson<Run>(`/workflow-runs/${runId}`),
    refetchInterval: (q) =>
      q.state.data &&
      ["completed", "failed", "rejected", "cancelled"].includes(
        q.state.data.status,
      )
        ? false
        : 1500,
  });
  useEffect(() => {
    if (!workflowId) return;
    let active = true;
    requestJson<{
      name: string;
      description: string;
      revision: number;
      definition: WorkflowDefinitionV2;
    }>(`/workflows/${workflowId}`)
      .then((w) => {
        if (active) {
          setDefinition(workflowDefinitionV2.parse(w.definition));
          setName(w.name);
          setDescription(w.description);
          setRevision(w.revision);
          setReady(true);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [workflowId]);
  const [pendingNode, setPendingNode] = useState("");
  const [eventCredentials, setEventCredentials] = useState<{
    token: string;
    callbackPath: string;
    expiresAt: string;
    eventName: string;
  } | null>(null);
  useEffect(() => {
    setEventCredentials(null);
    setPendingNode("");
  }, [runId]);
  const pendingApprovals =
    run.data?.approvals.filter((a) => a.decision === "pending") ?? [];
  const pending =
    pendingApprovals.find((a) => a.node_id === pendingNode) ??
    pendingApprovals[0];
  const taskNode = pending
    ? run.data?.graph_snapshot.programV2?.execution.nodes.find(
        (n) => n.id === pending.node_id,
      )
    : undefined;
  const taskInputKey = pending ? runId + pending.node_id : "";
  useEffect(() => {
    setEdited(undefined);
  }, [taskInputKey]);
  function change(next: WorkflowDefinitionV2) {
    setDefinition(next);
    setDirty(true);
    setServerErrors([]);
  }
  const errors = [
    ...validateWorkflowDefinition(definition).map((error) => {
      const index = /^execution\.nodes\.(\d+)/.exec(error)?.[1];
      return index
        ? `${definition.execution.nodes[Number(index)]?.id}: ${error}`
        : error;
    }),
    ...definition.execution.nodes.flatMap((n) => {
      if (!catalog.data) return [];
      if (n.kind === "agent") {
        const r = definition.execution.resources[n.config.resource];
        if (
          r?.kind === "agent" &&
          !catalog.data.agents.some(
            (a) => a.agent_id === r.agentId && a.id === r.versionId,
          )
        )
          return [`${n.id}: published Agent version is unavailable`];
      }
      if (n.kind === "structured-ai") {
        const r = definition.execution.resources[n.config.resource];
        if (
          r?.kind === "model" &&
          !catalog.data.models.some((m) => m.id === r.id)
        )
          return [`${n.id}: model is unavailable`];
      }
      if (n.kind === "action") {
        const action = definition.execution.actions.find(
          (a) => a.id === n.config.actionId,
        );
        if (
          action?.connector === "agentconnect.http" &&
          action.connectionId &&
          !catalog.data.connections?.http.some(
            (c) =>
              c.id === action.connectionId &&
              c.enabled &&
              c.methods.includes(action.http!.method),
          )
        )
          return [`${n.id}: compatible HTTP connection is unavailable`];
        if (
          action?.connector === "agentconnect.mcp-operation" &&
          !catalog.data.connections?.mcp.some(
            (c) =>
              c.id === action.connectionId &&
              c.enabled &&
              c.operations.some(
                (o) => o.name === action.operation && o.allowed,
              ),
          )
        )
          return [
            `${n.id}: MCP operation is unavailable or requires permission`,
          ];
        const a = definition.execution.actions.find(
          (a) => a.id === n.config.actionId,
        );
        if (
          a &&
          ["agentconnect.tool", "agentconnect.mcp"].includes(a.connector) &&
          !catalog.data.actions.some((t) => t.id === a.toolId && !t.unavailable)
        )
          return [
            `${n.id}: registered Action or saved connection is unavailable`,
          ];
      }
      return [];
    }),
    ...serverErrors,
  ];
  const node = definition.execution.nodes.find((n) => n.id === selected);
  const routes = (n: Step) =>
    n.kind === "condition"
      ? [
          { id: "true", label: "True" },
          { id: "false", label: "False" },
        ]
      : n.kind === "switch"
        ? [
            ...n.config.cases.map((c) => ({ id: c.id, label: c.label })),
            { id: "default", label: "Default" },
          ]
        : [];
  const canvasDefinition = assistantPreview ?? definition;
  const nodes: VNode[] = canvasDefinition.execution.nodes.map((n, i) => ({
    id: n.id,
    type: "v2",
    position: canvasDefinition.editor?.nodes[n.id] ?? { x: i * 250, y: 150 },
    selected: selected === n.id,
    data: {
      label: n.label,
      kind: n.kind,
      routes: routes(n),
      errorCapable: errorCapable(n.kind),
      invalid: errors.some((e) => errorAffectsNode(n, e)),
    },
  }));
  const controlEdges = [
    ...canvasDefinition.execution.edges,
    ...canvasDefinition.execution.nodes
      .filter((n) => n.onError)
      .map((n) => ({
        id: "error_" + n.id,
        source: n.id,
        target: n.onError!,
        branch: "error",
      })),
  ];
  const edges: Edge[] = controlEdges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle:
      e.branch ??
      canvasDefinition.editor?.edges[e.id]?.sourcePort ??
      "out-right",
    targetHandle: canvasDefinition.editor?.edges[e.id]?.targetPort ?? "in-left",
    selected: selectedEdges.includes(e.id),
    label: e.branch,
  }));
  async function task(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    const parsed = workflowDefinitionV2.parse(definition);
    const saved = await requestJson<{
      id: string;
      revision: number;
      validation: string[];
    }>(
      id ? `/workflows/${id}` : `/workspaces/${workspaceId}/workflows`,
      id ? "PUT" : "POST",
      { name, description, graph: parsed, ...(id ? { revision } : {}) },
    );
    setId(saved.id);
    setRevision(saved.revision);
    setDirty(false);
    setServerErrors(saved.validation);
    setNotice("Draft saved");
    return saved;
  }
  function add() {
    const nodeId =
      kind.replaceAll("-", "_") + "_" + crypto.randomUUID().slice(0, 8);
    const config =
      kind === "for-each"
        ? {
            resource: "body_" + nodeId,
            collection: { type: "reference", path: "input.files" },
          }
        : kind === "subworkflow"
          ? { resource: "body_" + nodeId }
          : kind === "wait"
            ? { mode: "duration", seconds: 60 }
            : kind === "wait-for-event"
              ? { eventName: "completed" }
              : kind === "agent"
                ? { resource: "agent_" + nodeId }
                : kind === "structured-ai"
                  ? {
                      resource: "model_" + nodeId,
                      instruction: "Extract the requested fields.",
                      outputSchema,
                    }
                  : kind === "action"
                    ? { actionId: "action_" + nodeId }
                    : kind === "human-task"
                      ? {
                          mode: "review-edit",
                          prompt: "Review the result before continuing.",
                          outputSchema,
                        }
                      : kind === "transform"
                        ? { fields: {} }
                        : kind === "set-variable"
                          ? {
                              name:
                                Object.keys(
                                  definition.execution.variables,
                                )[0] ?? "value",
                              value: { type: "literal", value: "" },
                            }
                          : kind === "condition"
                            ? {
                                condition: {
                                  operator: "equals",
                                  left: { type: "reference", path: "input" },
                                  right: { type: "literal", value: "" },
                                },
                              }
                            : kind === "switch"
                              ? {
                                  value: { type: "reference", path: "input" },
                                  cases: [
                                    {
                                      id: "case_one",
                                      label: "First route",
                                      value: "high",
                                    },
                                  ],
                                }
                              : {};
    const step = workflowDefinitionV2.shape.execution.shape.nodes.element.parse(
      { id: nodeId, label: kind.replaceAll("-", " "), kind, config },
    );
    change({
      ...definition,
      execution: {
        ...definition.execution,
        nodes: [...definition.execution.nodes, step],
      },
      editor: {
        ...definition.editor,
        edges: definition.editor?.edges ?? {},
        nodes: {
          ...definition.editor?.nodes,
          [nodeId]: {
            x: 250 + Math.random() * 100,
            y: 280 + Math.random() * 80,
          },
        },
      },
    });
    setSelected(nodeId);
    setMinimized(false);
  }
  function connect(connection: Connection, replacing?: string) {
    if (!editable || !connection.source || !connection.target) return;
    let nodes = definition.execution.nodes.map((n) =>
      replacing === "error_" + n.id ? { ...n, onError: undefined } : n,
    );
    const source = nodes.find((n) => n.id === connection.source);
    const isError = connection.sourceHandle === "error";
    if (isError && !errorCapable(source?.kind ?? "input")) return;
    const edgeId = isError
      ? "error_" + connection.source
      : (replacing ?? "edge_" + crypto.randomUUID().slice(0, 8));
    const edges = definition.execution.edges.filter((e) => e.id !== replacing);
    if (isError)
      nodes = nodes.map((n) =>
        n.id === connection.source ? { ...n, onError: connection.target! } : n,
      );
    else
      edges.push({
        id: edgeId,
        source: connection.source,
        target: connection.target,
        ...((source?.kind === "condition" || source?.kind === "switch") &&
        connection.sourceHandle
          ? { branch: connection.sourceHandle }
          : {}),
      });
    change({
      ...definition,
      execution: { ...definition.execution, nodes, edges },
      editor: {
        nodes: definition.editor?.nodes ?? {},
        edges: {
          ...Object.fromEntries(
            Object.entries(definition.editor?.edges ?? {}).filter(
              ([key]) => key !== replacing,
            ),
          ),
          [edgeId]: connectionPorts(connection),
        },
      },
    });
  }
  function remove(ids: string[], edgeIds: string[] = []) {
    const nodes = definition.execution.nodes
      .filter((n) => !ids.includes(n.id))
      .map((n) =>
        n.onError &&
        (ids.includes(n.onError) || edgeIds.includes("error_" + n.id))
          ? { ...n, onError: undefined }
          : n,
      );
    const edges = definition.execution.edges.filter(
      (e) =>
        !ids.includes(e.source) &&
        !ids.includes(e.target) &&
        !edgeIds.includes(e.id),
    );
    const removedResources = definition.execution.nodes
      .filter((n) => ids.includes(n.id))
      .flatMap((n) => ("resource" in n.config ? [n.config.resource] : []));
    const retainedResources = nodes.flatMap((n) =>
      "resource" in n.config ? [n.config.resource] : [],
    );
    const removedActions = definition.execution.nodes
      .filter((n) => ids.includes(n.id))
      .flatMap((n) => (n.kind === "action" ? [n.config.actionId] : []));
    change({
      ...definition,
      execution: {
        ...definition.execution,
        nodes,
        edges,
        resources: Object.fromEntries(
          Object.entries(definition.execution.resources).filter(
            ([key]) =>
              !removedResources.includes(key) ||
              retainedResources.includes(key),
          ),
        ),
        actions: definition.execution.actions.filter(
          (a) =>
            !removedActions.includes(a.id) ||
            nodes.some(
              (n) => n.kind === "action" && n.config.actionId === a.id,
            ),
        ),
      },
      editor: definition.editor
        ? {
            ...definition.editor,
            nodes: Object.fromEntries(
              Object.entries(definition.editor.nodes).filter(
                ([key]) => !ids.includes(key),
              ),
            ),
            edges: Object.fromEntries(
              Object.entries(definition.editor.edges).filter(
                ([key]) =>
                  edges.some((e) => e.id === key) ||
                  nodes.some((n) => n.onError && key === "error_" + n.id),
              ),
            ),
          }
        : undefined,
    });
  }
  const testFields =
    (versionId
      ? versions.data?.find((v) => v.id === versionId)?.graph.inputFields
      : undefined) ?? definition.execution.inputFields;
  const resultNode = run.data?.graph_snapshot.programV2?.execution.nodes.find(
    (n) => n.kind === "output",
  );
  const fieldSchema: ValueSchema = {
    type: "object",
    properties: Object.fromEntries(
      testFields.map((f) => [
        f.name,
        {
          type:
            f.type === "text"
              ? "string"
              : f.type === "json"
                ? undefined
                : f.type,
        },
      ]),
    ),
    required: testFields.filter((f) => f.required).map((f) => f.name),
  };
  return (
    <section className="panel workflow-studio v2-studio">
      <div className="panel-header">
        <h2>{name} · Workflow V2</h2>
        <Button
          onClick={() => {
            if (!dirty || window.confirm("Discard unsaved workflow changes?"))
              onBack();
          }}
        >
          Back to workflows
        </Button>
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {catalog.error && (
        <p role="alert">
          Resource list unavailable: {catalog.error.message}{" "}
          <Button onClick={() => void catalog.refetch()}>Retry</Button>
        </p>
      )}
      {!ready ? (
        <p>Loading workflow…</p>
      ) : (
        <>
          <div className="workflow-editor">
            <div
              className="workflow-canvas"
              style={{ height: "min(78vh, 900px)", minHeight: 600 }}
            >
              <ReactFlow<VNode>
                onInit={(instance) => {
                  flow.current = instance;
                }}
                nodeTypes={nodeTypes}
                nodes={nodes}
                edges={edges}
                fitView
                fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
                nodesDraggable={!!canvasEditable}
                nodesConnectable={!!canvasEditable}
                deleteKeyCode={canvasEditable ? ["Backspace", "Delete"] : null}
                onNodeClick={(_, n) => {
                  setSelected(n.id);
                  setSelectedEdges([]);
                  setMinimized(false);
                  setTestOpen(false);
                }}
                onEdgeClick={(_, edge) => {
                  setSelectedEdges([edge.id]);
                  setSelected("");
                }}
                onNodesChange={(changes) => {
                  if (!canvasEditable) return;
                  const removed = changes
                    .filter((c) => c.type === "remove")
                    .map((c) => c.id);
                  if (removed.length) return remove(removed);
                  if (!changes.some((c) => c.type === "position")) return;
                  const updated = applyNodeChanges(changes, nodes);
                  change({
                    ...definition,
                    editor: {
                      ...definition.editor,
                      edges: definition.editor?.edges ?? {},
                      nodes: Object.fromEntries(
                        updated.map((n) => [n.id, n.position]),
                      ),
                    },
                  });
                }}
                onEdgesChange={(changes) => {
                  if (canvasEditable) {
                    const removed = changes
                      .filter((c) => c.type === "remove")
                      .map((c) => c.id);
                    if (removed.length) remove([], removed);
                  }
                }}
                onConnect={(connection) => {
                  if (canvasEditable) connect(connection);
                }}
                onReconnect={(old, connection) => {
                  if (canvasEditable) connect(connection, old.id);
                }}
                edgesReconnectable={!!canvasEditable}
              >
                <Background />
                <Controls />
                <Panel position="top-left">
                  <div
                    className="v2-topbar"
                    role="toolbar"
                    aria-label="Canvas controls"
                  >
                    <select
                      aria-label="Node type"
                      value={kind}
                      disabled={!canvasEditable}
                      onChange={(e) => setKind(e.target.value as typeof kind)}
                    >
                      {kinds.map((k) => (
                        <option key={k} value={k}>
                          {k.replaceAll("-", " ")}
                        </option>
                      ))}
                    </select>
                    <Button
                      disabled={
                        !canvasEditable ||
                        definition.execution.nodes.length >= 40
                      }
                      onClick={add}
                    >
                      + Add node
                    </Button>
                    <Button
                      disabled={!canvasEditable || busy}
                      onClick={() =>
                        void task(async () => {
                          await save();
                        })
                      }
                    >
                      Save draft
                    </Button>
                    <Button
                      disabled={!canvasEditable || busy || !!errors.length}
                      onClick={() =>
                        void task(async () => {
                          const saved =
                            dirty || !id ? await save() : { id, revision };
                          const result = await requestJson<{
                            valid: boolean;
                            errors: string[];
                          }>(`/workflows/${saved.id}/validate`, "POST");
                          setServerErrors(result.errors);
                          if (result.valid) {
                            await requestJson(
                              `/workflows/${saved.id}/publish`,
                              "POST",
                              { revision: saved.revision },
                            );
                            void versions.refetch();
                            setNotice("Workflow published");
                          }
                        })
                      }
                    >
                      Publish
                    </Button>
                    <Button
                      onClick={() => {
                        setAssistantOpen(false);
                        setAssistantPreview(null);
                        setTestOpen(!testOpen);
                        setMinimized(false);
                      }}
                    >
                      Test / runs
                    </Button>
                    <Button
                      onClick={() => {
                        setAssistantOpen(false);
                        setAssistantPreview(null);
                        setSelected("");
                        setTestOpen(false);
                        setMinimized(false);
                      }}
                    >
                      Workflow settings
                    </Button>
                    <Button
                      disabled={
                        !canvasEditable || (!selectedEdges.length && !selected)
                      }
                      onClick={() => {
                        remove(selected ? [selected] : [], selectedEdges);
                        setSelectedEdges([]);
                        setSelected("");
                      }}
                    >
                      Delete selected
                    </Button>
                    <Button
                      onClick={() => {
                        setAssistantOpen(!assistantOpen);
                        setAssistantPreview(null);
                        setTestOpen(false);
                        setMinimized(false);
                      }}
                    >
                      AI assistant
                    </Button>
                    <Button
                      onClick={() => {
                        setSelected("");
                        setTestOpen(false);
                        setAssistantOpen(false);
                        setAssistantPreview(null);
                        setMinimized(false);
                      }}
                    >
                      Validation · {errors.length} issues
                    </Button>
                    <span>
                      {assistantPreview
                        ? "AI preview · not applied"
                        : dirty
                          ? "Unsaved"
                          : "Saved"}
                    </span>
                  </div>
                </Panel>
              </ReactFlow>
              <Button
                className="v2-minimize"
                aria-expanded={!minimized}
                onClick={() => setMinimized(!minimized)}
              >
                {minimized ? "‹ Restore panel" : "› Minimize panel"}
              </Button>
              {(!minimized || assistantOpen) && (
                <aside
                  hidden={minimized}
                  className="v2-properties"
                  aria-label={
                    assistantOpen
                      ? "Workflow AI assistant"
                      : testOpen
                        ? "Workflow testing"
                        : "Node properties"
                  }
                >
                  {assistantOpen ? (
                    <WorkflowAssistant
                      initialMode={startWithAI && !id ? "create" : "modify"}
                      workspaceId={workspaceId}
                      workflowId={id}
                      definition={definition}
                      selectedNodeId={selected}
                      editable={editable}
                      onPreview={setAssistantPreview}
                      onApply={(next) => {
                        change(next);
                        setNotice(
                          "AI proposal applied. Save draft when ready.",
                        );
                      }}
                    />
                  ) : testOpen ? (
                    <>
                      <h3>Test workflow</h3>
                      <label>
                        Run version
                        <select
                          value={versionId}
                          onChange={(e) => setVersionId(e.target.value)}
                        >
                          <option value="">Saved draft</option>
                          {versions.data?.map((v) => (
                            <option key={v.id} value={v.id}>
                              Published version {v.version}
                            </option>
                          ))}
                        </select>
                      </label>
                      {testFields.some((f) => f.name === "documents") && (
                        <label>
                          Upload documents (text / native PDF)
                          <input
                            type="file"
                            multiple
                            accept=".pdf,.txt,.md"
                            onChange={(e) => {
                              const files = Array.from(e.target.files ?? []);
                              void task(async () => {
                                if (
                                  files.length > 25 ||
                                  files.reduce((n, f) => n + f.size, 0) >
                                    5000000
                                )
                                  throw new Error(
                                    "Upload at most 25 files and 5 MB",
                                  );
                                const encoded = await Promise.all(
                                  files.map(async (file) => {
                                    const bytes = new Uint8Array(
                                      await file.arrayBuffer(),
                                    );
                                    let binary = "";
                                    for (
                                      let offset = 0;
                                      offset < bytes.length;
                                      offset += 8192
                                    )
                                      binary += String.fromCharCode(
                                        ...bytes.subarray(
                                          offset,
                                          offset + 8192,
                                        ),
                                      );
                                    return {
                                      name: file.name,
                                      data: btoa(binary),
                                    };
                                  }),
                                );
                                const parsed = await requestJson<{
                                  documents: unknown[];
                                }>(
                                  `/workspaces/${workspaceId}/workflow-documents/parse`,
                                  "POST",
                                  { files: encoded },
                                );
                                setInput(parsed);
                                setNotice(
                                  `${parsed.documents.length} documents ready. Review the input, then Run workflow.`,
                                );
                              });
                            }}
                          />
                        </label>
                      )}
                      {testFields.length ? (
                        <StructuredFields
                          schema={fieldSchema}
                          value={input}
                          label="Workflow input"
                          onChange={setInput}
                        />
                      ) : (
                        <label>
                          Workflow input
                          <textarea
                            value={typeof input === "string" ? input : ""}
                            onChange={(e) => setInput(e.target.value)}
                          />
                        </label>
                      )}
                      <Button
                        disabled={
                          !canExecute || busy || !id || (!versionId && dirty)
                        }
                        onClick={() =>
                          void task(async () => {
                            const created = await requestJson<{ id: string }>(
                              `/workflows/${id}/runs`,
                              "POST",
                              {
                                input,
                                ...(versionId ? { versionId } : { revision }),
                              },
                            );
                            setRunId(created.id);
                            void runs.refetch();
                          })
                        }
                      >
                        Run workflow
                      </Button>
                      {!versionId && dirty && (
                        <p>Save your draft before testing.</p>
                      )}
                      <label>
                        Run history
                        <select
                          value={runId}
                          onChange={(e) => setRunId(e.target.value)}
                        >
                          <option value="">Select run</option>
                          {runs.data?.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.id.slice(0, 8)} · {r.status}
                            </option>
                          ))}
                        </select>
                      </label>
                      {run.data && (
                        <>
                          <h4>{run.data.status}</h4>
                          {run.data.parent_run_id && (
                            <Button
                              onClick={() => setRunId(run.data!.parent_run_id!)}
                            >
                              Back to parent run
                            </Button>
                          )}
                          {run.data.children?.length ? (
                            <details open>
                              <summary>Child runs / iterations</summary>
                              {run.data.children.map((child) => (
                                <p key={child.id}>
                                  <Button onClick={() => setRunId(child.id)}>
                                    {child.parent_node_id} · item{" "}
                                    {child.iteration_index + 1} · {child.status}
                                  </Button>
                                </p>
                              ))}
                            </details>
                          ) : null}
                          {run.data.suspensions
                            ?.filter((s) => s.status === "pending")
                            .map((s) => (
                              <fieldset key={s.id}>
                                <legend>
                                  {s.node_id} ·{" "}
                                  {s.kind === "children"
                                    ? "Waiting for child results"
                                    : s.kind === "event"
                                      ? "Waiting for event"
                                      : "Durable wait"}
                                </legend>
                                {s.due_at && (
                                  <p>
                                    {s.kind === "event" ? "Expires" : "Resumes"}
                                    : {new Date(s.due_at).toLocaleString()}
                                  </p>
                                )}
                                {s.kind === "event" && canExecute && (
                                  <Button
                                    disabled={
                                      busy || run.data!.status !== "waiting"
                                    }
                                    onClick={() =>
                                      void task(async () => {
                                        const issued = await requestJson<{
                                          token: string;
                                          callbackPath: string;
                                          expiresAt: string;
                                          eventName: string;
                                        }>(
                                          `/workflow-runs/${runId}/event-token`,
                                          "POST",
                                          { nodeId: s.node_id },
                                        );
                                        setEventCredentials(issued);
                                        setNotice(
                                          "Scoped callback token issued. Issuing another token invalidates the previous one.",
                                        );
                                      })
                                    }
                                  >
                                    Issue / rotate callback token
                                  </Button>
                                )}
                              </fieldset>
                            ))}
                          {eventCredentials && (
                            <fieldset>
                              <legend>External callback</legend>
                              <p>
                                POST {apiBase}
                                {eventCredentials.callbackPath}
                              </p>
                              <p>Event name: {eventCredentials.eventName}</p>
                              <label>
                                Bearer token
                                <input
                                  type="password"
                                  readOnly
                                  value={eventCredentials.token}
                                />
                              </label>
                              <Button
                                onClick={() =>
                                  void task(async () => {
                                    await navigator.clipboard.writeText(
                                      eventCredentials.token,
                                    );
                                    setNotice("Callback token copied");
                                  })
                                }
                              >
                                Copy callback token
                              </Button>
                              <p>
                                Keep the token private. It authorizes this event
                                once and expires at{" "}
                                {new Date(
                                  eventCredentials.expiresAt,
                                ).toLocaleString()}
                                .
                              </p>
                            </fieldset>
                          )}
                          {pendingApprovals.length > 1 && (
                            <label>
                              Pending human task
                              <select
                                value={pending?.node_id ?? ""}
                                onChange={(event) =>
                                  setPendingNode(event.target.value)
                                }
                              >
                                {pendingApprovals.map((a) => (
                                  <option key={a.node_id} value={a.node_id}>
                                    {a.prompt}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}

                          {!!run.data.actionExecutions?.length && (
                            <details>
                              <summary>Action executions</summary>
                              {run.data.actionExecutions.map((a) => (
                                <div key={a.id}>
                                  <strong>
                                    {a.node_id} · {a.operation}
                                  </strong>
                                  <p>
                                    {a.connector} · {a.side_effect} ·{" "}
                                    {a.risk_level} risk · {a.status} ·{" "}
                                    {a.attempts} attempts · {a.duration_ms} ms
                                  </p>
                                  {a.error_code && <p>{a.error_code}</p>}
                                  {a.attempt_history.map((attempt) => (
                                    <small key={attempt.attempt}>
                                      Attempt {attempt.attempt}:{" "}
                                      {attempt.status} {attempt.error_code} ·{" "}
                                      {attempt.duration_ms} ms
                                      <br />
                                    </small>
                                  ))}
                                </div>
                              ))}
                            </details>
                          )}
                          <details>
                            <summary>Execution overview and step data</summary>
                            <WorkflowRunDetail
                              run={run.data as unknown as RunDetail}
                              onChild={setRunId}
                            />
                          </details>
                          {run.data.error_code && (
                            <p role="alert">{run.data.error_code}</p>
                          )}
                          {run.data.nodes.map((n) => (
                            <p key={n.node_id}>
                              {n.label}: {n.status} {n.error_code}
                            </p>
                          ))}
                          {pending && run.data.status === "waiting" && (
                            <fieldset>
                              <legend>{pending.prompt}</legend>
                              {taskNode?.kind === "human-task" &&
                              taskNode.config.mode === "review-edit" ? (
                                <fieldset disabled={!approver || busy}>
                                  <StructuredFields
                                    schema={
                                      taskNode.config
                                        .outputSchema as ValueSchema
                                    }
                                    value={
                                      edited === undefined
                                        ? pending.input
                                        : edited
                                    }
                                    onChange={setEdited}
                                    label="Review data"
                                  />
                                </fieldset>
                              ) : (
                                <pre>
                                  {JSON.stringify(pending.input, null, 2)}
                                </pre>
                              )}
                              {approver && (
                                <div className="v2-inline">
                                  {(["approved", "rejected"] as const).map(
                                    (decision) => (
                                      <Button
                                        key={decision}
                                        disabled={busy}
                                        onClick={() =>
                                          void task(async () => {
                                            await requestJson(
                                              `/workflow-runs/${runId}/approval`,
                                              "POST",
                                              {
                                                nodeId: pending.node_id,
                                                decision,
                                                ...(edited === undefined
                                                  ? {}
                                                  : { editedInput: edited }),
                                              },
                                            );
                                            setEdited(undefined);
                                            await run.refetch();
                                          })
                                        }
                                      >
                                        {taskNode?.kind === "human-task"
                                          ? decision === "approved"
                                            ? taskNode.config.approveLabel
                                            : taskNode.config.rejectLabel
                                          : decision === "approved"
                                            ? "Approve"
                                            : "Reject"}
                                      </Button>
                                    ),
                                  )}
                                </div>
                              )}
                            </fieldset>
                          )}
                          {run.data.output !== null &&
                            run.data.output !== undefined && (
                              <WorkflowResult
                                output={run.data.output}
                                title={
                                  resultNode?.kind === "output"
                                    ? resultNode.config.title || undefined
                                    : undefined
                                }
                                summary={
                                  resultNode?.kind === "output"
                                    ? resultNode.config.summary
                                    : undefined
                                }
                                format={
                                  resultNode?.kind === "output"
                                    ? resultNode.config.format
                                    : undefined
                                }
                              />
                            )}
                          {["queued", "running", "waiting"].includes(
                            run.data.status,
                          ) && (
                            <Button
                              onClick={() =>
                                void task(async () => {
                                  await requestJson(
                                    `/workflow-runs/${runId}/cancel`,
                                    "POST",
                                  );
                                  await run.refetch();
                                })
                              }
                            >
                              Cancel run
                            </Button>
                          )}
                        </>
                      )}
                    </>
                  ) : node ? (
                    <>
                      <h3>Step properties</h3>
                      <fieldset disabled={!editable || busy}>
                        <WorkflowV2NodePanel
                          key={node.id}
                          workspaceId={workspaceId}
                          canManageConnections={[
                            "owner",
                            "org_admin",
                            "workspace_admin",
                          ].includes(role)}
                          node={node}
                          definition={definition}
                          catalog={catalog.data}
                          onChange={change}
                        />
                        {node.kind === "input" && id && (
                          <WorkflowTriggers
                            workflowId={id}
                            workspaceId={workspaceId}
                            versions={versions.data ?? []}
                            canManage={editable}
                          />
                        )}
                        <Button onClick={() => remove([node.id])}>
                          Delete node
                        </Button>
                      </fieldset>
                    </>
                  ) : (
                    <>
                      <h3>Workflow settings</h3>
                      <fieldset disabled={!editable || busy}>
                        <label>
                          Name
                          <input
                            value={name}
                            onChange={(e) => {
                              setName(e.target.value);
                              setDirty(true);
                            }}
                          />
                        </label>
                        <label>
                          Description
                          <textarea
                            value={description}
                            onChange={(e) => {
                              setDescription(e.target.value);
                              setDirty(true);
                            }}
                          />
                        </label>
                        <WorkflowActionConnections
                          workspaceId={workspaceId}
                          canManage={[
                            "owner",
                            "org_admin",
                            "workspace_admin",
                          ].includes(role)}
                        />
                        <h4>Initial variables</h4>
                        {Object.entries(definition.execution.variables).map(
                          ([key, value]) => (
                            <details key={key}>
                              <summary>{key}</summary>
                              <FieldPicker
                                definition={definition}
                                nodeId="input"
                                value={{ type: "literal", value }}
                                onChange={(expression) => {
                                  if (expression.type === "literal")
                                    change({
                                      ...definition,
                                      execution: {
                                        ...definition.execution,
                                        variables: {
                                          ...definition.execution.variables,
                                          [key]: expression.value,
                                        },
                                      },
                                    });
                                }}
                              />
                              <Button
                                onClick={() =>
                                  change({
                                    ...definition,
                                    execution: {
                                      ...definition.execution,
                                      variables: Object.fromEntries(
                                        Object.entries(
                                          definition.execution.variables,
                                        ).filter(([k]) => k !== key),
                                      ),
                                    },
                                  })
                                }
                              >
                                Remove variable
                              </Button>
                            </details>
                          ),
                        )}
                        <input
                          aria-label="New variable name"
                          placeholder="Variable name"
                          value={variableName}
                          onChange={(e) => setVariableName(e.target.value)}
                        />
                        <Button
                          disabled={
                            !/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(
                              variableName,
                            ) ||
                            ["constructor", "prototype", "__proto__"].includes(
                              variableName,
                            ) ||
                            Object.hasOwn(
                              definition.execution.variables,
                              variableName,
                            )
                          }
                          onClick={() => {
                            change({
                              ...definition,
                              execution: {
                                ...definition.execution,
                                variables: {
                                  ...definition.execution.variables,
                                  [variableName]: "",
                                },
                              },
                            });
                            setVariableName("");
                          }}
                        >
                          + Variable
                        </Button>
                      </fieldset>
                      {id && (
                        <details>
                          <summary>Published versions</summary>
                          {dirty && (
                            <p>
                              Save your draft before restoring a published
                              version.
                            </p>
                          )}
                          {versions.data
                            ?.filter((v) => v.definitionVersion === 2)
                            .map((v) => (
                              <p key={v.id}>
                                Version {v.version}{" "}
                                <Button
                                  disabled={!editable || busy || dirty}
                                  onClick={() =>
                                    void task(async () => {
                                      await requestJson(
                                        `/workflows/${id}/restore/${v.id}`,
                                        "POST",
                                        { revision },
                                      );
                                      const restored = await requestJson<{
                                        name: string;
                                        revision: number;
                                        definition: WorkflowDefinitionV2;
                                      }>(`/workflows/${id}`);
                                      setDefinition(
                                        workflowDefinitionV2.parse(
                                          restored.definition,
                                        ),
                                      );
                                      setName(restored.name);
                                      setRevision(restored.revision);
                                      setServerErrors([]);
                                      setDirty(false);
                                      setSelected("");
                                      setNotice(
                                        "Published version restored into the draft",
                                      );
                                    })
                                  }
                                >
                                  Restore to draft
                                </Button>
                              </p>
                            ))}
                        </details>
                      )}
                      {id && (
                        <WorkflowTriggers
                          workflowId={id}
                          workspaceId={workspaceId}
                          versions={versions.data ?? []}
                          canManage={editable}
                        />
                      )}
                    </>
                  )}
                  {errors.length > 0 && (
                    <div role="alert">
                      <h4>Resolve before publishing</h4>
                      <ul>
                        {[...new Set(errors)].map((e, i) => (
                          <li key={i}>
                            <Button
                              className="secondary"
                              onClick={() => {
                                const matched = definition.execution.nodes.find(
                                  (n) => errorAffectsNode(n, e),
                                );
                                if (matched) {
                                  void flow.current?.fitView({
                                    nodes: [{ id: matched.id }],
                                    duration: 200,
                                    padding: 0.5,
                                    maxZoom: 1,
                                  });
                                  setSelected(matched.id);
                                  setTestOpen(false);
                                  setAssistantOpen(false);
                                  setAssistantPreview(null);
                                  setMinimized(false);
                                  requestAnimationFrame(() =>
                                    document
                                      .querySelector<HTMLElement>(
                                        ".v2-properties input, .v2-properties select",
                                      )
                                      ?.focus(),
                                  );
                                }
                              }}
                            >
                              {e}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </aside>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
