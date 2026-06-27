/**
 * Ingestion core — chunk → embed → upsert (docs/RAG_PLAN.md §5).
 *
 * Pure orchestration over an Embedder + VectorStore so it is testable without AWS.
 * Chunk ids are stable (`<source>#<index>`) so re-ingesting a changed doc OVERWRITES its
 * chunks instead of duplicating them — keeping re-index idempotent.
 */

import { chunkMarkdown, type ChunkOptions } from "./chunk.js";
import type { Embedder } from "./embed.js";
import type { StoredChunk, VectorStore } from "./store.js";

export interface DocFile {
  source: string;
  content: string;
  repo?: string;
}

export async function ingestDocs(
  docs: DocFile[],
  embedder: Embedder,
  store: VectorStore,
  opts: { chunk?: ChunkOptions } = {},
): Promise<{ chunks: number }> {
  const records: StoredChunk[] = [];
  for (const doc of docs) {
    const chunks = chunkMarkdown(doc.content, { source: doc.source, repo: doc.repo }, opts.chunk);
    if (chunks.length === 0) continue;
    const vectors = await embedder.embed(chunks.map((c) => c.text));
    chunks.forEach((c, i) => {
      records.push({
        id: `${doc.source}#${c.index}`,
        vector: vectors[i],
        text: c.text,
        source: c.source,
        heading: c.heading,
        repo: c.repo,
      });
    });
  }
  if (records.length) await store.upsert(records);
  return { chunks: records.length };
}
