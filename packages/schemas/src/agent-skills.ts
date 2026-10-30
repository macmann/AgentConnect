import { z } from "zod";
export const agentSkills = z
  .object({
    versionIds: z.array(z.uuid()).max(5).default([]),
    usageMode: z.enum(["always", "automatic", "disabled"]).default("always"),
    usageInstructions: z.string().trim().max(2000).default(""),
    contextBudget: z.number().int().min(256).max(12000).default(6000),
  })
  .default({
    versionIds: [],
    usageMode: "always",
    usageInstructions: "",
    contextBudget: 6000,
  });
export const skillUpdate = z.object({
  enabled: z.boolean(),
  publicAccess: z.boolean(),
  revision: z.number().int().positive(),
});
export type AgentSkills = z.infer<typeof agentSkills>;
