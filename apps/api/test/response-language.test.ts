import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { agentConfig } from "@agentconnect/schemas/agents";
import { renderPrompt, SingleAgentRuntime } from "@agentconnect/agent-sdk";
import type { ChatProvider, ChatRequest } from "@agentconnect/provider-sdk";
import { generateGroundedAnswer } from "../src/bank-runtime.js";
const base = () =>
  agentConfig.parse({
    modelId: randomUUID(),
    prompt: { instructions: "Use approved guidance." },
    language: "English",
  });
test("Legacy drafts retain their fixed language; explicit automatic policy is validated and previewed", () => {
  const legacy = base();
  assert.equal(legacy.languageMode, "fixed");
  assert.ok(renderPrompt(legacy).endsWith("Respond in English."));
  assert.ok(
    !agentConfig.safeParse({ ...legacy, languageMode: "guess" }).success,
  );
  const automatic = { ...legacy, languageMode: "auto" as const };
  const prompt = renderPrompt(automatic);
  assert.match(prompt, /language of the latest user message/);
  assert.match(prompt, /Re-evaluate the language each turn/);
  assert.match(prompt, /most recent meaningful user message/);
  assert.match(prompt, /reference passages, tool results/);
  assert.match(prompt, /preserving JSON keys/);
  assert.match(prompt, /if none is available, use English/);
  assert.match(
    renderPrompt({ ...legacy, language: "日本語" }),
    /Respond in 日本語/,
  );
  assert.match(
    renderPrompt({
      ...automatic,
      prompt: { ...legacy.prompt, advanced: "CUSTOM SYSTEM PROMPT" },
    }),
    /^CUSTOM SYSTEM PROMPT\n\nResponse language policy:/,
  );
});
test("Standard responses receive the saved language policy and keep user-language switches in conversation", async () => {
  const config = { ...base(), languageMode: "auto" as const };
  let seen: ChatRequest | undefined;
  const provider: ChatProvider = {
    async *stream(input) {
      seen = input;
      yield { type: "token", text: "¿En qué puedo ayudarte?" };
    },
  };
  const messages = [
    { role: "user" as const, content: "Hello" },
    { role: "assistant" as const, content: "Hello!" },
    { role: "user" as const, content: "¿Cómo puedo cambiar mi contraseña?" },
  ];
  for await (const event of new SingleAgentRuntime().run(
    config,
    messages,
    provider,
    AbortSignal.timeout(1000),
    "\nEnglish source text",
  ))
    assert.equal(event.type, "token");
  assert.match(seen!.system, /latest user message/);
  assert.equal(seen!.messages.at(-1)!.content, messages.at(-1)!.content);
});
test("Grounded automatic no-answer replies retain localized prose, including when no passages are available", async () => {
  const config = { ...base(), languageMode: "auto" as const };
  let calls = 0;
  const provider: ChatProvider = {
    async *stream(input) {
      calls++;
      assert.match(input.system, /translate the configured no-answer response/);
      assert.match(input.system, /Return kind no_answer only/);
      yield {
        type: "token",
        text: JSON.stringify({
          kind: "no_answer",
          message: "No encuentro información aprobada para esta pregunta.",
        }),
      };
      yield { type: "usage", inputTokens: 80, outputTokens: 12 };
    },
  };
  const result = await generateGroundedAnswer(
    config,
    provider,
    [{ role: "user", content: "¿Cómo puedo cambiar mi contraseña?" }],
    [],
    AbortSignal.timeout(1000),
    100000,
  );
  assert.equal(calls, 1);
  assert.equal(
    result.message,
    "No encuentro información aprobada para esta pregunta.",
  );
  assert.equal(result.outputTokens, 12);
  const fixed = await generateGroundedAnswer(
    base(),
    provider,
    [],
    [],
    AbortSignal.timeout(1000),
    100000,
  );
  assert.equal(calls, 1);
  assert.equal(fixed.message, config.answerPolicy.noAnswerResponse);
});
test("Automatic no-source localization cannot become an unsupported answer", async () => {
  const config = { ...base(), languageMode: "auto" as const };
  const provider: ChatProvider = {
    async *stream() {
      yield {
        type: "token",
        text: JSON.stringify({
          kind: "answer",
          message: "Invented procedure [1]",
        }),
      };
    },
  };
  await assert.rejects(
    generateGroundedAnswer(
      config,
      provider,
      [{ role: "user", content: "Pregunta" }],
      [],
      AbortSignal.timeout(1000),
      100000,
    ),
    (e) => (e as { code?: string }).code === "GROUNDED_RESPONSE_INVALID",
  );
});
