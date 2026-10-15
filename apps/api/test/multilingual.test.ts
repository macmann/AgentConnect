import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { example, deterministicScore } from "@agentconnect/schemas/quality";
import {
  scoreMultilingual,
  multilingualSummary,
} from "../src/multilingual-benchmarks.js";
const source = randomUUID();
const sample = (patch = {}) =>
  example.parse({
    input: "เปลี่ยนรหัสผ่านอย่างไร",
    expectedBehavior: "Answer in Thai",
    contains: ["รหัสผ่าน"],
    expectedSourceIds: [source],
    multilingual: {
      intent: "Password reset",
      queryLanguage: "th",
      sourceLanguage: "en",
      expectedAnswerLanguage: "th",
      expectedScripts: ["Thai"],
    },
    ...patch,
  });
test("Multilingual benchmarks require valid language tags and explicit retrieval ground truth", () => {
  assert.throws(() => sample({ expectedSourceIds: [] }), /expected source/);
  assert.throws(
    () =>
      sample({
        multilingual: {
          intent: "Reset",
          queryLanguage: "not a language",
          sourceLanguage: "en",
          expectedAnswerLanguage: "th",
        },
      }),
    /language tag/,
  );
  assert.equal(sample().multilingual!.minScriptRatio, 0.6);
  assert.equal(
    sample({
      multilingual: {
        intent: "Mixed",
        queryLanguage: "mul",
        sourceLanguage: "en",
        expectedAnswerLanguage: "en",
      },
    }).multilingual!.queryLanguage,
    "mul",
  );
});
test("Writing system coverage and cited source recall are distinct measured checks", () => {
  const good = scoreMultilingual(sample(), "รีเซ็ตรหัสผ่านของคุณ [1]", [
    { sourceId: source },
  ])!;
  assert.equal(good.crossLanguage, true);
  assert.equal(good.scriptPassed, true);
  assert.equal(good.citationPassed, true);
  assert.equal(
    scoreMultilingual(sample(), "Reset your password [1]", [
      { sourceId: source },
    ])!.scriptPassed,
    false,
  );
  assert.equal(scoreMultilingual(sample(), "123 [1]", [])!.scriptRatio, 0);
  assert.equal(
    scoreMultilingual(sample(), "รหัสผ่าน", [])!.citationPassed,
    false,
  );
  const latin = sample({
    multilingual: {
      intent: "French",
      queryLanguage: "fr",
      sourceLanguage: "en",
      expectedAnswerLanguage: "fr",
      expectedScripts: ["Latin"],
    },
  });
  assert.equal(
    scoreMultilingual(latin, "This is English", [])!.scriptPassed,
    true,
    "Latin script must not be advertised as French detection",
  );
  assert.equal(
    scoreMultilingual(
      sample({
        multilingual: {
          intent: "Reset",
          queryLanguage: "th",
          sourceLanguage: "en",
          expectedAnswerLanguage: "th",
          expectedScripts: [],
        },
      }),
      "English",
      [],
    )!.scriptPassed,
    null,
  );
});
test("Required phrases support canonical Unicode equivalence and language-specific casing", () => {
  const e = sample({
    contains: ["café"],
    multilingual: {
      intent: "Cafe",
      queryLanguage: "fr",
      sourceLanguage: "en",
      expectedAnswerLanguage: "fr",
    },
  });
  assert.equal(deterministicScore(e, "cafe\u0301", [source]).score, 1);
  const turkish = sample({
    contains: ["ışık"],
    multilingual: {
      intent: "Light",
      queryLanguage: "tr",
      sourceLanguage: "en",
      expectedAnswerLanguage: "tr",
    },
  });
  assert.equal(deterministicScore(turkish, "IŞIK", [source]).score, 1);
});
test("Language-pair reports retain failures and do not fabricate missing language assessments", () => {
  const a = sample(),
    b = sample({
      input: "reset",
      multilingual: {
        intent: "Password reset",
        queryLanguage: "en",
        sourceLanguage: "en",
        expectedAnswerLanguage: "en",
      },
    });
  const report = multilingualSummary(
    [a, b],
    [
      {
        example_id: a.id,
        passed: true,
        status: "completed",
        metrics: {
          retrievalRecall: 1,
          multilingual: scoreMultilingual(a, "รหัสผ่าน", [
            { sourceId: source },
          ]),
        },
      },
      { example_id: b.id, passed: false, status: "failed", metrics: {} },
    ],
  );
  assert.equal(report.languagePairs.length, 2);
  assert.equal(report.intents[0]!.passRate, 0.5);
  assert.equal(report.intents[0]!.failedCases, 1);
  assert.equal(report.intents[0]!.languageCompliance, null);
});

test("Language-pair baseline comparisons preserve unmeasured values", async () => {
  const { compareLanguagePairs } =
    await import("../src/multilingual-benchmarks.js");
  const e = sample();
  const before = multilingualSummary(
    [e],
    [
      {
        example_id: e.id,
        passed: true,
        status: "completed",
        metrics: { retrievalRecall: 1 },
      },
    ],
  );
  const after = multilingualSummary(
    [e],
    [
      {
        example_id: e.id,
        passed: false,
        status: "completed",
        metrics: { retrievalRecall: 0 },
      },
    ],
  );
  const deltas = compareLanguagePairs(after, before);
  assert.equal(deltas[0]!.passRateDelta, -1);
  assert.equal(deltas[0]!.retrievalRecallDelta, -1);
  assert.equal(deltas[0]!.languageComplianceDelta, null);
  assert.deepEqual(compareLanguagePairs(after), []);
});
