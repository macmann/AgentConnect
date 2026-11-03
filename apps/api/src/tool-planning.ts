import type { ValidateFunction } from "ajv";
export type ToolPlanReason =
  | "invalid_json"
  | "invalid_envelope"
  | "too_many_calls"
  | "invalid_call_shape"
  | "unknown_tool"
  | "invalid_arguments"
  | "arguments_size"
  | "arguments_schema"
  | "plan_size"
  | "provider_error"
  | "json_mode_unsupported";
export type ToolPlanDiagnostic = {
  stage: "tool_planning";
  status: "validated" | "rejected";
  reason?: ToolPlanReason;
  attempt: number;
  maxAttempts: number;
  willRetry: boolean;
  availableTools: number;
  maxCalls: number;
  maxOutputTokens: number;
  jsonMode: boolean;
  planCharacters: number;
  planBytes: number;
  fencedJson: boolean;
  jsonStart: "object" | "array" | "fence" | "other" | "empty";
  plannedCalls?: number;
  invalidCallIndex?: number;
  issueKeywords?: string[];
  inputTokens: number | null;
  outputTokens: number | null;
  outputLimitReached: boolean | null;
  durationMs: number;
};
export class ToolPlanValidationError extends Error {
  constructor(
    public reason: ToolPlanReason,
    public callIndex?: number,
    public issueKeywords?: string[],
  ) {
    super(reason);
  }
}
export type PlannedCall = {
  toolId: string;
  arguments: Record<string, unknown>;
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function unwrapToolPlan(text: string) {
  const trimmed = text.trim(),
    match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return { text: match ? match[1]! : trimmed, fenced: !!match };
}
/** Formatting normalization only. Never extract embedded prose, guess IDs or coerce arguments. */
export function parseToolPlan(
  text: string,
  tools: { id: string; input_schema: Record<string, unknown> }[],
  maxCalls: number,
  validator: (schema: Record<string, unknown>) => ValidateFunction,
): PlannedCall[] {
  if (Buffer.byteLength(text) > 16000)
    throw new ToolPlanValidationError("plan_size");
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapToolPlan(text).text);
  } catch {
    throw new ToolPlanValidationError("invalid_json");
  }
  if (
    !object(parsed) ||
    Object.keys(parsed).join() !== "calls" ||
    !Array.isArray(parsed.calls)
  )
    throw new ToolPlanValidationError("invalid_envelope");
  if (parsed.calls.length > maxCalls)
    throw new ToolPlanValidationError("too_many_calls");
  const calls: PlannedCall[] = [];
  for (const [index, call] of parsed.calls.entries()) {
    if (!object(call) || Object.keys(call).sort().join() !== "arguments,toolId")
      throw new ToolPlanValidationError("invalid_call_shape", index);
    const tool = tools.find((t) => t.id === call.toolId);
    if (!tool) throw new ToolPlanValidationError("unknown_tool", index);
    if (!object(call.arguments))
      throw new ToolPlanValidationError("invalid_arguments", index);
    if (Buffer.byteLength(JSON.stringify(call.arguments)) > 8000)
      throw new ToolPlanValidationError("arguments_size", index);
    const validate = validator(tool.input_schema);
    if (!validate(call.arguments))
      throw new ToolPlanValidationError(
        "arguments_schema",
        index,
        [
          ...new Set(
            (validate.errors ?? [])
              .map((e) => e.keyword)
              .filter((k) =>
                [
                  "type",
                  "required",
                  "additionalProperties",
                  "enum",
                  "const",
                  "minimum",
                  "maximum",
                  "minLength",
                  "maxLength",
                  "minItems",
                  "maxItems",
                  "anyOf",
                  "oneOf",
                  "allOf",
                  "multipleOf",
                  "uniqueItems",
                ].includes(k),
              ),
          ),
        ].slice(0, 8),
      );
    calls.push({ toolId: tool.id, arguments: call.arguments });
  }
  return calls;
}
