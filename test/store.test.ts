import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cosineSimilarity, LocalStore } from "../src/rag/store.js";

test("cosineSimilarity is 1 for identical vectors and 0 for orthogonal", () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test("LocalStore.search returns the nearest chunks first, with scores", async () => {
  const store = new LocalStore();
  await store.upsert([
    { id: "a", vector: [1, 0, 0], text: "alpha", source: "a.md", heading: "A" },
    { id: "b", vector: [0, 1, 0], text: "bravo", source: "b.md", heading: "B" },
    { id: "c", vector: [0.9, 0.1, 0], text: "near-alpha", source: "c.md", heading: "C" },
  ]);
  const hits = await store.search([1, 0, 0], 2);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].chunk.id, "a"); // exact match first
  assert.equal(hits[1].chunk.id, "c"); // near-alpha second
  assert.ok(hits[0].score >= hits[1].score);
});

test("LocalStore persists to a file and reloads with the same data", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "rag-")), "index.json");
  const s1 = new LocalStore();
  await s1.upsert([{ id: "a", vector: [1, 0], text: "alpha", source: "a.md", heading: "A" }]);
  await s1.save(file);

  const s2 = await LocalStore.load(file);
  const hits = await s2.search([1, 0], 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].chunk.text, "alpha");
});
