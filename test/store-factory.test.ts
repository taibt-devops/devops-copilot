import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/rag/store-factory.js";

test("createStore('local') returns a working in-memory store", async () => {
  const s = await createStore({ backend: "local" });
  await s.upsert([{ id: "a", vector: [1, 0], text: "alpha", source: "a.md", heading: "A" }]);
  const hits = await s.search([1, 0], 1);
  assert.equal(hits[0].chunk.text, "alpha");
});

test("createStore throws a clear error for an unknown backend", async () => {
  await assert.rejects(
    () => createStore({ backend: "nope" as never }),
    /unknown|unsupported/i,
  );
});

test("createStore('opensearch') reports it is not implemented yet", async () => {
  await assert.rejects(() => createStore({ backend: "opensearch" }), /not implemented|s3-vectors/i);
});
