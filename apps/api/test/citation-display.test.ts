import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CitationTextFilter,
  withoutCitationMarkers,
  withoutBlockCitations,
  citationDisplay,
} from "../src/citation-display.js";

test("Inline citations disappear while code, escaped brackets and Markdown links remain intact", () => {
  assert.equal(
    withoutCitationMarkers("Answer [1][2], detail [1, 2] and more [3–4]."),
    "Answer, detail and more.",
  );
  const markdown =
    "Use `items[1]` and [1](https://example.com).\\n\\n```js\\nitems[1]\\n```\\n\\n~~~text\\n[2]\\n~~~\\n\\n\\[3]".replaceAll(
      "\\n",
      "\n",
    );
  assert.equal(withoutCitationMarkers(markdown), markdown);
  assert.equal(
    withoutCitationMarkers("[manual](https://example.com/path[1])"),
    "[manual](https://example.com/path[1])",
  );
  assert.equal(
    withoutCitationMarkers("[1]: https://example.com\nText [1]."),
    "[1]: https://example.com\nText.",
  );
});

test("Citation filtering is identical across every stream split and never exposes partial reference markers", () => {
  const samples = [
    "Answer [1][2], detail [1, 2].",
    "`items[1]` answer [2].",
    "```js\nitems[1]\n```\nAnswer [2]",
    "Label [1](https://example.com) and claim [2].",
    "[manual](https://example.com/path[1]) and claim [2].",
    "Answer [1]",
    "Incomplete [",
    "Escaped \\[1] and claim [2].",
    "~~~text\n[1]\n~~~\nAnswer [2].",
  ];
  for (const sample of samples) {
    for (let split = 0; split <= sample.length; split++) {
      const stream = new CitationTextFilter();
      assert.equal(
        stream.push(sample.slice(0, split)) +
          stream.push(sample.slice(split)) +
          stream.finish(),
        withoutCitationMarkers(sample),
        `${sample}: ${split}`,
      );
    }
  }
  const stream = new CitationTextFilter();
  const chunks = ["Answer ", "[", "1", "]", "[", "2", "]", "."];
  let shown = "";
  for (const chunk of chunks) {
    shown += stream.push(chunk);
    assert.doesNotMatch(shown, /\[\d*/);
  }
  shown += stream.finish();
  assert.equal(shown, "Answer.");
});

test("Rich text and history respect the display setting without changing user messages, IDs, files or arguments", () => {
  const blocks = [
    { type: "text", content: "Supported [1]." },
    { type: "card", title: "Title [1]", content: "Body [2]." },
    {
      type: "file",
      title: "File [1]",
      content: "items[1]",
      id: "[1]",
      values: { expression: "items[1]" },
    },
  ];
  const clean = withoutBlockCitations(blocks);
  assert.equal(clean[0]!.content, "Supported.");
  assert.equal(clean[1]!.title, "Title");
  assert.equal(clean[2]!.content, "items[1]");
  assert.equal(clean[2]!.id, "[1]");
  assert.deepEqual(clean[2]!.values, { expression: "items[1]" });
  assert.equal(blocks[0]!.content, "Supported [1].");
  const message = {
    role: "assistant",
    content: "Answer [1].",
    citations: [{ id: 1 }],
    blocks,
  };
  assert.equal(citationDisplay(message, false).content, "Answer.");
  assert.deepEqual(citationDisplay(message, false).citations, []);
  assert.equal(citationDisplay(message, true), message);
  const user = { ...message, role: "user" };
  assert.equal(citationDisplay(user, false), user);
});
