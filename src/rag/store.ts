/**
 * Vector store — pluggable backends behind one interface (docs/RAG_PLAN.md §3).
 *
 * This file holds the interface, cosine similarity, and the zero-infra `LocalStore`
 * (in-memory index with optional file persistence). S3 / OpenSearch backends live in
 * sibling files and implement the same `VectorStore` interface, so the retrieval code
 * never knows which backend is in use.
 */

export interface StoredChunk {
  id: string;
  vector: number[];
  text: string;
  source: string;
  heading: string;
  repo?: string;
}

export interface SearchHit {
  score: number;
  chunk: StoredChunk;
}

export interface VectorStore {
  upsert(records: StoredChunk[]): Promise<void>;
  search(queryVector: number[], k: number): Promise<SearchHit[]>;
}

/** Cosine similarity in [-1, 1]; 1 = identical direction, 0 = orthogonal. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** In-process vector index: cosine top-K in memory. Zero infra. */
export class LocalStore implements VectorStore {
  private records: StoredChunk[] = [];

  async upsert(records: StoredChunk[]): Promise<void> {
    const byId = new Map(this.records.map((r) => [r.id, r]));
    for (const r of records) byId.set(r.id, r);
    this.records = [...byId.values()];
  }

  async search(queryVector: number[], k: number): Promise<SearchHit[]> {
    return this.records
      .map((chunk) => ({ score: cosineSimilarity(queryVector, chunk.vector), chunk }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /** Serialize the index to a JSON string (also used by the S3 file backend). */
  serialize(): string {
    return JSON.stringify({ version: 1, records: this.records });
  }

  /** Rebuild a store from a serialized JSON string. */
  static deserialize(json: string): LocalStore {
    const store = new LocalStore();
    const parsed = JSON.parse(json) as { records?: StoredChunk[] };
    store.records = parsed.records ?? [];
    return store;
  }

  async save(file: string): Promise<void> {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, this.serialize(), "utf8");
  }

  static async load(file: string): Promise<LocalStore> {
    const { readFile } = await import("node:fs/promises");
    return LocalStore.deserialize(await readFile(file, "utf8"));
  }
}
