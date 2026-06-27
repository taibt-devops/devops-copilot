import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalStore } from "../src/rag/store.js";
import { retrieve, formatRetrieved } from "../src/rag/retrieve.js";
import type { Embedder } from "../src/rag/embed.js";

const fakeEmbedder = (vec: number[]): Embedder => ({
  embed: async () => [],
  embedQuery: async () => vec,
});

test("retrieve embeds the query, searches the store, and returns cited chunks", async () => {
  const store = new LocalStore();
  await store.upsert([
    { id: "1", vector: [1, 0], text: "token expired", source: "auth.md", heading: "401" },
    { id: "2", vector: [0, 1], text: "disk full", source: "host.md", heading: "disk" },
  ]);
  const hits = await retrieve("why 401", fakeEmbedder([1, 0]), store, 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, "auth.md");
  assert.equal(hits[0].heading, "401");
  assert.match(hits[0].text, /token expired/);
  assert.equal(typeof hits[0].score, "number");
});

test("formatRetrieved renders each chunk with its source citation", () => {
  const out = formatRetrieved([
    { text: "token expired", source: "auth.md", heading: "401", score: 0.91 },
  ]);
  assert.match(out, /auth\.md/);
  assert.match(out, /401/);
  assert.match(out, /token expired/);
});

test("formatRetrieved reports when nothing was found", () => {
  assert.match(formatRetrieved([]), /no .*match|nothing/i);
});
