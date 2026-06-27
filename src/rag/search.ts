/**
 * search_knowledge — the read-only RAG retrieval tool exposed to the agent.
 *
 * `searchKnowledgeText` is the fail-soft core: it NEVER throws. If embedding or the store
 * is unavailable, it returns a clear message so the agent falls back to the always-on
 * knowledge, skills, and live tools instead of crashing the request (docs/RAG_PLAN.md §9).
 *
 * `createSearchKnowledgeServer` wraps it as an in-process SDK MCP server, and
 * `createRagDeps` lazily builds (and memoizes) the embedder + store from config.
 */

import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { retrieve, formatRetrieved } from "./retrieve.js";
import { createEmbedder, bedrockInvoke, type Embedder } from "./embed.js";
import { createStore, type StoreConfig } from "./store-factory.js";
import type { VectorStore } from "./store.js";

export interface Deps {
  embedder: Embedder;
  store: VectorStore;
}

/** Fail-soft retrieval: returns formatted, cited chunks — or a fallback message, never throws. */
export async function searchKnowledgeText(
  query: string,
  k: number,
  getDeps: () => Promise<Deps>,
): Promise<string> {
  try {
    const { embedder, store } = await getDeps();
    return formatRetrieved(await retrieve(query, embedder, store, k));
  } catch (err) {
    return (
      `Knowledge index unavailable (${(err as Error).message}). ` +
      `Fall back to the always-on knowledge, skills, and live tools.`
    );
  }
}

export interface RagConfig {
  embedModelId: string;
  region?: string;
  defaultK?: number;
  store: StoreConfig;
}

/** Lazily build + memoize the embedder and store so a misconfig never crashes at boot. */
export function createRagDeps(config: RagConfig): () => Promise<Deps> {
  let cached: Promise<Deps> | undefined;
  return () =>
    (cached ??= (async () => ({
      embedder: createEmbedder(bedrockInvoke({ region: config.region }), config.embedModelId),
      store: await createStore(config.store),
    }))());
}

/** In-process SDK MCP server exposing the read-only `search_knowledge` tool. */
export function createSearchKnowledgeServer(getDeps: () => Promise<Deps>, defaultK = 6) {
  return createSdkMcpServer({
    name: "knowledge",
    version: "1.0.0",
    alwaysLoad: true,
    tools: [
      tool(
        "search_knowledge",
        "Semantically search the knowledge corpus (runbooks, domain docs, past incidents) and " +
          "return the most relevant chunks with source citations. Read-only. Use for 'how do we…' " +
          "questions, historical incidents, and deep service internals; then verify with live tools.",
        {
          query: z.string().describe("natural-language search query"),
          k: z.number().int().positive().max(20).optional().describe("number of chunks to return"),
        },
        async (args) => {
          const text = await searchKnowledgeText(String(args.query), Number(args.k ?? defaultK), getDeps);
          return { content: [{ type: "text", text }] };
        },
      ),
    ],
  });
}
