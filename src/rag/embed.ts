/**
 * Embedder — turns text into vectors via Cohere on AWS Bedrock (docs/RAG_PLAN.md §5).
 *
 * The pure orchestration (`createEmbedder`) takes an `InvokeFn` so it is testable without
 * touching AWS. `bedrockInvoke` is the real adapter over `BedrockRuntimeClient`.
 *
 * IMPORTANT: index-time and query-time must use the SAME model — vectors from different
 * models are not comparable. Cohere uses `input_type` to distinguish documents vs queries.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

/** Invoke a Bedrock model: given (modelId, requestBodyJson), return the response body JSON text. */
export type InvokeFn = (modelId: string, body: string) => Promise<string>;

export interface Embedder {
  /** Embed documents (index time). */
  embed(texts: string[]): Promise<number[][]>;
  /** Embed a single query (search time). */
  embedQuery(text: string): Promise<number[]>;
}

export type EmbedProvider = "cohere" | "titan";

/** Cohere/Titan have different request + response shapes; infer from the Bedrock model id. */
export function inferProvider(modelId: string): EmbedProvider {
  return /titan|amazon|nova/i.test(modelId) ? "titan" : "cohere";
}

/** Cohere on Bedrock returns either `embeddings: number[][]` or `embeddings: { float: number[][] }`. */
function parseCohere(json: string): number[][] {
  const o = JSON.parse(json) as { embeddings?: number[][] | { float?: number[][] } };
  const e = o.embeddings;
  if (Array.isArray(e)) return e;
  if (e && Array.isArray(e.float)) return e.float;
  throw new Error("embed: unexpected Cohere response shape (no embeddings)");
}

/** Amazon Titan embeds ONE text per call and returns `{ embedding: number[] }`. */
function parseTitan(json: string): number[] {
  const o = JSON.parse(json) as { embedding?: number[] };
  if (!Array.isArray(o.embedding)) throw new Error("embed: unexpected Titan response (no embedding)");
  return o.embedding;
}

export function createEmbedder(
  invoke: InvokeFn,
  modelId: string,
  provider: EmbedProvider = inferProvider(modelId),
): Embedder {
  if (provider === "titan") {
    const one = async (text: string) => parseTitan(await invoke(modelId, JSON.stringify({ inputText: text })));
    return {
      embed: async (texts) => {
        const out: number[][] = [];
        for (const t of texts) out.push(await one(t)); // Titan = one text per request
        return out;
      },
      embedQuery: (text) => one(text),
    };
  }
  // Cohere: batch all texts in one call, with input_type.
  const run = async (texts: string[], input_type: string): Promise<number[][]> => {
    if (texts.length === 0) return [];
    return parseCohere(await invoke(modelId, JSON.stringify({ texts, input_type })));
  };
  return {
    embed: (texts) => run(texts, "search_document"),
    embedQuery: async (text) => (await run([text], "search_query"))[0],
  };
}

/** Real adapter: invoke Bedrock with the AWS SDK. Uses IRSA/profile creds from the env. */
export function bedrockInvoke(opts: { region?: string; client?: BedrockRuntimeClient } = {}): InvokeFn {
  const client = opts.client ?? new BedrockRuntimeClient({ region: opts.region });
  return async (modelId, body) => {
    const res = await client.send(
      new InvokeModelCommand({
        modelId,
        contentType: "application/json",
        accept: "application/json",
        body,
      }),
    );
    return new TextDecoder().decode(res.body);
  };
}
