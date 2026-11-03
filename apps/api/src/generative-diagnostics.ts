import { responseEnvelope } from "@agentconnect/schemas/generative";
import {
  ProviderError,
  type ResponseValidationDiagnostics,
} from "@agentconnect/provider-sdk";
export function responseValidation(
  text: string,
  stage: ResponseValidationDiagnostics["stage"],
): ResponseValidationDiagnostics {
  const start = text.trimStart();
  return {
    stage,
    outputCharacters: text.length,
    format: start.startsWith("```")
      ? "code_fence"
      : start.startsWith("{")
        ? "object"
        : start.startsWith("[")
          ? "array"
          : "other",
  };
}
export function parseGenerativeResponse(
  text: string,
  allowedBlocks: readonly string[],
) {
  let stage: ResponseValidationDiagnostics["stage"] = "json";
  try {
    const json: unknown = JSON.parse(text);
    stage = "schema";
    const parsed = responseEnvelope.safeParse(json);
    if (!parsed.success)
      throw new ProviderError("INVALID_UI_RESPONSE", false, undefined, {
        responseValidation: {
          ...responseValidation(text, stage),
          issueCodes: [
            ...new Set(parsed.error.issues.map((i) => i.code)),
          ].slice(0, 10),
        },
      });
    stage = "allowed_blocks";
    if (parsed.data.blocks.some((b) => !allowedBlocks.includes(b.type)))
      throw new Error("Unsupported block");
    return parsed.data;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("INVALID_UI_RESPONSE", false, undefined, {
      responseValidation: responseValidation(text, stage),
    });
  }
}
