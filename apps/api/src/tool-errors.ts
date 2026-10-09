export class ToolError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
