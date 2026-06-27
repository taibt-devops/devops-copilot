import { test } from "node:test";
import assert from "node:assert/strict";
import { createEmbedder, type InvokeFn } from "../src/rag/embed.js";

test("embed sends the texts to the model and returns the parsed embedding vectors", async () => {
  let seenBody: any;
  const invoke: InvokeFn = async (_modelId, body) => {
    seenBody = JSON.parse(body);
    return JSON.stringify({ embeddings: [[1, 2, 3], [4, 5, 6]] });
  };
  const e = createEmbedder(invoke, "cohere.embed-v4");
  const vecs = await e.embed(["alpha", "bravo"]);
  assert.deepEqual(vecs, [[1, 2, 3], [4, 5, 6]]);
  assert.deepEqual(seenBody.texts, ["alpha", "bravo"]);
  assert.equal(seenBody.input_type, "search_document");
});

test("parses the Cohere v4 embeddings.float response shape", async () => {
  const invoke: InvokeFn = async () => JSON.stringify({ embeddings: { float: [[7, 8]] } });
  const e = createEmbedder(invoke, "cohere.embed-v4");
  assert.deepEqual(await e.embed(["x"]), [[7, 8]]);
});

test("titan provider embeds one text per call (inputText) and parses {embedding}", async () => {
  const bodies: any[] = [];
  const invoke: InvokeFn = async (_m, b) => {
    bodies.push(JSON.parse(b));
    return JSON.stringify({ embedding: [bodies.length] });
  };
  const e = createEmbedder(invoke, "amazon.titan-embed-text-v2:0", "titan");
  const vecs = await e.embed(["a", "b"]);
  assert.deepEqual(vecs, [[1], [2]]);
  assert.deepEqual(bodies, [{ inputText: "a" }, { inputText: "b" }]);
});

test("provider is inferred from the model id when omitted (titan -> titan)", async () => {
  const invoke: InvokeFn = async () => JSON.stringify({ embedding: [5] });
  const e = createEmbedder(invoke, "amazon.titan-embed-text-v2:0");
  assert.deepEqual(await e.embedQuery("q"), [5]);
});

test("embedQuery uses input_type search_query and returns a single vector", async () => {
  let body: any;
  const invoke: InvokeFn = async (_m, b) => {
    body = JSON.parse(b);
    return JSON.stringify({ embeddings: [[9, 9]] });
  };
  const e = createEmbedder(invoke, "m");
  const v = await e.embedQuery("why 401?");
  assert.deepEqual(v, [9, 9]);
  assert.equal(body.input_type, "search_query");
  assert.deepEqual(body.texts, ["why 401?"]);
});
