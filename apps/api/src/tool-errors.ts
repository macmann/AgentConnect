import type { ToolPlanDiagnostic } from "./tool-planning.js";
export class ToolError extends Error {
  constructor(
    public code: string,
    public retryable = false,
    public planning?: ToolPlanDiagnostic,
  ) {
    super(code);
  }
}
