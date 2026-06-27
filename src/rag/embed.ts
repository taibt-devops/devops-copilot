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

/** Cohere on Bedrock returns either `embeddings: number[][]` or `embeddings: { float: number[][] }`. */
function parseEmbeddings(json: string): number[][] {
  const o = JSON.parse(json) as { embeddings?: number[][] | { float?: number[][] } };
  const e = o.embeddings;
  if (Array.isArray(e)) return e;
  if (e && Array.isArray(e.float)) return e.float;
  throw new Error("embed: unexpected Bedrock response shape (no embeddings)");
}

export function createEmbedder(invoke: InvokeFn, modelId: string): Embedder {
  const run = async (texts: string[], input_type: string): Promise<number[][]> => {
    if (texts.length === 0) return [];
    const body = JSON.stringify({ texts, input_type });
    return parseEmbeddings(await invoke(modelId, body));
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
