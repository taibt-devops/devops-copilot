/**
 * S3 file backend — store the whole index as ONE object in S3; load it into a LocalStore
 * (cosine in RAM) for search. Zero database, stateless pods, ~cents (docs/RAG_PLAN.md §3).
 *
 * The store talks to a tiny `BlobStore` (get/put one key) so it is testable without AWS.
 * `s3Blob` is the real adapter over the AWS S3 client.
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { LocalStore, type SearchHit, type StoredChunk, type VectorStore } from "./store.js";

export interface BlobStore {
  get(key: string): Promise<string | null>;
  put(key: string, body: string): Promise<void>;
}

export class S3FileStore implements VectorStore {
  private inner?: LocalStore;

  constructor(private blob: BlobStore, private key: string) {}

  private async load(): Promise<LocalStore> {
    if (!this.inner) {
      const raw = await this.blob.get(this.key);
      this.inner = raw ? LocalStore.deserialize(raw) : new LocalStore();
    }
    return this.inner;
  }

  async upsert(records: StoredChunk[]): Promise<void> {
    const store = await this.load();
    await store.upsert(records);
    await this.blob.put(this.key, store.serialize());
  }

  async search(queryVector: number[], k: number): Promise<SearchHit[]> {
    return (await this.load()).search(queryVector, k);
  }
}

/** Real adapter: one S3 object per index key. */
export function s3Blob(opts: { bucket: string; region?: string; client?: S3Client }): BlobStore {
  const client = opts.client ?? new S3Client({ region: opts.region });
  return {
    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: opts.bucket, Key: key }));
        return (await res.Body?.transformToString()) ?? null;
      } catch (err) {
        if ((err as { name?: string }).name === "NoSuchKey") return null;
        throw err;
      }
    },
    async put(key, body) {
      await client.send(
        new PutObjectCommand({ Bucket: opts.bucket, Key: key, Body: body, ContentType: "application/json" }),
      );
    },
  };
}
