import { Ajv } from "ajv";
import { actionJsonSchema } from "@agentconnect/schemas/workflow-actions";
import { ToolError } from "./tool-runtime.js";
export function schemaValidator(schema: Record<string, unknown>) {
  actionJsonSchema.parse(schema);
  let count = 0;
  const walk = (v: unknown, depth: number): void => {
    if (++count > 500 || depth > 12)
      throw new ToolError("ACTION_SCHEMA_UNSUPPORTED");
    if (v && typeof v === "object")
      for (const [key, value] of Object.entries(v)) {
        if (
          [
            "$ref",
            "$dynamicRef",
            "pattern",
            "patternProperties",
            "$id",
          ].includes(key)
        )
          throw new ToolError("ACTION_SCHEMA_UNSUPPORTED");
        if (key === "format" && typeof value === "string" && value !== "date")
          throw new ToolError("ACTION_SCHEMA_UNSUPPORTED");
        walk(value, depth + 1);
      }
  };
  walk(schema, 0);
  try {
    return new Ajv({ strict: false, validateFormats: true })
      .addFormat("date", {
        type: "string",
        validate: (v: string) =>
          /^\d{4}-\d{2}-\d{2}$/.test(v) &&
          !Number.isNaN(Date.parse(v)) &&
          new Date(v).toISOString().slice(0, 10) === v,
      })
      .compile(schema);
  } catch {
    throw new ToolError("ACTION_SCHEMA_UNSUPPORTED");
  }
}
