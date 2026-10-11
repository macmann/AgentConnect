export type WorkflowPresentation = {
  kind: "text" | "fields" | "table" | "json";
  text?: string;
  fields?: { label: string; value: string }[];
  columns?: string[];
  rows?: Record<string, unknown>[];
  truncated?: boolean;
};
export const workflowValue = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
export const workflowFieldLabel = (key: string) =>
  key
    .replace(/[_-]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
export function workflowPresentation(
  output: unknown,
  format: "auto" | "text" | "json" = "auto",
): WorkflowPresentation {
  if (format === "text") return { kind: "text", text: workflowValue(output) };
  if (format === "json") return { kind: "json", text: workflowValue(output) };
  let value = output;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { kind: "text", text: workflowValue(value) };
    }
  }
  if (
    Array.isArray(value) &&
    value.length &&
    value.every((v) => v && typeof v === "object" && !Array.isArray(v))
  ) {
    const columns = [...new Set(value.flatMap((v) => Object.keys(v)))];
    if (columns.length <= 20)
      return {
        kind: "table",
        columns,
        rows: value.slice(0, 100),
        truncated: value.length > 100,
      };
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length <= 30
  )
    return {
      kind: "fields",
      fields: Object.entries(value).map(([key, v]) => ({
        label: workflowFieldLabel(key),
        value: workflowValue(v),
      })),
    };
  return {
    kind: typeof value === "string" ? "text" : "json",
    text: workflowValue(value),
  };
}
