import { z } from "zod";
import { stdioSettings } from "@agentconnect/schemas/tools";
import { config } from "./config.js";
import { ToolError } from "./tool-errors.js";
export function stdioProfiles() {
  try {
    return z
      .array(stdioSettings)
      .max(30)
      .parse(JSON.parse(config.TOOL_STDIO_PROFILES));
  } catch {
    throw new ToolError("MCP_STDIO_PROFILES_INVALID");
  }
}
export function validateStdio(value: unknown) {
  const settings = stdioSettings.parse(value);
  const match = stdioProfiles().find(
    (p) =>
      p.command === settings.command &&
      JSON.stringify(p.args) === JSON.stringify(settings.args) &&
      p.credentialEnv === settings.credentialEnv,
  );
  if (!match) throw new ToolError("MCP_STDIO_COMMAND_NOT_APPROVED");
  return match;
}
