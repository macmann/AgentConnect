"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type NodeProps,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  workflowGraph,
  workflowKinds,
  analyzeWorkflow,
  type WorkflowGraph,
  type WorkflowNode,
} from "@agentconnect/schemas/workflows";
import { Button } from "./button";
import { requestJson } from "./agent-client";
import { ToolTraces, type ToolTrace } from "./tool-studio";
import { Citations, type Citation } from "./citations";
type Draft = {
  id?: string;
  name: string;
  description: string;
  graph: WorkflowGraph;
  revision: number;
};
type Version = {
  id: string;
  version: number;
  name: string;
  graph: WorkflowGraph;
};
type PublishedAgent = { id: string; name: string; version: number };
type NodeTrace = {
  node_id: string;
  label: string;
  kind: string;
  status: string;
  input: unknown;
  output: unknown;
  duration_ms: number | null;
  error_code: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  citations: Citation[];
};
type Run = {
  id: string;
  status: string;
  input: string;
  output: unknown;
  error_code: string | null;
  graph_snapshot: WorkflowGraph;
  nodes: NodeTrace[];
  tools: ToolTrace[];
  approvals: {
    id: string;
    node_id: string;
    prompt: string;
    input: unknown;
    decision: string;
    comment: string;
  }[];
};
type CanvasNode = Node<
  { label: string; kind: string; status?: string },
  "workflow"
