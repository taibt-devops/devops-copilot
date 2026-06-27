/**
 * Retrieval — the query-time half of RAG (docs/RAG_PLAN.md §1).
 *
 * Embeds the query, runs k-NN against the configured vector store, and returns chunks
 * with their source citations. The agent reads these, cites them, and verifies with
 * live tools. Read-only: this never writes to the store.
 */

import type { Embedder } from "./embed.js";
import type { VectorStore } from "./store.js";

export interface RetrievedChunk {
  text: string;
  source: string;
  heading: string;
  score: number;
}

export async function retrieve(
  query: string,
  embedder: Embedder,
  store: VectorStore,
  k: number,
): Promise<RetrievedChunk[]> {
  const queryVector = await embedder.embedQuery(query);
  const hits = await store.search(queryVector, k);
  return hits.map((h) => ({
    text: h.chunk.text,
    source: h.chunk.source,
    heading: h.chunk.heading,
    score: h.score,
  }));
}

/** Render retrieved chunks as citation-tagged text for the agent to read and cite. */
export function formatRetrieved(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) {
    return "No knowledge-base chunks matched the query. Fall back to the always-on knowledge, skills, and live tools.";
  }
  return chunks
    .map((c, i) => {
      const cite = c.heading ? `${c.source} › ${c.heading}` : c.source;
      return `[${i + 1}] (${cite}, score ${c.score.toFixed(2)})\n${c.text}`;
    })
    .join("\n\n");
}
