import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderError } from "@agentconnect/provider-sdk";
import { parseGenerativeResponse } from "../src/generative-diagnostics.js";
test("Rich response diagnostics distinguish JSON, schema and allowed-block failures without raw content", () => {
  for (const [text, stage, format] of [
    ["```json\nprivate customer text\n```", "json", "code_fence"],
    [
      JSON.stringify({
        version: 1,
        message: "secret-customer-message",
        blocks: [{ type: "unknown-private-block" }],
      }),
      "schema",
      "object",
    ],
    [
      JSON.stringify({
        version: 1,
        message: "secret-customer-message",
        blocks: [{ type: "text", content: "private content" }],
      }),
      "allowed_blocks",
      "object",
    ],
  ] as const) {
    assert.throws(
      () => parseGenerativeResponse(text, []),
      (e) => {
        assert.ok(e instanceof ProviderError);
        assert.equal(e.code, "INVALID_UI_RESPONSE");
        assert.equal(e.details?.responseValidation?.stage, stage);
        assert.equal(e.details?.responseValidation?.format, format);
        assert.equal(
          e.details?.responseValidation?.outputCharacters,
          text.length,
        );
        const details = JSON.stringify(e.details);
        assert.ok(!details.includes("private"));
        assert.ok(!details.includes("secret-customer"));
        return true;
      },
    );
  }
  const text = JSON.stringify({
    version: 1,
    message: "Valid",
    blocks: [{ type: "text", content: "Visible" }],
  });
  assert.equal(parseGenerativeResponse(text, ["text"]).message, "Valid");
});
