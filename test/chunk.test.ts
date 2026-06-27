import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown, estimateTokens } from "../src/rag/chunk.js";

test("emits one chunk per heading section with its heading path and source", () => {
  const chunks = chunkMarkdown("# Auth Service\nIssues JWTs for everyone.", {
    source: "auth/DOMAIN.md",
  });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].heading, "Auth Service");
  assert.equal(chunks[0].source, "auth/DOMAIN.md");
  assert.equal(chunks[0].index, 0);
  assert.match(chunks[0].text, /Issues JWTs/);
});

test("splits an oversized section into multiple chunks by paragraph, keeping the heading", () => {
  const p1 = "alpha".padEnd(80, " a"); // ~80 chars ~20 tokens
  const p2 = "bravo".padEnd(80, " b");
  const doc = `# Big\n${p1}\n\n${p2}`;
  const chunks = chunkMarkdown(doc, { source: "b.md" }, { maxTokens: 25, overlapTokens: 0 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].heading, "Big");
  assert.equal(chunks[1].heading, "Big");
  assert.match(chunks[0].text, /alpha/);
  assert.match(chunks[1].text, /bravo/);
  for (const c of chunks) assert.ok(estimateTokens(c.text) <= 25, `chunk too big: ${c.text.length}`);
});

test("adds overlap from the previous part to the next so boundary context survives", () => {
  const a = "aaaa ".repeat(20).trim(); // ~99 chars, all 'a'
  const b = "bbbb ".repeat(20).trim(); // ~99 chars, all 'b'
  const doc = `# H\n${a}\n\n${b}`;
  const chunks = chunkMarkdown(doc, { source: "o.md" }, { maxTokens: 40, overlapTokens: 5 });
  assert.ok(chunks.length >= 2, `expected >=2 chunks, got ${chunks.length}`);
  // Without overlap chunk[1] would start with 'bbbb'; with overlap it starts with the tail of chunk[0].
  assert.match(chunks[1].text, /^aaaa/);
  assert.match(chunks[1].text, /bbbb/);
});

test("builds the full nested heading path and skips heading-only sections", () => {
  const doc = [
    "# Auth Service",
    "## Common errors",
    "### 401 on /profile",
    "token expired",
    "## Deploy",
    "runs on k8s",
  ].join("\n");
  const chunks = chunkMarkdown(doc, { source: "a.md" });
  // "Auth Service" and "Common errors" have no body of their own -> skipped.
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].heading, "Auth Service > Common errors > 401 on /profile");
  assert.match(chunks[0].text, /token expired/);
  assert.equal(chunks[1].heading, "Auth Service > Deploy");
  assert.equal(chunks[1].index, 1);
});
