import { z } from "zod";
import {
  pointerSegments,
  workflowFieldPath,
} from "@agentconnect/schemas/workflow-mapping";

export const workflowRoots = [
  "trigger",
  "input",
  "steps",
  "variables",
  "workflow",
  "error",
  "item",
  "iteration",
  "arguments",
] as const;
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
export const workflowIdentifier = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,47}$/)
  .refine(
    (v) => !forbidden.has(v) && !Object.hasOwn(Object.prototype, v),
    "Reserved identifier",
  );
export class WorkflowValueError extends Error {
  constructor(
    public readonly code:
      | "WORKFLOW_REFERENCE_INVALID"
      | "WORKFLOW_REFERENCE_MISSING"
      | "WORKFLOW_CONDITION_TYPE"
      | "WORKFLOW_VALUE_INVALID",
  ) {
    super(code);
  }
}
export function referenceSegments(path: string): string[] {
  if (
    path.length > 512 ||
    !/^(trigger|input|steps|variables|workflow|error|item|iteration|arguments)(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[(?:0|[1-9][0-9]{0,6})\])*$/.test(
      path,
    )
  )
    throw new WorkflowValueError("WORKFLOW_REFERENCE_INVALID");
  const segments = path.replace(/\[([0-9]+)\]/g, ".$1").split(".");
  if (segments.length > 20 || segments.some((p) => forbidden.has(p)))
    throw new WorkflowValueError("WORKFLOW_REFERENCE_INVALID");
  return segments;
}
// JSON received over HTTP has no accessors. Enforce that same boundary for in-process callers.
export function assertWorkflowValue(
  value: unknown,
  depth = 0,
  budget = { nodes: 0 },
): void {
  if (++budget.nodes > 10000 || depth > 32)
    throw new WorkflowValueError("WORKFLOW_VALUE_INVALID");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (
    !value ||
    typeof value !== "object" ||
    (!Array.isArray(value) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
  )
    throw new WorkflowValueError("WORKFLOW_VALUE_INVALID");
  for (const key of Object.keys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (forbidden.has(key) || !property || !("value" in property))
      throw new WorkflowValueError("WORKFLOW_VALUE_INVALID");
    assertWorkflowValue(property.value, depth + 1, budget);
  }
}
export const workflowJson = z
  .unknown()
  .superRefine((v, ctx) => {
    try {
      assertWorkflowValue(v);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Use bounded JSON without reserved properties",
      });
    }
  })
  .pipe(z.json());
export const workflowReference = z.strictObject({
  type: z.literal("reference"),
  path: z
    .string()
    .max(512)
    .refine((v) => {
      try {
        referenceSegments(v);
        return true;
      } catch {
        return false;
      }
    }, "Use a safe workflow reference"),
  // Optional JSON Pointer supports legacy field names with spaces, dots or slashes.
  pointer: workflowFieldPath.optional(),
});
export const workflowExpression = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("literal"), value: workflowJson }),
  workflowReference,
]);
export type WorkflowExpression = z.infer<typeof workflowExpression>;
export type WorkflowDataContext = Record<
  Exclude<(typeof workflowRoots)[number], "item" | "iteration" | "arguments">,
  unknown
> & { item?: unknown; iteration?: unknown; arguments?: unknown };
function ownPath(value: unknown, segments: string[]) {
  let current = value;
  for (const segment of segments) {
    if (
      forbidden.has(segment) ||
      current === null ||
      typeof current !== "object" ||
      (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/.test(segment))
    )
      throw new WorkflowValueError("WORKFLOW_REFERENCE_MISSING");
    const property = Object.getOwnPropertyDescriptor(current, segment);
    if (!property || !("value" in property))
      throw new WorkflowValueError("WORKFLOW_REFERENCE_MISSING");
    current = property.value;
  }
  if (current === undefined)
    throw new WorkflowValueError("WORKFLOW_REFERENCE_MISSING");
  return current;
}
export function resolveWorkflowExpression(
  expression: WorkflowExpression,
  context: WorkflowDataContext,
): unknown {
  const parsed = workflowExpression.parse(expression);
  if (parsed.type === "literal") return parsed.value;
  let result = ownPath(context, referenceSegments(parsed.path));
  if (parsed.pointer !== undefined) {
    const parts = pointerSegments(parsed.pointer);
    if (parts.length && typeof result === "string") {
      try {
        result = JSON.parse(result);
      } catch {
        throw new WorkflowValueError("WORKFLOW_REFERENCE_MISSING");
      }
    }
    result = ownPath(result, parts);
  }
  assertWorkflowValue(result);
  return result;
}
export const workflowConditionOperators = [
  "equals",
  "not-equals",
  "contains",
  "not-contains",
  "greater-than",
  "greater-than-or-equal",
  "less-than",
  "less-than-or-equal",
  "empty",
  "not-empty",
  "true",
  "false",
] as const;
const unary = new Set(["empty", "not-empty", "true", "false"]);
export const workflowCondition = z
  .strictObject({
    operator: z.enum(workflowConditionOperators),
    left: workflowExpression,
    right: workflowExpression.optional(),
  })
  .superRefine((v, ctx) => {
    if (unary.has(v.operator) ? v.right !== undefined : v.right === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["right"],
        message: unary.has(v.operator)
          ? "This operator uses only one value"
          : "Select a right-hand value",
      });
  });
export type WorkflowCondition = z.infer<typeof workflowCondition>;
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    !a ||
    !b ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const ak = Object.keys(a),
    bk = Object.keys(b);
  return (
    ak.length === bk.length &&
    ak.every(
      (k) =>
        Object.hasOwn(b, k) &&
        equal(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
    )
  );
}
export function evaluateWorkflowCondition(
  condition: WorkflowCondition,
  context: WorkflowDataContext,
): boolean {
  const c = workflowCondition.parse(condition),
    a = resolveWorkflowExpression(c.left, context),
    b = c.right ? resolveWorkflowExpression(c.right, context) : undefined;
  const empty =
    a === null ||
    a === "" ||
    (Array.isArray(a) && a.length === 0) ||
    (!!a && typeof a === "object" && Object.keys(a).length === 0);
  switch (c.operator) {
    case "equals":
      return equal(a, b);
    case "not-equals":
      return !equal(a, b);
    case "empty":
      return empty;
    case "not-empty":
      return !empty;
    case "true":
    case "false":
      if (typeof a !== "boolean")
        throw new WorkflowValueError("WORKFLOW_CONDITION_TYPE");
      return c.operator === "true" ? a : !a;
    case "contains":
    case "not-contains": {
      if (
        !(typeof a === "string" && typeof b === "string") &&
        !Array.isArray(a)
      )
        throw new WorkflowValueError("WORKFLOW_CONDITION_TYPE");
      const contains = Array.isArray(a)
        ? a.some((v) => equal(v, b))
        : (a as string).includes(b as string);
      return c.operator === "contains" ? contains : !contains;
    }
    default:
      if (typeof a !== "number" || typeof b !== "number")
        throw new WorkflowValueError("WORKFLOW_CONDITION_TYPE");
      if (c.operator === "greater-than") return a > b;
      if (c.operator === "greater-than-or-equal") return a >= b;
      if (c.operator === "less-than") return a < b;
      return a <= b;
  }
}
