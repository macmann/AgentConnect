import { z } from "zod";
const days = z.number().int().min(1).max(36500).nullable();
export const retentionInput = z
  .object({
    enabled: z.boolean(),
    revision: z.number().int().min(0),
    conversationDays: days,
    runDays: days,
    artifactDays: days,
    connectorDays: days,
  })
  .strict()
  .refine(
    (p) =>
      !p.enabled ||
      [p.conversationDays, p.runDays, p.artifactDays, p.connectorDays].some(
        (d) => d !== null,
      ),
    {
      message: "Set at least one retention period before enabling cleanup",
    },
  );
export const retentionRequest = z
  .object({ revision: z.number().int().min(1) })
  .strict();
