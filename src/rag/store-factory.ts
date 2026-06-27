/**
 * Store factory — pick the vector-store backend by config flag (docs/RAG_PLAN.md §3).
 *   local       → file in RAM (zero infra)
 *   s3-file     → one index object in S3, loaded into RAM
 *   s3-vectors  → Amazon S3 Vectors (native k-NN)   [production default]
 *   opensearch  → OpenSearch k-NN                    [R5, optional]
 */

import { existsSync } from "node:fs";
import { LocalStore, type VectorStore } from "./store.js";

export type StoreBackend = "local" | "s3-file" | "s3-vectors" | "opensearch";

export interface StoreConfig {
  backend: StoreBackend;
  localPath?: string;
  bucket?: string;
  key?: string;
  vectorBucket?: string;
  indexName?: string;
  region?: string;
}

export async function createStore(config: StoreConfig): Promise<VectorStore> {
  switch (config.backend) {
    case "local": {
      if (config.localPath && existsSync(config.localPath)) {
        return LocalStore.load(config.localPath);
      }
      return new LocalStore();
    }
    case "s3-file": {
      if (!config.bucket || !config.key) throw new Error("s3-file backend needs `bucket` and `key`");
      const { S3FileStore, s3Blob } = await import("./store-s3file.js");
      return new S3FileStore(s3Blob({ bucket: config.bucket, region: config.region }), config.key);
    }
    case "s3-vectors": {
      if (!config.vectorBucket || !config.indexName)
        throw new Error("s3-vectors backend needs `vectorBucket` and `indexName`");
      const { S3VectorsStore, s3VectorsApi } = await import("./store-s3vectors.js");
      return new S3VectorsStore(
        await s3VectorsApi({
          vectorBucket: config.vectorBucket,
          indexName: config.indexName,
          region: config.region,
        }),
      );
    }
    case "opensearch":
      throw new Error("opensearch backend is not implemented yet (R5) — use s3-vectors");
    default:
      throw new Error(`unknown vector-store backend: ${String(config.backend)}`);
  }
}
