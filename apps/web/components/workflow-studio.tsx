"use client";
import { WorkflowMappingEditor } from "./workflow-mapping-editor";
import { WorkflowNodeInspector } from "./workflow-node-inspector";
import { WorkflowTriggers } from "./workflow-triggers";
import { WorkflowInputEditor, WorkflowRunFields } from "./workflow-inputs";
import { normalizeWorkflowInput } from "@agentconnect/schemas/workflows";
import { WorkflowComponentLibrary } from "./workflow-component-library";
import { WorkflowCanvasToolbar } from "./workflow-canvas-toolbar";
import { workflowNodeTypes, type CanvasNode } from "./workflow-canvas-node";
import { WorkflowCreateWizard } from "./workflow-create-wizard";

import { HelpTooltip } from "./help-tooltip";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  MiniMap,
  applyNodeChanges,
  useNodesState,
  applyEdgeChanges,
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
import { WorkflowNodeDepth } from "./workflow-node-depth";
import { WorkflowResult } from "./workflow-result";
import {
  workflowTemplates,
  workflowFromTemplate,
} from "@agentconnect/schemas/workflow-templates";
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
  attempts: number;
  retry_history: {
    attempt: number;
    code: string;
    durationMs: number;
    willRetry: boolean;
  }[];
  retry_at: string | null;
};
type Run = {
  id: string;
  status: string;
  input: string;
  output: unknown;
  error_code: string | null;
  graph_snapshot: WorkflowGraph;
  nodes: NodeTrace[];
  tools: (ToolTrace & { workflow_node_id?: string })[];
  approvals: {
    id: string;
    node_id: string;
    prompt: string;
    input: unknown;
    decision: string;
    comment: string;
  }[];
};
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
  inputFields: [],
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
  const [expanded, setExpanded] = useState(false),
    [testOpen, setTestOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [testAttempted, setTestAttempted] = useState(false);
  const editor = useRef<HTMLDivElement>(null);
  const [wizard, setWizard] = useState(false);
  const [stage, setStage] = useState<"build" | "test" | "publish" | "triggers">(
    "build",
  );
  const [draft, setDraft] = useState<Draft | null>(null),
    [saved, setSaved] = useState(""),
    [selected, setSelected] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [runInput, setRunInput] = useState(""),
    [versionId, setVersion] = useState(""),
    [selectedRun, setRun] = useState(""),
    [comment, setComment] = useState(""),
    [edited, setEdited] = useState(""),
    [argumentsText, setArguments] = useState("{}");
  const [undo, setUndo] = useState<WorkflowGraph[]>([]),
    [redo, setRedo] = useState<WorkflowGraph[]>([]);
  const clipboard = useRef<WorkflowNode[] | null>(null);
  const skipFit = useRef(false);
  const canvas = useRef<ReactFlowInstance<CanvasNode, Edge> | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [canvasNodes, setCanvasNodes, onCanvasNodesChange] =
    useNodesState<CanvasNode>([]);
  const versions = useQuery({
    queryKey: ["workflow-versions", draft?.id],
    queryFn: () => requestJson<Version[]>(`/workflows/${draft?.id}/versions`),
    enabled: !!draft?.id,
  });
  const runs = useQuery({
    queryKey: ["workflow-runs", draft?.id],
    queryFn: () =>
      requestJson<
        {
          id: string;
          status: string;
          created_at: string;
          schedule_id?: string;
          api_trigger?: boolean;
        }[]
      >(`/workflows/${draft?.id}/runs`),
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
  const activeRun =
    starting ||
    (!!selectedRun &&
      (!run.data ||
        ["queued", "running", "waiting"].includes(run.data.status)));
  useEffect(() => {
    if (!expanded) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    const scroll = { x: window.scrollX, y: window.scrollY };
    document.body.style.overflow = "hidden";
    const inert: HTMLElement[] = [];
    let branch: HTMLElement | null = editor.current;
    while (branch?.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (
          sibling !== branch &&
          sibling instanceof HTMLElement &&
          !sibling.inert
        ) {
          sibling.inert = true;
          inert.push(sibling);
        }
      }
      branch = branch.parentElement;
      if (branch === document.body) break;
    }
    editor.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpanded(false);
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [
        ...(editor.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"], summary',
        ) ?? []),
      ].filter((el) => el.getClientRects().length);
      const first = controls[0],
        last = controls.at(-1);
      if (!editor.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("keydown", keys);
      document.body.style.overflow = overflow;
      for (const element of inert) element.inert = false;
      editor.current
        ?.querySelectorAll<HTMLDetailsElement>(".canvas-draft-settings[open]")
        .forEach((details) => {
          details.open = false;
        });
      previous?.focus({ preventScroll: true });
      window.scrollTo(scroll.x, scroll.y);
    };
  }, [expanded]);
  const canvasEditable =
    build && stage === "build" && !selectedRun && !starting;
  const dirty = !!draft && JSON.stringify(draft) !== saved;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const current = draft?.graph.nodes.find((n) => n.id === selected);
  const validation = draft ? analyzeWorkflow(draft.graph).errors : [];
  const change = useCallback(
    (graph: WorkflowGraph, history = true) => {
      if (!draft || !canvasEditable) return;
      if (history) {
        setUndo((h) => [...h.slice(-39), draft.graph]);
        setRedo([]);
      }
      setDraft({ ...draft, graph });
    },
    [draft, canvasEditable],
  );
  function history(direction: "undo" | "redo") {
    if (!draft || !canvasEditable) return;
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
    if (!draft || !clipboard.current || !canvasEditable) return;
    if (draft.graph.nodes.length + clipboard.current.length > 36) {
      setError("Duplicating these nodes would exceed the 36-node limit.");
      return;
    }
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
            ...(n.data.inputBindings
              ? {
                  inputBindings: n.data.inputBindings.map((b) => ({
                    ...b,
                    source: mapping.get(b.source) ?? b.source,
                  })),
                }
              : {}),
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
        stage !== "build" ||
        starting ||
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
    if (skipFit.current) {
      skipFit.current = false;
      return;
    }
    if (stage === "publish" || stage === "triggers" || wizard) return;
    requestAnimationFrame(() => {
      const width =
        editor.current
          ?.querySelector(".workflow-canvas")
          ?.getBoundingClientRect().width ?? 0;
      void canvas.current?.fitView({
        padding:
          testOpen && width > 700
            ? { right: "400px", left: "24px", top: "110px", bottom: "24px" }
            : 0.2,
        duration: 0,
      });
    });
  }, [
    draft?.graph.nodes.length,
    draft?.id,
    selectedRun,
    stage,
    wizard,
    expanded,
  ]);
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
    if (
      dirty &&
      !window.confirm("Discard unsaved changes and open another workflow?")
    )
      return;
    setStage("build");
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
  function create(templateId?: string, copy = false) {
    if (
      dirty &&
      !window.confirm("Discard unsaved workflow changes and start a new draft?")
    )
      return;
    const template = workflowTemplates.find((t) => t.id === templateId);
    const fresh = {
      name:
        copy && draft
          ? draft.name.slice(0, 95) + " copy"
          : (template?.name ?? ""),
      description:
        copy && draft ? draft.description : (template?.description ?? ""),
      graph:
        copy && draft
          ? workflowGraph.parse(draft.graph)
          : template
            ? workflowFromTemplate(template.id)
            : emptyGraph(),
      revision: 1,
    };
    setStage("build");
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
    if (!draft || !current || !canvasEditable) return;
    change({
      ...draft.graph,
      nodes: draft.graph.nodes.map((n) =>
        n.id === current.id ? { ...n, data: { ...n.data, ...data } } : n,
      ),
    });
  }
  function add(kind: WorkflowNode["type"]) {
    if (!draft || !canvasEditable) return;
    const count = ["parallel", "router", "condition"].includes(kind) ? 4 : 1;
    if (draft.graph.nodes.length + count > 36) {
      setError(
        "A workflow supports up to 36 nodes. This addition would exceed the limit.",
      );
      return;
    }
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
      inputFields: [],
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
    if (
      !build ||
      stage !== "build" ||
      selectedRun ||
      !draft ||
      !connection.source ||
      !connection.target
    )
      return;
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
    changes = changes.filter((c) => c.type !== "dimensions");
    if (!changes.length) return;
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
  const testBlockers = draft
    ? [
        ...(!draft.id ? ["Save your workflow before testing."] : []),
        ...(!versionId && dirty
          ? ["Save your draft changes before testing."]
          : []),
        ...(!versionId ? validation : []),
        ...(() => {
          try {
            const graph = versionId
              ? versions.data?.find((v) => v.id === versionId)?.graph
              : draft.graph;
            if (graph)
              normalizeWorkflowInput(
                graph,
                runInput || (graph.inputFields?.length ? "{}" : ""),
              );
            return [];
          } catch (e) {
            return [(e as Error).message];
          }
        })(),
      ]
    : ["Create or select a workflow before testing."];
  useEffect(() => {
    const element = editor.current;
    const controls = element?.querySelector(".canvas-controls");
    if (!element || !controls) return;
    const update = () =>
      element.style.setProperty(
        "--canvas-toolbar-height",
        `${controls.getBoundingClientRect().height + 24}px`,
      );
    const observer = new ResizeObserver(update);
    observer.observe(controls);
    update();
    return () => observer.disconnect();
  }, [draft?.id, wizard, stage, expanded]);
  async function start() {
    if (activeRun || busy) return;
    setTestOpen(true);
    setTestAttempted(true);
    if (!draft?.id || testBlockers.length) return;
    setStarting(true);
    try {
      await action(async () => {
        const result = await requestJson<{ id: string }>(
          `/workflows/${draft.id}/runs`,
          "POST",
          {
            input:
              runInput ||
              ((versionId
                ? versions.data?.find((v) => v.id === versionId)?.graph
                : draft.graph
              )?.inputFields?.length
                ? "{}"
                : ""),
            ...(versionId ? { versionId } : { revision: draft.revision }),
          },
        );
        setRun(result.id);
        setNotice("Workflow queued. The worker will checkpoint each step.");
      });
    } finally {
      setStarting(false);
    }
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
  const traceNodes = run.data?.nodes;
  useEffect(() => {
    const statuses = new Map(
      traceNodes?.map((n) => [
        n.node_id,
        n.status === "running" && run.data?.status !== "running"
          ? (run.data?.status ?? n.status)
          : n.status,
      ]),
    );
    setCanvasNodes((previous) => {
      const existing = new Map(previous.map((n) => [n.id, n]));
      return (displayGraph?.nodes ?? []).map((n) => ({
        ...existing.get(n.id),
        id: n.id,
        type: "workflow" as const,
        width: 170,
        height: 100,
        position: n.position,
        selected: selection.includes(n.id),
        data: { label: n.data.label, kind: n.type, status: statuses.get(n.id) },
      }));
    });
  }, [displayGraph, traceNodes, run.data?.status, selection, setCanvasNodes]);
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
        {build && (
          <Button
            onClick={() => {
              if (
                !dirty ||
                window.confirm(
                  "Start setup for a new workflow? Unsaved changes will be replaced only when you create it.",
                )
              )
                setWizard(true);
            }}
          >
            Create workflow
          </Button>
        )}
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {workflows.error && <p className="error">{workflows.error.message}</p>}
      {wizard && (
        <WorkflowCreateWizard
          agents={agents.data ?? []}
          loading={agents.isPending}
          error={agents.error?.message}
          onCancel={() => setWizard(false)}
          onBlank={() => {
            create();
            setWizard(false);
          }}
          onCreate={async (setup) => {
            const result = await requestJson<{ id: string; revision: number }>(
              `/workspaces/${workspaceId}/workflows`,
              "POST",
              setup,
            );
            const next = { ...setup, ...result };
            setDraft(next);
            setSaved(JSON.stringify(next));
            setSelected("input");
            setUndo([]);
            setRedo([]);
            setRun("");
            setVersion("");
            setError("");
            setNotice("Workflow draft saved. Test it before publishing.");
            setStage("build");
            setWizard(false);
            await cache.invalidateQueries({
              queryKey: ["workflows", workspaceId],
            });
          }}
        />
      )}
      <div hidden={wizard}>
        <div className="workflow-picker">
          {workflows.data?.map((w) => (
            <Button className="secondary" key={w.id} onClick={() => open(w.id)}>
              {w.name}
            </Button>
          ))}
        </div>
        {build && (
          <details className="configure-group">
            <summary>Start from a template</summary>
            <p>
              Editable starting points. Select published agent versions before
              testing or publishing.
            </p>
            <div className="workflow-picker">
              {workflowTemplates.map((t) => (
                <div key={t.id}>
                  <Button className="secondary" onClick={() => create(t.id)}>
                    {t.name}
                  </Button>
                  <p>{t.description}</p>
                </div>
              ))}
            </div>
          </details>
        )}
        {!draft ? (
          <p className="empty">
            Choose a workflow or create a new one. Publish agents in Agents
            before adding agent nodes.
          </p>
        ) : (
          <>
            {build && stage === "build" && (
              <WorkflowComponentLibrary
                key={workspaceId}
                workspaceId={workspaceId}
                graph={draft.graph}
                selection={selection}
                anchor={selected}
                disabled={!canvasEditable || busy}
                onInsert={change}
              />
            )}
            <div
              className="workflow-stage-nav"
              role="group"
              aria-label="Workflow activities"
            >
              {(["build", "test", "publish", "triggers"] as const).map(
                (item) => (
                  <button
                    type="button"
                    key={item}
                    aria-pressed={stage === item}
                    onClick={() => {
                      setStage(item);
                      if (item === "test") setTestOpen(true);
                    }}
                  >
                    {item === "build"
                      ? "Build"
                      : item === "test"
                        ? "Test"
                        : item === "publish"
                          ? "Publish"
                          : "Triggers"}
                  </button>
                ),
              )}
              <span role="status">
                {dirty
                  ? "Unsaved changes"
                  : `Saved · revision ${draft.revision}`}
              </span>
            </div>
            <div className="workflow-savebar">
              <span>{dirty ? "Unsaved changes" : "Saved"}</span>
              {build && (
                <Button
                  disabled={busy || activeRun || !draft.name.trim() || !dirty}
                  onClick={save}
                >
                  Save workflow
                </Button>
              )}
              <Button
                className="secondary"
                onClick={() => {
                  setStage("test");
                  setTestOpen(true);
                }}
              >
                Test workflow
              </Button>
            </div>
            <div hidden={stage !== "build"}>
              <div className="form-grid">
                <label>
                  Workflow name
                  <input
                    disabled={!build}
                    value={draft.name}
                    onChange={(e) =>
                      setDraft({ ...draft, name: e.target.value })
                    }
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
                  <Button
                    className="secondary"
                    disabled={busy || !!selectedRun}
                    onClick={() => create(undefined, true)}
                  >
                    Create reusable copy
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
            </div>
            <div hidden={stage === "publish" || stage === "triggers"}>
              <div
                ref={editor}
                role={expanded ? "dialog" : undefined}
                aria-modal={expanded || undefined}
                aria-label={expanded ? "Expanded workflow canvas" : undefined}
                className={`workflow-editor ${stage === "test" || testOpen ? "test-canvas" : ""} ${expanded ? "canvas-expanded" : ""}`}
              >
                <div
                  className="workflow-canvas"
                  aria-label="Workflow canvas"
                  onDragOver={(event) => {
                    if (!canvasEditable) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const kind = event.dataTransfer.getData(
                      "application/x-agentconnex-node",
                    );
                    if (
                      !draft ||
                      !canvasEditable ||
                      draft.graph.nodes.length >= 36 ||
                      !workflowKinds.includes(kind as WorkflowNode["type"])
                    )
                      return;
                    const position = canvas.current?.screenToFlowPosition({
                      x: event.clientX,
                      y: event.clientY,
                    });
                    if (!position) return;
                    const id = "n_" + crypto.randomUUID().slice(0, 8);
                    skipFit.current = true;
                    change({
                      ...draft.graph,
                      nodes: [
                        ...draft.graph.nodes,
                        makeNode(
                          id,
                          kind as WorkflowNode["type"],
                          position.x,
                          position.y,
                          kind === "agent" && agents.data?.[0]
                            ? { agentVersionId: agents.data[0].id }
                            : {},
                        ),
                      ],
                    });
                    setSelected(id);
                  }}
                >
                  <ReactFlow<CanvasNode, Edge>
                    nodes={canvasNodes}
                    edges={(displayGraph?.edges ?? []).map((e) => ({
                      ...e,
                      label: e.sourceHandle ?? undefined,
                      animated:
                        (run.data?.status === "running" &&
                          run.data.nodes.some(
                            (trace) =>
                              trace.status === "running" &&
                              (trace.node_id === e.source ||
                                trace.node_id === e.target),
                          )) ??
                        false,
                    }))}
                    nodeTypes={workflowNodeTypes}
                    onNodesChange={(changes) => {
                      onCanvasNodesChange(changes);
                      if (canvasEditable) nodeChanges(changes);
                    }}
                    onEdgesChange={canvasEditable ? edgeChanges : undefined}
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
                      if (selectedRun) setTestOpen(true);
                      const data = draft.graph.nodes.find(
                        (item) => item.id === n.id,
                      )?.data;
                      setArguments(
                        JSON.stringify(data?.toolArguments ?? {}, null, 2),
                      );
                    }}
                    nodesDraggable={canvasEditable}
                    nodesConnectable={canvasEditable}
                    edgesReconnectable={false}
                    deleteKeyCode={
                      canvasEditable ? ["Backspace", "Delete"] : null
                    }
                    fitView
                    snapToGrid
                    snapGrid={[20, 20]}
                    multiSelectionKeyCode="Shift"
                    minZoom={0.15}
                    maxZoom={2}
                  >
                    <Panel position="top-left" className="canvas-controls">
                      {build && (
                        <WorkflowCanvasToolbar
                          disabled={!canvasEditable}
                          canAdd={draft.graph.nodes.length < 36}
                          onAdd={add}
                          undo={() => history("undo")}
                          redo={() => history("redo")}
                          duplicate={() => {
                            clipboard.current = draft.graph.nodes.filter((n) =>
                              selection.includes(n.id),
                            );
                            if (!clipboard.current.length && current)
                              clipboard.current = [current];
                            duplicate();
                          }}
                          layout={() => change(layout(draft.graph))}
                          canUndo={!!undo.length}
                          canRedo={!!redo.length}
                          canDuplicate={!!current}
                        />
                      )}

                      <div className="canvas-top-actions nodrag nopan">
                        <span
                          className="canvas-save-status"
                          role="status"
                          aria-label="Draft save status"
                        >
                          {dirty ? "Unsaved changes" : "Saved"}
                        </span>
                        {build && (
                          <>
                            <details className="canvas-draft-settings">
                              <summary>Workflow details</summary>
                              <fieldset disabled={!canvasEditable}>
                                <label>
                                  Draft name
                                  <input
                                    aria-label="Draft name"
                                    value={draft.name}
                                    maxLength={100}
                                    onChange={(event) =>
                                      setDraft({
                                        ...draft,
                                        name: event.target.value,
                                      })
                                    }
                                  />
                                </label>
                                <label>
                                  Description
                                  <textarea
                                    aria-label="Draft description"
                                    value={draft.description}
                                    maxLength={2000}
                                    rows={2}
                                    onChange={(event) =>
                                      setDraft({
                                        ...draft,
                                        description: event.target.value,
                                      })
                                    }
                                  />
                                </label>
                              </fieldset>
                            </details>
                            <Button
                              className="secondary"
                              disabled={
                                busy ||
                                activeRun ||
                                !dirty ||
                                !draft.name.trim()
                              }
                              onClick={save}
                            >
                              Save draft
                            </Button>
                          </>
                        )}
                        <Button
                          className="secondary"
                          onClick={() => setTestOpen(!testOpen)}
                        >
                          Test Workflow
                        </Button>
                        <Button
                          className="secondary"
                          onClick={() => setExpanded(!expanded)}
                        >
                          {expanded ? "Exit expanded view" : "Expand canvas"}
                        </Button>
                        {selectedRun && (
                          <Button
                            className="secondary"
                            disabled={activeRun || busy}
                            onClick={() => {
                              setRun("");
                              setStage("build");
                            }}
                          >
                            Return to draft canvas
                          </Button>
                        )}
                      </div>
                    </Panel>
                    {activeRun && (
                      <Panel position="bottom-center">
                        <span className="canvas-run-lock" role="status">
                          Canvas locked ·{" "}
                          {starting
                            ? "Starting run"
                            : (run.data?.status ?? "Loading run")}
                        </span>
                      </Panel>
                    )}
                    {testOpen && (
                      <Panel
                        position="bottom-right"
                        className="canvas-test-panel nodrag nopan"
                        role="region"
                        aria-label="Workflow test panel"
                      >
                        <div className="canvas-test-heading">
                          <strong>Workflow testing</strong>
                          <Button
                            className="secondary"
                            onClick={() => setTestOpen(false)}
                          >
                            Close test panel
                          </Button>
                        </div>
                        {error && (
                          <p role="alert" className="error">
                            {error}
                          </p>
                        )}
                        {dirty && !versionId && (
                          <p>Save your draft before testing.</p>
                        )}
                        {testAttempted && !!testBlockers.length && (
                          <div className="workflow-test-blockers" role="alert">
                            <strong>Unable to test workflow</strong>
                            <ul>
                              {testBlockers.map((message) => {
                                const matches = draft.graph.nodes.filter(
                                  (node) =>
                                    message.startsWith(node.data.label + ":"),
                                );
                                return (
                                  <li key={message}>
                                    {matches.length === 1 ? (
                                      <button
                                        type="button"
                                        className="text-button"
                                        onClick={() => {
                                          setStage("build");
                                          setTestOpen(false);
                                          setSelected(matches[0]!.id);
                                          setSelection([matches[0]!.id]);
                                          canvas.current?.fitView({
                                            nodes: [{ id: matches[0]!.id }],
                                            duration: 250,
                                            maxZoom: 1,
                                          });
                                        }}
                                      >
                                        {message}
                                      </button>
                                    ) : (
                                      message
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        )}
                        {build && (
                          <form
                            className="workflow-run-form"
                            noValidate
                            onSubmit={(e) => {
                              e.preventDefault();
                              void start();
                            }}
                          >
                            <h3>Test workflow</h3>
                            <label>
                              Run version
                              <select
                                disabled={activeRun}
                                value={versionId}
                                onChange={(e) => {
                                  setVersion(e.target.value);
                                  setRunInput("");
                                }}
                              >
                                <option value="">Saved draft</option>
                                {versions.data?.map((v) => (
                                  <option key={v.id} value={v.id}>
                                    Published v{v.version}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <WorkflowRunFields
                              key={`${draft.id}-${versionId}`}
                              fields={
                                (versionId
                                  ? versions.data?.find(
                                      (v) => v.id === versionId,
                                    )?.graph
                                  : draft.graph
                                )?.inputFields ?? []
                              }
                              value={runInput}
                              onChange={setRunInput}
                            />
                            <Button type="submit" disabled={busy || activeRun}>
                              Run workflow
                            </Button>
                          </form>
                        )}

                        <div className="workflow-run-list">
                          {runs.data?.map((r) => (
                            <Button
                              key={r.id}
                              className="secondary"
                              disabled={activeRun && r.id !== selectedRun}
                              onClick={() => setRun(r.id)}
                            >
                              Run {r.id.slice(0, 8)} · {r.status}
                              {r.schedule_id
                                ? " · Scheduled"
                                : r.api_trigger
                                  ? " · API"
                                  : ""}
                            </Button>
                          ))}
                        </div>
                        {run.error && (
                          <div>
                            <p className="error">{run.error.message}</p>
                            <Button
                              className="secondary"
                              onClick={() => void run.refetch()}
                            >
                              Retry run status
                            </Button>
                          </div>
                        )}
                        {run.data && (
                          <section
                            className="workflow-inspector"
                            aria-label="Workflow run inspector"
                          >
                            <h3>
                              Run inspector ·{" "}
                              <span data-testid="workflow-run-status">
                                {run.data.status}
                              </span>
                            </h3>
                            <label>
                              Inspect step
                              <select
                                value={
                                  run.data.graph_snapshot.nodes.some(
                                    (n) => n.id === selected,
                                  )
                                    ? selected
                                    : ""
                                }
                                onChange={(e) => {
                                  setSelected(e.target.value);
                                  setSelection([e.target.value]);
                                }}
                              >
                                <option value="">Select a canvas step</option>
                                {run.data.graph_snapshot.nodes.map((n) => (
                                  <option key={n.id} value={n.id}>
                                    {n.data.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                            {run.data.graph_snapshot.nodes.find(
                              (n) => n.id === selected,
                            ) && (
                              <WorkflowNodeInspector
                                node={run.data.graph_snapshot.nodes.find(
                                  (n) => n.id === selected,
                                )!}
                                trace={run.data.nodes.find(
                                  (n) => n.node_id === selected,
                                )}
                                tools={run.data.tools}
                              />
                            )}
                            {run.data.error_code && (
                              <p className="error">{run.data.error_code}</p>
                            )}
                            {build &&
                              ["queued", "running", "waiting"].includes(
                                run.data.status,
                              ) && (
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
                                  a.decision === "pending" &&
                                  run.data!.status === "waiting",
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
                                          onChange={(e) =>
                                            setComment(e.target.value)
                                          }
                                          maxLength={2000}
                                        />
                                      </label>
                                      <label>
                                        Edited input (optional JSON)
                                        <textarea
                                          value={edited}
                                          onChange={(e) =>
                                            setEdited(e.target.value)
                                          }
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
                                      An administrator or operator must approve
                                      this checkpoint.
                                    </p>
                                  )}
                                </div>
                              ))}
                            {run.data.status === "completed" && (
                              <div className="workflow-final-output">
                                <WorkflowResult
                                  output={run.data.output}
                                  title={
                                    run.data.graph_snapshot.nodes.find(
                                      (n) => n.type === "output",
                                    )?.data.resultTitle || "Final output"
                                  }
                                  summary={
                                    run.data.graph_snapshot.nodes.find(
                                      (n) => n.type === "output",
                                    )?.data.resultSummary
                                  }
                                  format={
                                    run.data.graph_snapshot.nodes.find(
                                      (n) => n.type === "output",
                                    )?.data.resultFormat
                                  }
                                />
                              </div>
                            )}
                            <details>
                              <summary>Execution details</summary>{" "}
                              <div className="workflow-node-traces">
                                {run.data.graph_snapshot.nodes.map((n) => {
                                  const trace = run.data!.nodes.find(
                                    (t) => t.node_id === n.id,
                                  );
                                  return (
                                    <details key={n.id}>
                                      <summary>
                                        {n.data.label} ·{" "}
                                        {trace?.status ?? "Not executed"}
                                        {trace?.duration_ms != null
                                          ? ` · ${trace.duration_ms} ms`
                                          : ""}
                                      </summary>
                                      {trace?.error_code && (
                                        <p className="error">
                                          {trace.error_code}
                                        </p>
                                      )}
                                      {trace && (
                                        <>
                                          <small>
                                            {n.type === "agent"
                                              ? `Reported tokens: ${trace.input_tokens ?? "unavailable"} input / ${trace.output_tokens ?? "unavailable"} output`
                                              : n.type}
                                          </small>
                                          {!!trace.attempts && (
                                            <p>
                                              {trace.attempts} attempt(s)
                                              {trace.retry_at
                                                ? " · Waiting to retry"
                                                : ""}
                                              . Token usage below covers
                                              successful completion;
                                              failed-attempt usage may be
                                              unavailable.
                                            </p>
                                          )}
                                          {!!trace.retry_history?.length && (
                                            <ul>
                                              {trace.retry_history.map(
                                                (a, i) => (
                                                  <li key={i}>
                                                    Attempt {a.attempt}:{" "}
                                                    {a.code} · {a.durationMs} ms
                                                    ·{" "}
                                                    {a.willRetry
                                                      ? "Retry scheduled"
                                                      : "Stopped"}
                                                  </li>
                                                ),
                                              )}
                                            </ul>
                                          )}
                                          <h4>Input</h4>
                                          <pre>{json(trace.input)}</pre>
                                          <h4>Output</h4>
                                          <pre>{json(trace.output)}</pre>
                                          <Citations
                                            sources={trace.citations ?? []}
                                          />
                                        </>
                                      )}
                                    </details>
                                  );
                                })}
                              </div>
                              <ToolTraces traces={run.data.tools} />
                            </details>
                          </section>
                        )}
                      </Panel>
                    )}
                    {error && expanded && !testOpen && (
                      <Panel
                        position="bottom-center"
                        className="canvas-error-panel"
                      >
                        <p role="alert">{error}</p>
                        <Button
                          className="secondary"
                          onClick={() => setError("")}
                        >
                          Dismiss error
                        </Button>
                      </Panel>
                    )}
                    <Background />
                    {!testOpen && <MiniMap pannable zoomable />}
                    <Controls />
                  </ReactFlow>
                </div>
                <aside
                  className="workflow-properties"
                  hidden={stage !== "build" || testOpen}
                >
                  <fieldset disabled={!canvasEditable}>
                    {current && !selectedRun ? (
                      <>
                        <h3>{current.type} configuration</h3>
                        <label>
                          Node label
                          <input
                            disabled={!build}
                            value={current.data.label}
                            onChange={(e) =>
                              updateNode({ label: e.target.value })
                            }
                            maxLength={100}
                          />
                        </label>
                        <div className="setting-label-row">
                          <span>Node details</span>
                          <HelpTooltip>Node ID: {current.id}</HelpTooltip>
                        </div>
                        <WorkflowNodeDepth
                          node={current}
                          onChange={updateNode}
                        />
                        {current.type === "input" && (
                          <WorkflowInputEditor
                            fields={draft.graph.inputFields}
                            disabled={!build || !canvasEditable}
                            onChange={(inputFields) =>
                              change({ ...draft.graph, inputFields })
                            }
                          />
                        )}
                        {current.type === "agent" && (
                          <>
                            <label>
                              Published agent version
                              <select
                                aria-label="Published agent version"
                                disabled={!build}
                                value={current.data.agentVersionId ?? ""}
                                onChange={(e) =>
                                  updateNode({
                                    agentVersionId: e.target.value || undefined,
                                  })
                                }
                              >
                                <option value="">
                                  Choose a published agent
                                </option>
                                {agents.data?.map((a) => (
                                  <option key={a.id} value={a.id}>
                                    {a.name} · v{a.version}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <details className="configure-group">
                              <summary>Advanced agent instructions</summary>{" "}
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
                            </details>{" "}
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
                                  setError(
                                    "Tool arguments must be valid JSON.",
                                  );
                                }
                              }}
                            >
                              Apply arguments
                            </Button>
                            <label>
                              Input argument name
                              <input
                                disabled={!!current.data.inputBindings?.length}
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
                            <div className="setting-label-row">
                              Branch connections
                              <HelpTooltip>
                                Connect both true and false handles. Expressions
                                are deterministic; no code is evaluated.
                              </HelpTooltip>
                            </div>
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
                          <WorkflowMappingEditor
                            key={current.id}
                            node={current}
                            graph={draft.graph}
                            runs={runs.data ?? []}
                            onChange={updateNode}
                          />
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
                        Select a node to configure it. Run snapshots are
                        read-only.
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
                      <li key={e}>
                        {draft.graph.nodes.filter((n) =>
                          e.startsWith(n.data.label + ":"),
                        ).length === 1 ? (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => {
                              const node = draft.graph.nodes.find((n) =>
                                e.startsWith(n.data.label + ":"),
                              );
                              if (node) {
                                setStage("build");
                                setSelected(node.id);
                                setSelection([node.id]);
                                canvas.current?.fitView({
                                  nodes: [{ id: node.id }],
                                  duration: 250,
                                  maxZoom: 1,
                                });
                              }
                            }}
                          >
                            {e}
                          </button>
                        ) : (
                          e
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="setting-label-row">
                Canvas shortcuts
                <HelpTooltip label="Workflow canvas help">
                  Drag nodes to arrange them; connect handles to change data
                  flow. Shift selects multiple nodes; Delete removes selection;
                  Ctrl/Cmd+C/V copies a selected node; Ctrl/Cmd+Z/Shift+Z
                  undo/redo. Parallel branches join at a Merge. One review gate
                  is supported per workflow.
                </HelpTooltip>
              </div>
            </div>
            {stage === "triggers" && draft.id && (
              <WorkflowTriggers
                key={draft.id}
                workflowId={draft.id}
                workspaceId={workspaceId}
                versions={versions.data ?? []}
                canManage={build}
              />
            )}
            <div hidden={stage !== "publish"}>
              <div className="publish-heading">
                <div>
                  <h3>Publish workflow</h3>
                  <p>
                    Publish a validated saved draft as an immutable version.
                  </p>
                </div>
                {build && (
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
                )}
              </div>
              {dirty && (
                <p className="error" role="status">
                  Save your changes before publishing.
                </p>
              )}
              {!!validation.length && (
                <p className="error">
                  {validation.length} configuration checks need attention.
                  Return to Build to resolve them.
                </p>
              )}
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
                              }>(
                                `/workflows/${draft.id}/restore/${v.id}`,
                                "POST",
                                {
                                  revision: draft.revision,
                                },
                              );
                              const next = {
                                ...draft,
                                name: v.name,
                                graph: workflowGraph.parse(v.graph),
                                revision: result.revision,
                              };
                              setDraft(next);
                              setSaved(JSON.stringify(next));
                              setNotice(
                                "Published graph restored to the draft.",
                              );
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
            </div>
          </>
        )}
      </div>
    </section>
  );
}
