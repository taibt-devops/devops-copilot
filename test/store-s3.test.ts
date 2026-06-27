import { test } from "node:test";
import assert from "node:assert/strict";
import { S3FileStore, type BlobStore } from "../src/rag/store-s3file.js";
import { S3VectorsStore, type VectorsApi } from "../src/rag/store-s3vectors.js";

function memBlob(): BlobStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    put: async (k, b) => void data.set(k, b),
  };
}

test("S3FileStore persists the index to the blob and searches via it", async () => {
  const blob = memBlob();
  const store = new S3FileStore(blob, "rag/index.json");
  await store.upsert([{ id: "a", vector: [1, 0], text: "alpha", source: "a.md", heading: "A" }]);
  assert.ok(blob.data.has("rag/index.json"));

  // a fresh instance reading the same blob sees the data
  const store2 = new S3FileStore(blob, "rag/index.json");
  const hits = await store2.search([1, 0], 1);
  assert.equal(hits[0].chunk.text, "alpha");
});

test("S3VectorsStore queries the S3 Vectors API and maps results to hits", async () => {
  const calls: any = { put: [], query: null };
  const api: VectorsApi = {
    putVectors: async (recs) => void calls.put.push(...recs),
    queryVectors: async (vector, topK) => {
      calls.query = { vector, topK };
      return [
        { key: "1", distance: 0.1, metadata: { text: "token expired", source: "auth.md", heading: "401" } },
      ];
    },
  };
  const store = new S3VectorsStore(api);
  await store.upsert([{ id: "1", vector: [1, 0], text: "token expired", source: "auth.md", heading: "401" }]);
  assert.equal(calls.put.length, 1);

  const hits = await store.search([1, 0], 3);
  assert.deepEqual(calls.query, { vector: [1, 0], topK: 3 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].chunk.text, "token expired");
  assert.equal(hits[0].chunk.source, "auth.md");
  assert.equal(typeof hits[0].score, "number");
});
