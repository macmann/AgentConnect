import { z } from "zod";
export const example = z
  .object({
    id: z.uuid().default(() => globalThis.crypto.randomUUID()),
    input: z.string().trim().min(1).max(12000),
    expectedBehavior: z.string().trim().min(1).max(2000),
    expectedAnswer: z.string().trim().min(1).max(16000).optional(),
    contains: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
    forbidden: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
    expectedSourceIds: z.array(z.uuid()).max(20).default([]),
    tags: z.array(z.string().min(1).max(40)).max(10).default([]),
    metadata: z
      .record(z.string().max(80), z.string().max(500))
      .refine((v) => Object.keys(v).length <= 20, "At most 20 metadata entries")
      .default({}),
  })
  .strict();
export const datasetInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000).default(""),
    examples: z.array(example).max(100).default([]),
  })
  .strict()
  .superRefine((d, c) => {
    if (new Set(d.examples.map((e) => e.id)).size !== d.examples.length)
      c.addIssue({ code: "custom", message: "Example IDs must be unique" });
  });
export const evaluator = z
  .object({
    mode: z.enum(["deterministic", "judge"]).default("deterministic"),
    judgeModelId: z.uuid().optional(),
    minScore: z.number().min(0).max(1).default(0.8),
    maxLatencyMs: z.number().int().min(1).max(90000).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.mode === "judge" && !v.judgeModelId)
      c.addIssue({ code: "custom", message: "Select a judge model" });
  });
export const runInput = z
  .object({
    agentId: z.uuid(),
    datasetId: z.uuid(),
    revision: z.number().int().positive(),
    baselineRunId: z.uuid().optional(),
    evaluator,
  })
  .strict();
export const gateInput = z
  .object({
    enabled: z.boolean(),
    datasetId: z.uuid().nullable(),
    minPassRate: z.number().min(0).max(1).default(1),
    evaluator,
  })
  .strict()
  .superRefine((v, c) => {
    if (v.enabled && !v.datasetId)
      c.addIssue({ code: "custom", message: "Select a gate dataset" });
  });
export const judgeResult = z
  .object({
    correctness: z.number().min(0).max(1),
    relevance: z.number().min(0).max(1),
    groundedness: z.number().min(0).max(1),
    policyCompliance: z.number().min(0).max(1),
    reason: z.string().max(1000),
  })
  .strict();
export type Example = z.infer<typeof example>;
export type Evaluator = z.infer<typeof evaluator>;
export function deterministicScore(
  e: Example,
  output: string,
  sourceIds: string[],
) {
  const normalize = (s: string) =>
    s.trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
  const text = normalize(output),
    checks: boolean[] = [];
  if (e.expectedAnswer !== undefined)
    checks.push(text === normalize(e.expectedAnswer));
  for (const v of e.contains) checks.push(text.includes(normalize(v)));
  for (const v of e.forbidden) checks.push(!text.includes(normalize(v)));
  const recall = e.expectedSourceIds.length
    ? e.expectedSourceIds.filter((id) => sourceIds.includes(id)).length /
      e.expectedSourceIds.length
    : null;
  if (recall !== null) checks.push(recall === 1);
  return {
    score: checks.length ? checks.filter(Boolean).length / checks.length : null,
    retrievalRecall: recall,
  };
}
