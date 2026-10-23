import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { selectEvidence } from "@agentconnect/rag/answer-source-policy";
import { groundedPrompt, type Citation } from "@agentconnect/rag/tool";
import { agentConfig } from "@agentconnect/schemas/agents";
import { enhancedRetrieval } from "../src/rag-enhancements.js";

const policy = {
  answerSourcePolicy: "prefer_approved_qa" as const,
  qaMinScore: 0.75,
};
function source(
  id: number,
  qa = false,
  approved = false,
  similarity = 0.9,
): Citation {
  return {
    id,
    chunkId: String(id),
    documentId: randomUUID(),
    sourceId: randomUUID(),
    knowledgeBaseId: randomUUID(),
    title: "Policy",
    page: null,
    sourceUrl: null,
    heading: null,
    content: "Refunds within 30 days",
    score: similarity,
    vectorScore: similarity,
    lexicalScore: 0,
    sourceKind: qa ? "qa" : "text",
    reviewStatus: approved ? "approved" : "current",
  };
}
test("Legacy configuration remains balanced; policy and threshold validate", () => {
  const base = { modelId: randomUUID() };
  assert.equal(agentConfig.parse(base).rag.answerSourcePolicy, "balanced");
  assert.equal(agentConfig.parse(base).rag.qaMinScore, 0.75);
  assert.equal(
    agentConfig.parse({ ...base, rag: policy }).rag.answerSourcePolicy,
    "prefer_approved_qa",
  );
  for (const qaMinScore of [-0.1, 1.1, NaN])
    assert.equal(
      agentConfig.safeParse({ ...base, rag: { ...policy, qaMinScore } })
        .success,
      false,
    );
});
test("Preference requires approved matching Q&A, preserves support and does not mutate ranking", () => {
  const doc = source(1),
    qa = source(2, true, true),
    unreviewed = source(3, true),
    weak = source(4, true, true, 0.5),
    otherQa = source(5, true, true);
  const all = [doc, unreviewed, weak, qa, otherQa];
  assert.deepEqual(selectEvidence(all, {}, 3), all.slice(0, 3));
  assert.deepEqual(selectEvidence(all, policy, 2), [qa, doc]);
  assert.deepEqual(selectEvidence(all, policy, 1), [qa]);
  assert.deepEqual(selectEvidence(all, policy, 3), [qa, otherQa, doc]);
  assert.equal(all[0], doc);
  assert.deepEqual(selectEvidence([unreviewed, weak, doc], policy, 3), [doc]);
  assert.deepEqual(
    selectEvidence([qa], { ...policy, qaMinScore: 0.95 }, 2),
    [],
  );
});
test("Prompt conveys primary authority, document fallback and untrusted references", () => {
  const qa = source(1, true, true),
    doc = source(2);
  const prompt = groundedPrompt([qa, doc], policy);
  assert.match(prompt, /primary_approved_qa/);
  assert.match(prompt, /do not replace or contradict/);
  assert.match(prompt, /untrusted data/);
  assert.match(groundedPrompt([doc], policy), /No matching approved Q&A/);
  assert.doesNotMatch(
    groundedPrompt([qa, doc]),
    /Answer-source policy|primary_approved_qa/,
  );
});
test("Reranker cannot demote approved Q&A authority; diagnostics expose final selection", async () => {
  const doc = source(1),
    qa = source(2, true, true);
  const options = agentConfig.parse({
    modelId: randomUUID(),
    rag: { ...policy, rerank: true, topK: 2 },
  }).rag;
  const result = await enhancedRetrieval(
    {
      async execute() {
        return [doc, qa];
      },
    },
    {
      async *stream() {
        throw new Error("Dedicated reranker should be used");
      },
    },
    [],
    "refund",
    [],
    options,
    {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      publicAccess: false,
      onStage() {},
    },
    new AbortController().signal,
    1024,
    async (_query, sources) => ({
      scores: sources.map((s) => ({
        id: s.id,
        score: s.sourceKind === "qa" ? 0.1 : 1,
      })),
    }),
  );
  assert.equal(result.details?.reranked?.[0]?.chunkId, doc.chunkId);
  assert.equal(result.sources[0]?.chunkId, qa.chunkId);
  assert.equal(result.sources[1]?.chunkId, doc.chunkId);
  assert.equal(result.diagnostics.sourceSelection, "approved_qa");
  assert.equal(result.diagnostics.selectedApprovedQa, 1);
  assert.equal(result.sources[0]?.id, 1);
});
