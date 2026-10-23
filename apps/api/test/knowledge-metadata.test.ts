import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  metadataFilter,
  sourceMetadataUpdate,
} from "@agentconnect/schemas/knowledge-metadata";
import { knowledgeSearch } from "@agentconnect/schemas/platform-api";
import { agentConfig } from "@agentconnect/schemas/agents";
test("Metadata filters validate bounds, flat attributes and supported operators", () => {
  const filter = {
    tagsAll: ["policy"],
    attributes: { product: "loans", effective_date: "2026-01-01" },
  };
  assert.deepEqual(metadataFilter.parse(filter), filter);
  assert.deepEqual(
    knowledgeSearch.parse({ query: "refund", metadataFilter: filter })
      .metadataFilter,
    filter,
  );
  assert.deepEqual(
    agentConfig.parse({
      modelId: randomUUID(),
      rag: { metadataFilter: filter },
    }).rag.metadataFilter,
    filter,
  );
  for (const value of [
    { tagsAll: Array(21).fill("tag") },
    { tagsAll: [""] },
    { tagsAll: ["x".repeat(51)] },
    { attributes: { "Bad.Key": "x" } },
    { attributes: { key: "" } },
    { attributes: { key: "x".repeat(201) } },
    { attributes: { key: { $ne: "private" } } },
    {
      attributes: Object.fromEntries(
        Array.from({ length: 21 }, (_, i) => [`field_${i}`, "x"]),
      ),
    },
    { tagsAny: ["unsupported"] },
  ])
    assert.equal(
      metadataFilter.safeParse(value).success,
      false,
      JSON.stringify(value),
    );
  assert.equal(
    sourceMetadataUpdate.safeParse({
      tags: [],
      attributes: {},
      metadataRevision: -1,
    }).success,
    false,
  );
  assert.equal(
    agentConfig.parse({ modelId: randomUUID() }).rag.metadataFilter,
    undefined,
  );
});
