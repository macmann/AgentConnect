import { z } from "zod";
import type { WorkflowGraph, WorkflowNode } from "./workflows.js";
const reserved = new Set(["__proto__", "constructor", "prototype"]);
export function pointerSegments(path: string): string[] {
  if (path === "") return [];
  if (path.length > 512 || !path.startsWith("/") || /~(?![01])/u.test(path))
    throw new WorkflowMappingError("WORKFLOW_MAPPING_PATH_INVALID");
  const parts = path
    .slice(1)
    .split("/")
    .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (parts.length > 20 || parts.some((p) => reserved.has(p)))
    throw new WorkflowMappingError("WORKFLOW_MAPPING_PATH_INVALID");
  return parts;
}
export const workflowFieldPath = z
  .string()
  .max(512)
  .refine((path) => {
    try {
      pointerSegments(path);
      return true;
    } catch {
      return false;
    }
  }, "Use a JSON Pointer such as /customer/name or /items/0/title; blank selects the complete value");
export const workflowBinding = z.object({
  target: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
    .refine((v) => !reserved.has(v), "Reserved target name"),
  source: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,47}$/),
  path: workflowFieldPath.default(""),
});
export class WorkflowMappingError extends Error {
  constructor(
    public readonly code:
      | "WORKFLOW_MAPPING_UNAVAILABLE"
      | "WORKFLOW_MAPPING_FIELD_MISSING"
      | "WORKFLOW_MAPPING_PATH_INVALID"
      | "WORKFLOW_MAPPING_NOT_STRUCTURED",
  ) {
    super(code);
  }
}
export function selectWorkflowField(value: unknown, path = ""): unknown {
  const parts = pointerSegments(path);
  if (!parts.length) return value;
  let current = value;
  if (typeof current === "string") {
    try {
      current = JSON.parse(current);
    } catch {
      throw new WorkflowMappingError("WORKFLOW_MAPPING_NOT_STRUCTURED");
    }
  }
  for (const part of parts) {
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, part) ||
      (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/.test(part))
    )
      throw new WorkflowMappingError("WORKFLOW_MAPPING_FIELD_MISSING");
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
export function workflowAncestors(graph: WorkflowGraph, nodeId: string) {
  const result = new Set<string>(),
    queue = graph.edges.filter((e) => e.target === nodeId).map((e) => e.source);
  while (queue.length) {
    const id = queue.pop()!;
    if (result.has(id) || id === nodeId) continue;
    result.add(id);
    queue.push(
      ...graph.edges.filter((e) => e.target === id).map((e) => e.source),
    );
  }
  return result;
}
export function resolveWorkflowMapping(
  node: WorkflowNode,
  graph: WorkflowGraph,
  outputs: Record<string, unknown>,
): unknown {
  const from = (id: string) => {
    if (!Object.hasOwn(outputs, id))
      throw new WorkflowMappingError("WORKFLOW_MAPPING_UNAVAILABLE");
    return outputs[id];
  };
  if (node.data.inputBindings?.length) {
    return Object.fromEntries(
      node.data.inputBindings.map((b) => [
        b.target,
        selectWorkflowField(from(b.source), b.path),
      ]),
    );
  }
  if (node.data.inputFrom)
    return selectWorkflowField(from(node.data.inputFrom), node.data.inputPath);
  const entries = graph.edges
    .filter((e) => e.target === node.id && Object.hasOwn(outputs, e.source))
    .map((e) => [e.source, outputs[e.source]] as const);
  if (!entries.length)
    throw new WorkflowMappingError("WORKFLOW_MAPPING_UNAVAILABLE");
  return selectWorkflowField(
    node.type === "merge" ? Object.fromEntries(entries) : entries[0]![1],
    node.data.inputPath,
  );
}
export function workflowToolArguments(node: WorkflowNode, input: unknown) {
  return {
    ...node.data.toolArguments,
    ...(node.data.inputBindings?.length
      ? (input as Record<string, unknown>)
      : node.data.inputArgument
        ? {
            [node.data.inputArgument]:
              typeof input === "string" ? input : JSON.stringify(input),
          }
        : {}),
  };
}
export function workflowFieldOptions(
  value: unknown,
): { path: string; type: string }[] {
  let root = value;
  if (typeof root === "string") {
    try {
      root = JSON.parse(root);
    } catch {
      return [];
    }
  }
  const options: { path: string; type: string }[] = [];
  function visit(current: unknown, path: string, depth: number) {
    if (depth > 8 || options.length >= 150) return;
    if (path)
      options.push({
        path,
        type:
          current === null
            ? "null"
            : Array.isArray(current)
              ? "array"
              : typeof current,
      });
    if (current && typeof current === "object")
      for (const key of Object.keys(current).slice(0, 40)) {
        if (reserved.has(key)) continue;
        const next =
          path + "/" + key.replaceAll("~", "~0").replaceAll("/", "~1");
        if (next.length <= 512)
          visit((current as Record<string, unknown>)[key], next, depth + 1);
      }
  }
  visit(root, "", 0);
  return options;
}