>;
function CanvasItem({ data, selected }: NodeProps<CanvasNode>) {
  return (
    <div
      className={`workflow-node ${selected ? "selected" : ""} status-${data.status ?? "idle"}`}
    >
      {data.kind !== "input" && (
        <Handle type="target" position={Position.Left} />
      )}
      <small>{data.kind}</small>
      <strong>{data.label}</strong>
      {data.status && <span>{data.status}</span>}
      {!["output", "router", "condition"].includes(data.kind) && (
        <Handle type="source" position={Position.Right} />
      )}
      {["router", "condition"].includes(data.kind) && (
        <>
          <Handle
            id="true"
            type="source"
            position={Position.Right}
            style={{ top: "35%" }}
          />
          <span className="branch-label branch-true">true</span>
          <Handle
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
const nodeTypes = { workflow: CanvasItem };
const makeNode = (
  id: string,
  type: WorkflowNode["type"],
  x: number,
  y: number,
  data: Partial<WorkflowNode["data"]> = {},
) =>
  workflowGraph.parse({
    nodes: [
      {
        id,
        type,
        position: { x, y },
        data: { label: type.charAt(0).toUpperCase() + type.slice(1), ...data },
      },
    ],
    edges: [],
  }).nodes[0]!;
const edge = (
  source: string,
  target: string,
  sourceHandle?: "true" | "false",
) => ({
  id: "e_" + crypto.randomUUID(),
  source,
  target,
  ...(sourceHandle ? { sourceHandle } : {}),
});
const emptyGraph = (): WorkflowGraph => ({
  schemaVersion: 1,
  nodes: [
    makeNode("input", "input", 40, 150),
    makeNode("output", "output", 460, 150),
  ],
  edges: [edge("input", "output")],
});
const json = (v: unknown) =>
  typeof v === "string" ? v : JSON.stringify(v, null, 2);
function layout(graph: WorkflowGraph) {
  const ranks = new Map<string, number>();
  for (let step = 0; step < graph.nodes.length; step++)
    for (const n of graph.nodes) {
      const parents = graph.edges
        .filter((e) => e.target === n.id)
        .map((e) => ranks.get(e.source));
      if (n.type === "input") ranks.set(n.id, 0);
      else if (
        parents.length &&
        parents.every((v) => v !== undefined) &&
        !ranks.has(n.id)
      )
        ranks.set(n.id, Math.max(...(parents as number[])) + 1);
    }
  const counts = new Map<number, number>();
  return {
    ...graph,
    nodes: graph.nodes.map((n, i) => {
      const rank = ranks.get(n.id) ?? i;
      const row = counts.get(rank) ?? 0;
      counts.set(rank, row + 1);
      return { ...n, position: { x: rank * 250 + 40, y: row * 150 + 80 } };
    }),
  };
}
export function WorkflowStudio({
  workspaceId,
  role,
}: {
  workspaceId: string;
  role: string;
}) {
  const cache = useQueryClient(),
    build = ["owner", "org_admin", "workspace_admin", "builder"].includes(role),
    read = build || ["operator", "analyst"].includes(role),
    approve = ["owner", "org_admin", "workspace_admin", "operator"].includes(
      role,
    );
  const workflows = useQuery({
    queryKey: ["workflows", workspaceId],
    queryFn: () =>
      requestJson<
        { id: string; name: string; description: string; revision: number }[]
      >(`/workspaces/${workspaceId}/workflows`),
    enabled: read,
  });
  const agents = useQuery({
    queryKey: ["workflow-agents", workspaceId],
    queryFn: () =>
      requestJson<PublishedAgent[]>(
        `/workspaces/${workspaceId}/workflow-agents`,
      ),
    enabled: build,
  });
  const tools = useQuery({
    queryKey: ["workflow-tools", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string; enabled: boolean }[]>(
        `/workspaces/${workspaceId}/tools`,
      ),
    enabled: build,
  });
  const [draft, setDraft] = useState<Draft | null>(null),
    [saved, setSaved] = useState(""),
    [selected, setSelected] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [kind, setKind] = useState<WorkflowNode["type"]>("agent"),
    [runInput, setRunInput] = useState(""),
    [versionId, setVersion] = useState(""),
    [selectedRun, setRun] = useState(""),
    [comment, setComment] = useState(""),
    [edited, setEdited] = useState(""),
    [argumentsText, setArguments] = useState("{}");
  const [undo, setUndo] = useState<WorkflowGraph[]>([]),
    [redo, setRedo] = useState<WorkflowGraph[]>([]);
  const clipboard = useRef<WorkflowNode[] | null>(null);
  const canvas = useRef<ReactFlowInstance<CanvasNode, Edge> | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const versions = useQuery({
    queryKey: ["workflow-versions", draft?.id],
    queryFn: () => requestJson<Version[]>(`/workflows/${draft?.id}/versions`),
    enabled: !!draft?.id,
  });
  const runs = useQuery({
    queryKey: ["workflow-runs", draft?.id],
    queryFn: () =>
      requestJson<{ id: string; status: string; created_at: string }[]>(
        `/workflows/${draft?.id}/runs`,
      ),
    enabled: !!draft?.id,
    refetchInterval: (q) =>
      q.state.data?.some((r) =>
        ["queued", "running", "waiting"].includes(r.status),
      )
        ? 1500
        : false,
  });
  const run = useQuery({
    queryKey: ["workflow-run", selectedRun],
    queryFn: () => requestJson<Run>(`/workflow-runs/${selectedRun}`),
    enabled: !!selectedRun,
    refetchInterval: (q) =>
      ["queued", "running", "waiting"].includes(q.state.data?.status ?? "")
        ? 1500
        : false,
  });
  const dirty = !!draft && JSON.stringify(draft) !== saved;
  const current = draft?.graph.nodes.find((n) => n.id === selected);
  const validation = draft ? analyzeWorkflow(draft.graph).errors : [];
  const change = useCallback(
    (graph: WorkflowGraph, history = true) => {
      if (!draft) return;
      if (history) {
        setUndo((h) => [...h.slice(-39), draft.graph]);
        setRedo([]);
      }
      setDraft({ ...draft, graph });
    },
    [draft],
  );
  function history(direction: "undo" | "redo") {
    if (!draft) return;
    const list = direction === "undo" ? undo : redo;
    if (!list.length) return;
    const graph = list.at(-1)!;
    if (direction === "undo") {
      setUndo(list.slice(0, -1));
      setRedo((r) => [...r, draft.graph]);
    } else {
      setRedo(list.slice(0, -1));
      setUndo((r) => [...r, draft.graph]);
    }
    setDraft({ ...draft, graph });
  }
  function duplicate() {
    if (!draft || !clipboard.current) return;
    const copied = clipboard.current;
    const mapping = new Map(
      copied.map((n) => [n.id, "n_" + crypto.randomUUID().slice(0, 8)]),
    );
    const id = mapping.get(copied[0]!.id)!;
    change({
      ...draft.graph,
      nodes: [
        ...draft.graph.nodes,
        ...copied.map((n) => ({
          ...n,
          id: mapping.get(n.id)!,
          position: { x: n.position.x + 40, y: n.position.y + 100 },
          data: {
            ...n.data,
            label: n.data.label + " copy",
            inputFrom: n.data.inputFrom
              ? (mapping.get(n.data.inputFrom) ?? n.data.inputFrom)
              : undefined,
          },
        })),
      ],
      edges: [
        ...draft.graph.edges,
        ...draft.graph.edges
          .filter((e) => mapping.has(e.source) && mapping.has(e.target))
          .map((e) =>
            edge(
              mapping.get(e.source)!,
              mapping.get(e.target)!,
              e.sourceHandle ?? undefined,
            ),
          ),
      ],
    });
    setSelection([...mapping.values()]);
    setSelected(id);
  }
  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (
        !build ||
        !!selectedRun ||
        !draft ||
        (e.target instanceof HTMLElement &&
          ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName))
      )
        return;
      if (e.ctrlKey || e.metaKey) {
        if (e.key === "z") {
          e.preventDefault();
          history(e.shiftKey ? "redo" : "undo");
        }
        if (e.key === "y") {
          e.preventDefault();
          history("redo");
        }
        if (e.key === "c" && current) {
          e.preventDefault();
          clipboard.current = draft.graph.nodes.filter((n) =>
            selection.includes(n.id),
          );
          if (!clipboard.current.length) clipboard.current = [current];
        }
        if (e.key === "v") {
          e.preventDefault();
          duplicate();
        }
      }
    }
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  });
  useEffect(() => {
    requestAnimationFrame(() => {
      void canvas.current?.fitView({ padding: 0.2, duration: 150 });
    });
  }, [draft?.graph.nodes.length, draft?.id, selectedRun]);
  async function action(task: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
      await cache.invalidateQueries({ queryKey: ["workflows", workspaceId] });
      await cache.invalidateQueries({
        queryKey: ["workflow-versions", draft?.id],
      });
      await cache.invalidateQueries({ queryKey: ["workflow-runs", draft?.id] });
      await cache.invalidateQueries({
        queryKey: ["workflow-run", selectedRun],
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string) {
    await action(async () => {
      const w = await requestJson<{
        id: string;
        name: string;
        description: string;
        draft_graph: WorkflowGraph;
        revision: number;
      }>(`/workflows/${id}`);
      const loaded = {
        id: w.id,
        name: w.name,
        description: w.description,
        graph: workflowGraph.parse(w.draft_graph),
        revision: w.revision,
      };
      setDraft(loaded);
      setSaved(JSON.stringify(loaded));
      setSelected(loaded.graph.nodes[0]!.id);
      setUndo([]);
      setRedo([]);
      setRun("");
      setVersion("");
    });
  }
  function create() {
    const fresh = {
      name: "",
      description: "",
      graph: emptyGraph(),
      revision: 1,
    };
    setDraft(fresh);
    setSaved("");
    setSelected("input");
    setUndo([]);
    setRedo([]);
    setRun("");
    setVersion("");
    setError("");
    setNotice("");
  }
  async function save() {
    if (!draft) return;
    await action(async () => {
      const g = workflowGraph.parse(draft.graph);
      const result = await requestJson<{ id: string; revision: number }>(
        draft.id
          ? `/workflows/${draft.id}`
          : `/workspaces/${workspaceId}/workflows`,
        draft.id ? "PUT" : "POST",
        {
          name: draft.name,
          description: draft.description,
          graph: g,
          ...(draft.id ? { revision: draft.revision } : {}),
        },
      );
      const next = {
        ...draft,
        id: result.id,
        revision: result.revision,
        graph: g,
      };
      setDraft(next);
      setSaved(JSON.stringify(next));
      setNotice("Workflow draft saved.");
    });
  }
  function updateNode(data: Partial<WorkflowNode["data"]>) {
    if (!draft || !current) return;
    change({
      ...draft.graph,
      nodes: draft.graph.nodes.map((n) =>
        n.id === current.id ? { ...n, data: { ...n.data, ...data } } : n,
      ),
    });
  }
  function add() {
    if (!draft) return;
    const id = "n_" + crypto.randomUUID().slice(0, 8),
      anchor = current ?? draft.graph.nodes.find((n) => n.type === "input")!,
      out = draft.graph.edges.filter((e) => e.source === anchor.id);
    const inserted = makeNode(
      id,
      kind,
      anchor.position.x + 240,
      anchor.position.y,
      {
        ...(kind === "agent" && agents.data?.[0]
          ? { agentVersionId: agents.data[0].id }
          : {}),
      },
    );
    let nodes = [...draft.graph.nodes, inserted],
      edges = draft.graph.edges;
    if (kind === "parallel" || kind === "router" || kind === "condition") {
      const a = id + "_a",
        b = id + "_b",
        m = id + "_merge";
      nodes = [
        ...nodes,
        makeNode(
          a,
          "agent",
          inserted.position.x + 240,
          inserted.position.y - 80,
          { label: "Branch A", agentVersionId: agents.data?.[0]?.id },
        ),
        makeNode(
          b,
          "agent",
          inserted.position.x + 240,
          inserted.position.y + 80,
          {
            label: "Branch B",
            agentVersionId: agents.data?.[1]?.id ?? agents.data?.[0]?.id,
          },
        ),
        makeNode(m, "merge", inserted.position.x + 480, inserted.position.y),
      ];
      edges =
        out.length === 1
          ? [
              ...edges.filter((e) => e.id !== out[0]!.id),
              edge(anchor.id, id, out[0]!.sourceHandle ?? undefined),
              edge(m, out[0]!.target),
            ]
          : edges;
      edges = [
        ...edges,
        edge(id, a, kind === "parallel" ? undefined : "true"),
        edge(id, b, kind === "parallel" ? undefined : "false"),
        edge(a, m),
        edge(b, m),
      ];
    } else if (out.length === 1) {
      edges = [
        ...edges.filter((e) => e.id !== out[0]!.id),
        edge(anchor.id, id, out[0]!.sourceHandle ?? undefined),
        edge(id, out[0]!.target),
      ];
    }
    change(layout({ ...draft.graph, nodes, edges }));
    setSelected(id);
  }
  function template() {
    if (!agents.data?.length) {
      setError("Publish agents before adding a multi-agent template.");
      return;
    }
    const graph = layout({
      schemaVersion: 1,
      nodes: [
        makeNode("input", "input", 0, 0),
        makeNode("research", "agent", 0, 0, {
          label: "Research agent",
          agentVersionId: agents.data[0]!.id,
        }),
        makeNode("review", "approval", 0, 0, { label: "Human review" }),
        makeNode("writer", "agent", 0, 0, {
          label: "Writer agent",
          agentVersionId: agents.data[1]?.id ?? agents.data[0]!.id,
        }),
        makeNode("output", "output", 0, 0),
      ],
      edges: [
        edge("input", "research"),
        edge("research", "review"),
        edge("review", "writer"),
        edge("writer", "output"),
      ],
    });
    change(graph);
    setSelected("research");
  }
  function connections(connection: Connection) {
    if (!draft || !connection.source || !connection.target) return;
    change({
      ...draft.graph,
      edges: [
        ...draft.graph.edges,
        edge(
          connection.source,
          connection.target,
          connection.sourceHandle as "true" | "false" | undefined,
        ),
      ],
    });
  }
  function nodeChanges(changes: NodeChange<CanvasNode>[]) {
    if (!draft) return;
    const selects = changes.filter((c) => c.type === "select");
    if (selects.length)
      setSelection((previous) => {
        const next = new Set(previous);
        for (const c of selects)
          if (c.type === "select") {
            if (c.selected) next.add(c.id);
            else next.delete(c.id);
          }
        return [...next];
      });
    const items = applyNodeChanges(
      changes,
      draft.graph.nodes.map((n) => ({
        id: n.id,
        type: "workflow" as const,
        position: n.position,
        data: { label: n.data.label, kind: n.type },
      })),
    );
    const ids = new Set(items.map((n) => n.id));
    const graph = {
      ...draft.graph,
      nodes: draft.graph.nodes
        .filter((n) => ids.has(n.id))
        .map((n) => ({
          ...n,
          position: items.find((item) => item.id === n.id)!.position,
        })),
      edges: draft.graph.edges.filter(
        (e) => ids.has(e.source) && ids.has(e.target),
      ),
    };
    if (changes.some((c) => c.type !== "select"))
      change(
        graph,
        changes.some((c) => c.type === "remove"),
      );
  }
  function edgeChanges(changes: EdgeChange<Edge>[]) {
    if (!draft) return;
    const edges = applyEdgeChanges(changes, draft.graph.edges);
    if (changes.some((c) => c.type !== "select"))
      change({
        ...draft.graph,
        edges: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle as "true" | "false" | null | undefined,
        })),
      });
  }
  async function start() {
    if (!draft?.id) return;
    await action(async () => {
      const result = await requestJson<{ id: string }>(
        `/workflows/${draft.id}/runs`,
        "POST",
        {
          input: runInput,
          ...(versionId ? { versionId } : { revision: draft.revision }),
        },
      );
      setRun(result.id);
      setNotice("Workflow queued. The worker will checkpoint each step.");
    });
  }
  async function decide(decision: "approved" | "rejected") {
    await action(async () => {
      await requestJson(`/workflow-runs/${selectedRun}/approval`, "POST", {
        decision,
        comment,
        ...(edited.trim() ? { editedInput: JSON.parse(edited) } : {}),
      });
      setComment("");
      setEdited("");
      setNotice(
        decision === "approved"
          ? "Approved. Execution will resume from its checkpoint."
          : "Run rejected.",
      );
    });
  }
  if (!read) return <p className="empty">Your role cannot access workflows.</p>;
  const displayGraph = run.data?.graph_snapshot ?? draft?.graph;
  const statuses = new Map(run.data?.nodes.map((n) => [n.node_id, n.status]));
  return (
    <section className="panel workflow-studio">
      <div className="panel-header">
        <div>
          <h2>Visual workflows</h2>
          <p>
            Connect published agents, tools and review gates into a versioned
            workflow.
          </p>
        </div>
        {build && <Button onClick={create}>Create workflow</Button>}
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {workflows.error && <p className="error">{workflows.error.message}</p>}
      <div className="workflow-picker">
        {workflows.data?.map((w) => (
          <Button className="secondary" key={w.id} onClick={() => open(w.id)}>
            {w.name}
          </Button>
        ))}
      </div>
      {!draft ? (
        <p className="empty">
          Choose a workflow or create a new one. Publish agents in Agents before
          adding agent nodes.
        </p>
      ) : (
        <>
          <div className="form-grid">
            <label>
              Workflow name
              <input
                disabled={!build}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                maxLength={100}
              />
            </label>
            <label>
              Description
              <input
                disabled={!build}
                value={draft.description}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
                maxLength={2000}
              />
            </label>
          </div>
          {build && (
            <div className="workflow-toolbar">
              <Button disabled={busy || !draft.name.trim()} onClick={save}>
                Save workflow
              </Button>
              <Button
                className="secondary"
                disabled={busy || dirty || !draft.id}
                onClick={() =>
                  action(async () => {
                    const v = await requestJson<{ errors: string[] }>(
                      `/workflows/${draft.id}/validate`,
                      "POST",
                    );
                    setNotice(
                      v.errors.length
                        ? v.errors.join("; ")
                        : "Workflow is valid and its dependencies are available.",
                    );
                  })
                }
              >
                Validate workflow
              </Button>
              <Button
                className="secondary"
                disabled={busy || dirty || !draft.id || !!validation.length}
                onClick={() =>
                  action(async () => {
                    const v = await requestJson<{ version: number }>(
                      `/workflows/${draft.id}/publish`,
                      "POST",
                      { revision: draft.revision },
                    );
                    setNotice(`Workflow version ${v.version} published.`);
                  })
                }
              >
                Publish workflow
              </Button>
              <Button
                className="secondary"
                onClick={template}
                disabled={!!selectedRun}
              >
                Two-agent review template
              </Button>
              <Button
                className="danger"
                disabled={busy || !draft.id}
                onClick={() =>
                  action(async () => {
                    await requestJson(`/workflows/${draft.id}`, "DELETE");
                    setDraft(null);
                    setRun("");
                  })
                }
              >
                Archive workflow
              </Button>
            </div>
          )}
          <div className="workflow-toolbar">
            <label>
              Node type
              <select
                aria-label="Node type"
                value={kind}
                onChange={(e) =>
                  setKind(e.target.value as WorkflowNode["type"])
                }
              >
                {workflowKinds.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            {build && (
              <>
                <Button
                  className="secondary"
                  disabled={!!selectedRun || draft.graph.nodes.length >= 36}
                  onClick={add}
                >
                  Add node
                </Button>
                <Button
                  className="secondary"
                  disabled={!!selectedRun || !undo.length}
                  onClick={() => history("undo")}
                >
                  Undo
                </Button>
                <Button
                  className="secondary"
                  disabled={!!selectedRun || !redo.length}
                  onClick={() => history("redo")}
                >
                  Redo
                </Button>
                <Button
                  className="secondary"
                  disabled={!!selectedRun || !current}
                  onClick={() => {
                    clipboard.current = draft.graph.nodes.filter((n) =>
                      selection.includes(n.id),
                    );
                    if (!clipboard.current.length && current)
                      clipboard.current = [current];
                    duplicate();
                  }}
                >
                  Duplicate node
                </Button>
                <Button
                  className="secondary"
                  disabled={!!selectedRun}
                  onClick={() => change(layout(draft.graph))}
                >
                  Auto layout
                </Button>
              </>
            )}
            {selectedRun && (
              <Button className="secondary" onClick={() => setRun("")}>
                Return to draft canvas
              </Button>
            )}
          </div>
          <div className="workflow-editor">
            <div className="workflow-canvas" aria-label="Workflow canvas">
              <ReactFlow<CanvasNode, Edge>
                nodes={(displayGraph?.nodes ?? []).map((n) => ({
                  id: n.id,
                  type: "workflow" as const,
                  width: 170,
                  height: 100,
                  position: n.position,
                  selected: selection.includes(n.id),
                  data: {
                    label: n.data.label,
                    kind: n.type,
                    status: statuses.get(n.id),
                  },
                }))}
                edges={(displayGraph?.edges ?? []).map((e) => ({
                  ...e,
                  label: e.sourceHandle ?? undefined,
                  animated: run.data?.status === "running",
                }))}
                nodeTypes={nodeTypes}
                onNodesChange={build && !selectedRun ? nodeChanges : undefined}
                onEdgesChange={build && !selectedRun ? edgeChanges : undefined}
                onConnect={connections}
                onInit={(instance) => {
                  canvas.current = instance;
                }}
                onNodeDragStart={() => {
                  if (draft) {
                    setUndo((h) => [...h.slice(-39), draft.graph]);
                    setRedo([]);
                  }
                }}
                onNodeClick={(event, n) => {
                  if (!event.shiftKey) setSelection([n.id]);
                  setSelected(n.id);
                  const data = draft.graph.nodes.find(
                    (item) => item.id === n.id,
                  )?.data;
                  setArguments(
                    JSON.stringify(data?.toolArguments ?? {}, null, 2),
                  );
                }}
                nodesDraggable={build && !selectedRun}
                nodesConnectable={build && !selectedRun}
                edgesReconnectable={false}
                deleteKeyCode={
                  build && !selectedRun ? ["Backspace", "Delete"] : null
                }
                fitView
                snapToGrid
                snapGrid={[20, 20]}
                multiSelectionKeyCode="Shift"
                minZoom={0.15}
                maxZoom={2}
              >
                <Background />
                <MiniMap pannable zoomable />
                <Controls />
              </ReactFlow>
            </div>
            <aside className="workflow-properties">
              <fieldset disabled={!build}>
                {current && !selectedRun ? (
                  <>
                    <h3>{current.type} configuration</h3>
                    <label>
                      Node label
                      <input
                        disabled={!build}
                        value={current.data.label}
                        onChange={(e) => updateNode({ label: e.target.value })}
                        maxLength={100}
                      />
                    </label>
                    <small>Node ID: {current.id}</small>
                    {current.type === "agent" && (
                      <>
                        <label>
                          Published agent version
                          <select
                            disabled={!build}
                            value={current.data.agentVersionId ?? ""}
                            onChange={(e) =>
                              updateNode({
                                agentVersionId: e.target.value || undefined,
                              })
                            }
                          >
                            <option value="">Choose a published agent</option>
                            {agents.data?.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name} · v{a.version}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Instruction prefix
                          <textarea
                            disabled={!build}
                            value={current.data.prefix}
                            onChange={(e) =>
                              updateNode({ prefix: e.target.value })
                            }
                            maxLength={2000}
                          />
                        </label>
                        <label>
                          Instruction suffix
                          <textarea
                            disabled={!build}
                            value={current.data.suffix}
                            onChange={(e) =>
                              updateNode({ suffix: e.target.value })
                            }
                            maxLength={2000}
                          />
                        </label>
                      </>
                    )}
                    {current.type === "tool" && (
                      <>
                        <label>
                          Registered tool
                          <select
                            value={current.data.toolId ?? ""}
                            onChange={(e) =>
                              updateNode({
                                toolId: e.target.value || undefined,
                              })
                            }
                          >
                            <option value="">Choose an enabled tool</option>
                            {tools.data
                              ?.filter((t) => t.enabled)
                              .map((t) => (
                                <option key={t.id} value={t.id}>
                                  {t.name}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label>
                          Static tool arguments (JSON)
                          <textarea
                            value={argumentsText}
                            onChange={(e) => setArguments(e.target.value)}
                            maxLength={8000}
                          />
                        </label>
                        <Button
                          className="secondary"
                          onClick={() => {
                            try {
                              updateNode({
                                toolArguments: JSON.parse(argumentsText),
                              });
                              setError("");
                            } catch {
                              setError("Tool arguments must be valid JSON.");
                            }
                          }}
                        >
                          Apply arguments
                        </Button>
                        <label>
                          Input argument name
                          <input
                            value={current.data.inputArgument ?? ""}
                            onChange={(e) =>
                              updateNode({
                                inputArgument: e.target.value || undefined,
                              })
                            }
                          />
                        </label>
                      </>
                    )}
                    {["router", "condition"].includes(current.type) && (
                      <>
                        <label>
                          Condition operator
                          <select
                            value={current.data.operator}
                            onChange={(e) =>
                              updateNode({
                                operator: e.target
                                  .value as WorkflowNode["data"]["operator"],
                              })
                            }
                          >
                            <option value="contains">Contains</option>
                            <option value="equals">Equals</option>
                            <option value="not-empty">Not empty</option>
                          </select>
                        </label>
                        <label>
                          Comparison value
                          <input
                            value={current.data.value}
                            onChange={(e) =>
                              updateNode({ value: e.target.value })
                            }
                            maxLength={1000}
                          />
                        </label>
                        <p className="muted">
                          Connect both true and false handles. Expressions are
                          deterministic; no code is evaluated.
                        </p>
                      </>
                    )}
                    {current.type === "approval" && (
                      <label>
                        Review instructions
                        <textarea
                          value={current.data.approvalPrompt}
                          onChange={(e) =>
                            updateNode({ approvalPrompt: e.target.value })
                          }
                          maxLength={2000}
                        />
                      </label>
                    )}
                    {current.type !== "input" && (
                      <label>
                        Input mapping
                        <select
                          disabled={!build}
                          value={current.data.inputFrom ?? ""}
                          onChange={(e) =>
                            updateNode({
                              inputFrom: e.target.value || undefined,
                            })
                          }
                        >
                          <option value="">Connected predecessor output</option>
                          {draft.graph.nodes
                            .filter((n) => n.id !== current.id)
                            .map((n) => (
                              <option key={n.id} value={n.id}>
                                {n.data.label}
                              </option>
                            ))}
                        </select>
                      </label>
                    )}
                    {build && (
                      <Button
                        className="danger"
                        onClick={() => {
                          change({
                            ...draft.graph,
                            nodes: draft.graph.nodes.filter(
                              (n) => n.id !== current.id,
                            ),
                            edges: draft.graph.edges.filter(
                              (e) =>
                                e.source !== current.id &&
                                e.target !== current.id,
                            ),
                          });
                          setSelected("");
                        }}
                      >
                        Delete node
                      </Button>
                    )}
                  </>
                ) : (
                  <p className="muted">
                    Select a node to configure it. Run snapshots are read-only.
                  </p>
                )}
              </fieldset>
            </aside>
          </div>
          {!!validation.length && (
            <div className="workflow-validation">
              <h4>Draft validation</h4>
              <ul>
                {validation.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="muted">
            Drag nodes to arrange them; connect handles to change data flow.
            Shift selects multiple nodes; Delete removes selection; Ctrl/Cmd+C/V
            copies a selected node; Ctrl/Cmd+Z/Shift+Z undo/redo. Parallel
            branches join at a Merge. One review gate is supported per workflow.
          </p>
          {!!versions.data?.length && (
            <details>
              <summary>Published versions</summary>
              {versions.data.map((v) => (
                <div className="workflow-version" key={v.id}>
                  {v.name} · v{v.version}
                  {build && (
                    <Button
                      className="secondary"
                      disabled={busy || dirty}
                      onClick={() =>
                        action(async () => {
                          const result = await requestJson<{
                            revision: number;
                          }>(`/workflows/${draft.id}/restore/${v.id}`, "POST", {
                            revision: draft.revision,
                          });
                          const next = {
                            ...draft,
                            name: v.name,
                            graph: workflowGraph.parse(v.graph),
                            revision: result.revision,
                          };
                          setDraft(next);
                          setSaved(JSON.stringify(next));
                          setNotice("Published graph restored to the draft.");
                        })
                      }
                    >
                      Restore draft
                    </Button>
                  )}
                </div>
              ))}
            </details>
          )}
          {build && (
            <form
              className="workflow-run-form"
              onSubmit={(e) => {
                e.preventDefault();
                void start();
              }}
            >
              <h3>Execute workflow</h3>
              <label>
                Run version
                <select
                  value={versionId}
                  onChange={(e) => setVersion(e.target.value)}
                >
                  <option value="">Saved draft</option>
                  {versions.data?.map((v) => (
                    <option key={v.id} value={v.id}>
                      Published v{v.version}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Workflow input
                <textarea
                  required
                  value={runInput}
                  onChange={(e) => setRunInput(e.target.value)}
                  maxLength={12000}
                />
              </label>
              <Button
                type="submit"
                disabled={
                  busy ||
                  !draft.id ||
                  (!versionId && dirty) ||
                  (!versionId && !!validation.length)
                }
              >
                Run workflow
              </Button>
            </form>
          )}
          <div className="workflow-run-list">
            {runs.data?.map((r) => (
              <Button
                key={r.id}
                className="secondary"
                onClick={() => setRun(r.id)}
              >
                Run {r.id.slice(0, 8)} · {r.status}
              </Button>
            ))}
          </div>
          {run.error && <p className="error">{run.error.message}</p>}
          {run.data && (
            <section
              className="workflow-inspector"
              aria-label="Workflow run inspector"
            >
              <h3>
                Run inspector ·{" "}
                <span data-testid="workflow-run-status">{run.data.status}</span>
              </h3>
              {run.data.error_code && (
                <p className="error">{run.data.error_code}</p>
              )}
              {build &&
                ["queued", "running", "waiting"].includes(run.data.status) && (
                  <Button
                    className="danger"
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        await requestJson(
                          `/workflow-runs/${selectedRun}/cancel`,
                          "POST",
                        );
                      })
                    }
                  >
                    Cancel workflow run
                  </Button>
                )}
              {run.data.approvals
                .filter(
                  (a) =>
                    a.decision === "pending" && run.data!.status === "waiting",
                )
                .map((a) => (
                  <div className="workflow-approval" key={a.id}>
                    <h4>Human review</h4>
                    <p>{a.prompt}</p>
                    <pre>{json(a.input)}</pre>
                    {approve ? (
                      <>
                        <label>
                          Approval comment
                          <textarea
                            value={comment}
                            onChange={(e) => setComment(e.target.value)}
                            maxLength={2000}
                          />
                        </label>
                        <label>
                          Edited input (optional JSON)
                          <textarea
                            value={edited}
                            onChange={(e) => setEdited(e.target.value)}
                            placeholder={'"Reviewed text"'}
                            maxLength={16000}
                          />
                        </label>
                        <Button
                          disabled={busy}
                          onClick={() => decide("approved")}
                        >
                          Approve and resume
                        </Button>
                        <Button
                          className="danger"
                          disabled={busy}
                          onClick={() => decide("rejected")}
                        >
                          Reject run
                        </Button>
                      </>
                    ) : (
                      <p>
                        An administrator or operator must approve this
                        checkpoint.
                      </p>
                    )}
                  </div>
                ))}
              <div className="workflow-node-traces">
                {run.data.graph_snapshot.nodes.map((n) => {
                  const trace = run.data!.nodes.find((t) => t.node_id === n.id);
                  return (
                    <details key={n.id}>
                      <summary>
                        {n.data.label} · {trace?.status ?? "Not executed"}
                        {trace?.duration_ms != null
                          ? ` · ${trace.duration_ms} ms`
                          : ""}
                      </summary>
                      {trace?.error_code && (
                        <p className="error">{trace.error_code}</p>
                      )}
                      {trace && (
                        <>
                          <small>
                            {n.type === "agent"
                              ? `Reported tokens: ${trace.input_tokens ?? "unavailable"} input / ${trace.output_tokens ?? "unavailable"} output`
                              : n.type}
                          </small>
                          <h4>Input</h4>
                          <pre>{json(trace.input)}</pre>
                          <h4>Output</h4>
                          <pre>{json(trace.output)}</pre>
                          <Citations sources={trace.citations ?? []} />
                        </>
                      )}
                    </details>
                  );
                })}
              </div>
              <ToolTraces traces={run.data.tools} />
              {run.data.status === "completed" && (
                <div className="workflow-final-output">
                  <h4>Final output</h4>
                  <pre>{json(run.data.output)}</pre>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
