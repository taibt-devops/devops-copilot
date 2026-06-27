/**
 * Amazon S3 Vectors backend — native k-NN in S3, no cluster, lowest cost for infrequent
 * queries (docs/RAG_PLAN.md §3). The store talks to a minimal `VectorsApi`, so it is fully
 * testable without AWS. `s3VectorsApi` is the real adapter over the S3 Vectors SDK.
 */

import type { SearchHit, StoredChunk, VectorStore } from "./store.js";

export interface VectorsApi {
  putVectors(
    records: { key: string; vector: number[]; metadata: Record<string, unknown> }[],
  ): Promise<void>;
  queryVectors(
    vector: number[],
    topK: number,
  ): Promise<{ key: string; distance: number; metadata: Record<string, unknown> }[]>;
}

export class S3VectorsStore implements VectorStore {
  constructor(private api: VectorsApi) {}

  async upsert(records: StoredChunk[]): Promise<void> {
    await this.api.putVectors(
      records.map((r) => ({
        key: r.id,
        vector: r.vector,
        metadata: { text: r.text, source: r.source, heading: r.heading, repo: r.repo },
      })),
    );
  }

  async search(queryVector: number[], k: number): Promise<SearchHit[]> {
    const results = await this.api.queryVectors(queryVector, k);
    return results.map((r) => ({
      // S3 Vectors returns distance (lower = closer); convert to a higher-is-better score.
      score: 1 / (1 + r.distance),
      chunk: {
        id: r.key,
        vector: [],
        text: String(r.metadata.text ?? ""),
        source: String(r.metadata.source ?? ""),
        heading: String(r.metadata.heading ?? ""),
        repo: r.metadata.repo as string | undefined,
      },
    }));
  }
}

/**
 * Real adapter over the S3 Vectors SDK. Loaded via a computed specifier so the build does
 * not hard-require the package; install `@aws-sdk/client-s3vectors` to use this backend.
 */
export async function s3VectorsApi(opts: {
  vectorBucket: string;
  indexName: string;
  region?: string;
}): Promise<VectorsApi> {
  const pkg = "@aws-sdk/client-s3vectors";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(pkg);
  const client = new mod.S3VectorsClient({ region: opts.region });
  const base = { vectorBucketName: opts.vectorBucket, indexName: opts.indexName };
  return {
    async putVectors(records) {
      await client.send(
        new mod.PutVectorsCommand({
          ...base,
          vectors: records.map((r) => ({
            key: r.key,
            data: { float32: r.vector },
            metadata: r.metadata,
          })),
        }),
      );
    },
    async queryVectors(vector, topK) {
      const res = await client.send(
        new mod.QueryVectorsCommand({
          ...base,
          topK,
          queryVector: { float32: vector },
          returnMetadata: true,
          returnDistance: true,
        }),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (res.vectors ?? []).map((v: any) => ({
        key: v.key,
        distance: v.distance ?? 0,
        metadata: v.metadata ?? {},
      }));
    },
  };
}
