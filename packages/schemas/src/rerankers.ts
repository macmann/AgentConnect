import { z } from "zod";
export const rerankerInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    provider: z.enum(["llm", "cohere"]),
    modelConfigurationId: z.uuid().nullable().default(null),
    modelId: z.string().trim().max(150).default("rerank-v3.5"),
    baseUrl: z.url().max(500).default("https://api.cohere.com"),
    secretId: z.uuid().nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .superRefine((v, c) => {
    if (v.provider === "llm" && (!v.modelConfigurationId || v.secretId))
      c.addIssue({
        code: "custom",
        path: ["modelConfigurationId"],
        message: "Choose an approved workspace chat model",
      });
    if (
      v.provider === "cohere" &&
      (!v.secretId || !v.modelId || v.modelConfigurationId)
    )
      c.addIssue({
        code: "custom",
        path: ["secretId"],
        message:
          "Choose a workspace Cohere credential and exact rerank model identifier",
      });
  });
export const rerankerUpdate = rerankerInput.safeExtend({
  revision: z.number().int().positive(),
});
