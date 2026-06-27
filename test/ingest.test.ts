import { test } from "node:test";
import assert from "node:assert/strict";
import { ingestDocs } from "../src/rag/ingest.js";
import { LocalStore } from "../src/rag/store.js";
import type { Embedder } from "../src/rag/embed.js";

// deterministic fake: each text → a 1-d vector based on call order
const fakeEmbedder: Embedder = {
  embed: async (texts) => texts.map((_t, i) => [i + 1]),
  embedQuery: async () => [0],
};

test("ingestDocs chunks, embeds, and upserts chunks with stable ids", async () => {
  const store = new LocalStore();
  const res = await ingestDocs(
    [{ source: "a.md", content: "# Heading\nhello world body" }],
    fakeEmbedder,
    store,
  );
  assert.equal(res.chunks, 1);
  const hits = await store.search([1], 1);
  assert.equal(hits[0].chunk.source, "a.md");
  assert.equal(hits[0].chunk.heading, "Heading");
  assert.match(hits[0].chunk.id, /^a\.md#0$/);
});

test("re-ingesting the same doc replaces chunks by id (no duplicates)", async () => {
  const store = new LocalStore();
  const doc = [{ source: "a.md", content: "# H\nbody text" }];
  await ingestDocs(doc, fakeEmbedder, store);
  await ingestDocs(doc, fakeEmbedder, store);
  const hits = await store.search([1], 100);
  assert.equal(hits.length, 1); // stable id → overwrite, not append
});
