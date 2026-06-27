import { test } from "node:test";
import assert from "node:assert/strict";
import { searchKnowledgeText } from "../src/rag/search.js";
import { LocalStore } from "../src/rag/store.js";
import type { Embedder } from "../src/rag/embed.js";

const fakeEmbedder: Embedder = { embed: async () => [], embedQuery: async () => [1, 0] };

test("searchKnowledgeText returns formatted, cited hits", async () => {
  const store = new LocalStore();
  await store.upsert([
    { id: "1", vector: [1, 0], text: "token expired", source: "auth.md", heading: "401" },
  ]);
  const out = await searchKnowledgeText("why 401", 3, async () => ({ embedder: fakeEmbedder, store }));
  assert.match(out, /auth\.md/);
  assert.match(out, /token expired/);
});

test("searchKnowledgeText fails soft when retrieval throws (never rejects)", async () => {
  const out = await searchKnowledgeText("q", 3, async () => {
    throw new Error("bedrock unreachable");
  });
  assert.match(out, /unavailable|fall back/i);
  assert.match(out, /bedrock unreachable/);
});
