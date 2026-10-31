import type { WorkflowDefinitionV2 } from "@agentconnect/schemas/workflow-v2";
import {
  referenceSegments,
  type WorkflowExpression,
} from "@agentconnect/schemas/workflow-values";
type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  required?: string[];
  additionalProperties?: boolean;
};
// Best-effort design-time checking of known schemas. Runtime remains authoritative for dynamic resources.
export function validateV2Mappings(
  execution: WorkflowDefinitionV2["execution"],
): string[] {
  const errors: string[] = [];
  const input: Schema | undefined = execution.inputFields.length
    ? {
        type: "object",
        properties: Object.fromEntries(
          execution.inputFields.map((f) => [
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
        additionalProperties: false,
      }
    : undefined;
  const literalSchema = (value: unknown): Schema =>
    Array.isArray(value)
      ? { type: "array" }
      : value !== null && typeof value === "object"
        ? {
            type: "object",
            properties: Object.fromEntries(
              Object.entries(value).map(([key, v]) => [key, literalSchema(v)]),
            ),
          }
        : { type: value === null ? "null" : typeof value };
  const infer = (
    expression: WorkflowExpression,
    nodeId: string,
  ): Schema | undefined => {
    if (expression.type === "literal") return literalSchema(expression.value);
    const parts = referenceSegments(expression.path);
    let schema: Schema | undefined, rest: string[];
    if (parts[0] === "input") {
      schema = input;
      rest = parts.slice(1);
    } else if (parts[0] === "trigger" && parts[1] === "body") {
      schema = input;
      rest = parts.slice(2);
    } else if (parts[0] === "steps") {
      const source = execution.nodes.find((n) => n.id === parts[1]);
      if (source?.kind === "structured-ai" || source?.kind === "human-task")
        schema = source.config.outputSchema as Schema;
      if (source?.kind === "action")
        schema = execution.actions.find((a) => a.id === source.config.actionId)
          ?.outputSchema as Schema;
      if (source?.kind === "wait-for-event")
        schema = source.config.outputSchema as Schema;
      if (source?.kind === "for-each")
        schema =
          parts[2] === "summary"
            ? {
                type: "object",
                properties: {
                  total: { type: "number" },
                  completed: { type: "number" },
                  failed: { type: "number" },
                },
                additionalProperties: false,
              }
            : { type: "array", items: { type: "object" } };
      if (source?.kind === "input") schema = input;
      if (source?.kind === "transform")
        schema = {
          type: "object",
          properties: Object.fromEntries(
            Object.keys(source.config.fields).map((key) => [key, {}]),
          ),
          additionalProperties: false,
        };
      rest = parts.slice(3);
    } else return undefined;
    if (expression.pointer !== undefined) return undefined; // Legacy JSON Pointer can also parse string JSON.
    for (const part of rest) {
      if (!schema) break;
      if (schema.type === "array") {
        if (!/^\d+$/.test(part))
          errors.push(`${nodeId}: array mapping requires an index`);
        schema = schema.items;
      } else if (schema.type === "object" || schema.properties) {
        if (
          !Object.hasOwn(schema.properties ?? {}, part) &&
          schema.additionalProperties === false
        )
          errors.push(
            `${nodeId}: field '${part}' is absent from the selected output schema`,
          );
        schema = schema.properties?.[part];
      } else if (schema.type) {
        errors.push(`${nodeId}: cannot select '${part}' from ${schema.type}`);
        schema = undefined;
      } else schema = undefined;
    }
    return schema;
  };
  const checkType = (
    expression: WorkflowExpression,
    expected: Schema | undefined,
    id: string,
  ) => {
    const actual = infer(expression, id);
    if (actual?.type && expected?.type && actual.type !== expected.type)
      errors.push(
        `${id}: mapping requires ${expected.type}, received ${actual.type}`,
      );
  };
  for (const node of execution.nodes) {
    if ("input" in node.config && node.config.input)
      infer(node.config.input, node.id);
    if (node.kind === "for-each") {
      const type = infer(node.config.collection, node.id)?.type;
      if (type && type !== "array")
        errors.push(`${node.id}: For Each requires an array`);
      Object.values(node.config.itemInputs).forEach((value) =>
        infer(value, node.id),
      );
    }
    if (node.kind === "wait" && node.config.until)
      checkType(node.config.until, { type: "string" }, node.id);
    if (node.kind === "transform")
      Object.values(node.config.fields).forEach((value) =>
        infer(value, node.id),
      );
    if (node.kind === "set-variable" || node.kind === "switch")
      infer(node.config.value, node.id);
    if (node.kind === "condition") {
      const c = node.config.condition,
        left = infer(c.left, node.id),
        right = c.right ? infer(c.right, node.id) : undefined;
      if (
        [
          "greater-than",
          "greater-than-or-equal",
          "less-than",
          "less-than-or-equal",
        ].includes(c.operator) &&
        ((left?.type && left.type !== "number") ||
          (right?.type && right.type !== "number"))
      )
        errors.push(`${node.id}: numeric comparison requires numbers`);
      if (
        ["contains", "not-contains"].includes(c.operator) &&
        ((left?.type && !["string", "array"].includes(left.type)) ||
          (left?.type === "string" && right?.type && right.type !== "string"))
      )
        errors.push(`${node.id}: contains requires text/text or an array`);
      if (
        ["true", "false"].includes(c.operator) &&
        left?.type &&
        left.type !== "boolean"
      )
        errors.push(`${node.id}: boolean comparison requires a boolean`);
    }
    if (node.kind === "action") {
      const action = execution.actions.find(
        (a) => a.id === node.config.actionId,
      );
      if (!action) continue;
      const schema = action.inputSchema as Schema;
      const mapped = { ...action.mappedInputs, ...node.config.inputs };
      for (const field of schema.required ?? [])
        if (
          !(action.idempotency === "key" && field === action.idempotencyArgument) &&
          !Object.hasOwn(mapped, field) &&
          !Object.hasOwn(action.staticInputs, field)
        )
          errors.push(
            `${node.id}: required Action input '${field}' is missing`,
          );
      for (const [key, value] of Object.entries({
        ...Object.fromEntries(
          Object.entries(action.staticInputs).map(([k, value]) => [
            k,
            { type: "literal" as const, value },
          ]),
        ),
        ...mapped,
      })) {
        if (
          schema.additionalProperties === false &&
          !Object.hasOwn(schema.properties ?? {}, key)
        )
          errors.push(`${node.id}: unknown Action input '${key}'`);
        checkType(value, schema.properties?.[key], node.id);
      }
    }
  }
  return [...new Set(errors)];
}
