import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { agentConfig } from "@agentconnect/schemas/agents";
import type { ChatProvider } from "@agentconnect/provider-sdk";
import { planKnowledgeUsage } from "../src/knowledge-usage.js";
const modelId = randomUUID(),
  kb = randomUUID();
const signal = new AbortController().signal;
test("Legacy configuration keeps tools automatic and knowledge always; invalid policies are rejected", () => {
  const c = agentConfig.parse({ modelId, rag: { knowledgeBaseIds: [kb] } });
  assert.equal(c.tools.usageMode, "automatic");
  assert.equal(c.rag.usageMode, "always");
  assert.equal(c.rag.usageInstructions, "");
  for (const section of ["rag", "tools"]) {
    assert.equal(
      agentConfig.safeParse({ modelId, [section]: { usageMode: "sometimes" } })
        .success,
      false,
    );
    assert.equal(
      agentConfig.safeParse({
        modelId,
        [section]: { usageInstructions: "x".repeat(4001) },
      }).success,
      false,
    );
  }
});
test("Disabled, always and unattached knowledge never call the planner", async () => {
  const provider: ChatProvider = {
    async *stream() {
      throw new Error("must not plan");
      yield { type: "token", text: "" };
    },
  };
  for (const usageMode of ["always", "disabled"] as const) {
    const c = agentConfig.parse({
      modelId,
      rag: { knowledgeBaseIds: [kb], usageMode },
    });
    assert.deepEqual(
      await planKnowledgeUsage(
        c,
        provider,
        [{ role: "user", content: "hi" }],
        signal,
        32768,
      ),
      { retrieve: usageMode === "always", inputTokens: 0, outputTokens: 0 },
    );
  }
  const c = agentConfig.parse({ modelId, rag: { usageMode: "automatic" } });
  assert.equal(
    (await planKnowledgeUsage(c, provider, [], signal, 32768)).retrieve,
    false,
  );
});
test("Automatic uses instructions and conversation history, accepts skip/retrieve, and accounts actual usage", async () => {
  const c = agentConfig.parse({
    modelId,
    prompt: { instructions: "Use approved refund policy" },
    rag: {
      knowledgeBaseIds: [kb],
      usageMode: "automatic",
      usageInstructions: "Skip greetings; search product policies",
    },
  });
  const messages = [
    { role: "assistant" as const, content: "Which policy?" },
    { role: "user" as const, content: "Refunds" },
  ];
  for (const retrieve of [false, true]) {
    const provider: ChatProvider = {
      async *stream(request) {
        assert.match(request.system, /Skip greetings; search product policies/);
        assert.match(request.system, /Use approved refund policy/);
        assert.match(request.system, /Refund handbook/);
        assert.deepEqual(request.messages, messages);
        yield { type: "token", text: JSON.stringify({ retrieve }) };
        yield { type: "usage", inputTokens: 7, outputTokens: 3 };
      },
    };
    assert.deepEqual(
      await planKnowledgeUsage(c, provider, messages, signal, 32768, [
        { name: "Refund handbook", description: "Approved refund policies" },
      ]),
      { retrieve, inputTokens: 7, outputTokens: 3 },
    );
  }
});
test("Invalid, oversized and over-budget automatic plans fail without guessing", async () => {
  const c = agentConfig.parse({
    modelId,
    rag: { knowledgeBaseIds: [kb], usageMode: "automatic" },
  });
  for (const text of [
    '{"retrieve":"false"}',
    '{"retrieve":false,"extra":true}',
    "not json",
    "x".repeat(2001),
  ]) {
    const provider: ChatProvider = {
      async *stream() {
        yield { type: "token", text };
      },
    };
    await assert.rejects(planKnowledgeUsage(c, provider, [], signal, 32768), {
      code: "KNOWLEDGE_PLAN_INVALID",
    });
  }
  const provider: ChatProvider = {
    async *stream() {
      throw new Error("must not call provider");
      yield { type: "token", text: "" };
    },
  };
  await assert.rejects(planKnowledgeUsage(c, provider, [], signal, 1), {
    code: "CONTEXT_LIMIT",
  });
});
