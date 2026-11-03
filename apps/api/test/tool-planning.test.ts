import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseToolPlan,
  ToolPlanValidationError,
} from "../src/tool-planning.js";
import { validateInputSchema } from "../src/tool-runtime.js";
const id = "00000000-0000-4000-8000-000000000001";
const tools = [
  {
    id,
    input_schema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
];
const plan = JSON.stringify({
  calls: [{ toolId: id, arguments: { city: "Yangon" } }],
});
const parse = (text: string, max = 3) =>
  parseToolPlan(text, tools, max, validateInputSchema);
test("Tool plans accept exact JSON and a single complete JSON fence, preserving strict validation", () => {
  assert.equal(parse(plan)[0]!.toolId, id);
  assert.equal(
    parse("\ufeff\n```json\n" + plan + "\n```\n")[0]!.arguments.city,
    "Yangon",
  );
  assert.deepEqual(parse('{"calls":[]}'), []);
  for (const value of [
    "Here is the plan: " + plan,
    plan + " trailing text",
    plan + plan,
    "```json\n" + plan,
  ])
    assert.throws(
      () => parse(value),
      (e) =>
        e instanceof ToolPlanValidationError && e.reason === "invalid_json",
    );
});
test("Tool plan failures provide stable bounded categories without echoing values, IDs or parse messages", () => {
  const cases: [string, string][] = [
    ["private-fixture-key", "invalid_json"],
    ["[]", "invalid_envelope"],
    ['{"calls":[],"other":"private-fixture-key"}', "invalid_envelope"],
    [
      JSON.stringify({ calls: [{ toolId: id, arguments: [] }] }),
      "invalid_arguments",
    ],
    [
      JSON.stringify({
        calls: [{ name: "private-fixture-key", arguments: {} }],
      }),
      "invalid_call_shape",
    ],
    [
      JSON.stringify({
        calls: [{ toolId: "private-fixture-key", arguments: {} }],
      }),
      "unknown_tool",
    ],
    [
      JSON.stringify({ calls: [{ toolId: id, arguments: { city: 123 } }] }),
      "arguments_schema",
    ],
    [
      JSON.stringify({
        calls: [{ toolId: id, arguments: { city: "x".repeat(8100) } }],
      }),
      "arguments_size",
    ],
    ["x".repeat(16001), "plan_size"],
  ];
  for (const [text, reason] of cases)
    assert.throws(
      () => parse(text),
      (e: unknown) => {
        assert.ok(e instanceof ToolPlanValidationError);
        assert.equal(e.reason, reason);
        assert.ok(!JSON.stringify(e).includes("private-fixture-key"));
        assert.ok(!e.message.includes("private-fixture-key"));
        return true;
      },
    );
  assert.throws(
    () => parse(plan, 0),
    (e) =>
      e instanceof ToolPlanValidationError && e.reason === "too_many_calls",
  );
});
