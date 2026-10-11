import {
  workflowGraph,
  type WorkflowGraph,
} from "@agentconnect/schemas/workflows";
const node = (id: string, type: string, label: string, x: number, y = 100) => ({
  id,
  type,
  position: { x, y },
  data: { label },
});
const edge = (source: string, target: string) => ({
  id: source + "_" + target,
  source,
  target,
});
export const workflowTemplates = [
  {
    id: "assisted-answer",
    name: "Assisted answer",
    description: "A published agent prepares an answer from customer input.",
    nodes: [
      node("input", "input", "Customer request", 0),
      node("answer", "agent", "Prepare answer", 250),
      node("output", "output", "Answer", 500),
    ],
    edges: [edge("input", "answer"), edge("answer", "output")],
  },
  {
    id: "reviewed-answer",
    name: "Reviewed answer",
    description:
      "An agent prepares an answer and staff approve it before release.",
    nodes: [
      node("input", "input", "Customer request", 0),
      node("answer", "agent", "Prepare answer", 250),
      node("review", "approval", "Staff review", 500),
      node("output", "output", "Approved answer", 750),
    ],
    edges: [
      edge("input", "answer"),
      edge("answer", "review"),
      edge("review", "output"),
    ],
  },
  {
    id: "parallel-research",
    name: "Parallel research",
    description:
      "Two agents research independently; a synthesis agent combines their findings.",
    nodes: [
      node("input", "input", "Customer request", 0),
      node("parallel", "parallel", "Research in parallel", 250),
      node("research_a", "agent", "First perspective", 500, 0),
      node("research_b", "agent", "Second perspective", 500, 200),
      node("merge", "merge", "Collect findings", 750),
      node("synthesis", "agent", "Combine findings", 1000),
      node("output", "output", "Combined answer", 1250),
    ],
    edges: [
      edge("input", "parallel"),
      edge("parallel", "research_a"),
      edge("parallel", "research_b"),
      edge("research_a", "merge"),
      edge("research_b", "merge"),
      edge("merge", "synthesis"),
      edge("synthesis", "output"),
    ],
  },
];
export function workflowFromTemplate(
  id: string,
  agentVersionId?: string,
): WorkflowGraph {
  const template = workflowTemplates.find((t) => t.id === id);
  if (!template) throw new Error("Unknown workflow template");
  return workflowGraph.parse({
    nodes: template.nodes.map((n) => ({
      ...n,
      data: {
        ...n.data,
        ...(n.type === "agent" && agentVersionId ? { agentVersionId } : {}),
        ...(n.type === "output" ? { resultTitle: template.name } : {}),
      },
    })),
    edges: template.edges,
  });
}
