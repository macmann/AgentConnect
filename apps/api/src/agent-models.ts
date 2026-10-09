import { z } from "zod";
import { modelInput, type AgentConfig } from "@agentconnect/schemas/agents";
import type { ModelConnection } from "@agentconnect/provider-sdk";
import { sql } from "./db.js";
import { decrypt } from "./security.js";
import { HttpError } from "./http-error.js";
export const modelSnapshotSchema = z.object({
  id: z.uuid(),
  provider: modelInput.shape.provider,
  modelId: z.string(),
  baseUrl: z.url(),
  secretId: z.uuid().nullable(),
  capabilities: modelInput.shape.capabilities,
  contextWindow: z.number(),
  maxOutputTokens: z.number(),
});
export type ModelSnapshot = z.infer<typeof modelSnapshotSchema>;
export async function connection(
  model: ModelSnapshot,
  workspaceId: string,
  orgId: string,
): Promise<ModelConnection> {
  let apiKey: string | undefined;
  if (model.secretId) {
    const [s] =
      await sql`SELECT name,ciphertext FROM secrets WHERE id=${model.secretId} AND workspace_id=${workspaceId} AND organization_id=${orgId}`;
    if (!s) throw new HttpError(409, "Model credential is no longer available");
    try {
      apiKey = decrypt(s.ciphertext, `${orgId}:${workspaceId}:${s.name}`);
    } catch {
      throw new HttpError(
        409,
        "Stored model credential cannot be decrypted. Ensure the API and worker use the MASTER_KEY that encrypted it; recreate the secret if that key was lost.",
      );
    }
  }
  if (!apiKey && model.provider !== "openai-compatible")
    throw new HttpError(409, "Configure a workspace secret for this model");
  return { ...model, apiKey };
}
export function validateAgentModel(c: AgentConfig, m: ModelSnapshot) {
  if (c.maxOutputTokens > m.maxOutputTokens)
    throw new HttpError(400, "Agent output limit exceeds the model limit");
  if (c.maxOutputTokens >= m.contextWindow)
    throw new HttpError(
      400,
      "Output limit must fit in the model context window",
    );
}
