#!/usr/bin/env node
/**
 * Ingestion CLI — build/refresh the RAG vector index (docs/RAG_PLAN.md §5).
 *
 *   COPILOT_RAG_STORE=local node --import tsx scripts/ingest.ts ./knowledge ./docs
 *
 * Walks the given doc roots (or COPILOT_RAG_SOURCES) for *.md files, chunks + embeds them
 * via Cohere on Bedrock, and writes to the configured store. Offline / cron — never in the
 * request path. Re-running is idempotent (stable chunk ids overwrite).
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CONFIG } from "../src/config.js";
import { createEmbedder, bedrockInvoke } from "../src/rag/embed.js";
import { createStore } from "../src/rag/store-factory.js";
import { ingestDocs, type DocFile } from "../src/rag/ingest.js";
import { LocalStore } from "../src/rag/store.js";

const SKIP = new Set(["node_modules", ".git", "dist", "build", "data"]);

function walkMd(root: string): DocFile[] {
  const out: DocFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".md")) {
        out.push({ source: relative(process.cwd(), p).replace(/\\/g, "/"), content: readFileSync(p, "utf8") });
      }
    }
  };
  walk(root);
  return out;
}

async function main() {
  const roots = process.argv.slice(2).length ? process.argv.slice(2) : CONFIG.rag.sources;
  if (!roots.length) {
    console.error("ingest: no doc roots. Pass them as args or set COPILOT_RAG_SOURCES.");
    process.exit(1);
  }
  const docs = roots.flatMap(walkMd);
  if (!docs.length) {
    console.error(`ingest: no .md files under ${roots.join(", ")}`);
    process.exit(1);
  }

  const embedder = createEmbedder(
    bedrockInvoke({ region: CONFIG.rag.store.region }),
    CONFIG.rag.embedModelId,
  );
  const store = await createStore({ ...CONFIG.rag.store, backend: CONFIG.rag.store.backend as never });

  const res = await ingestDocs(docs, embedder, store);

  // The local backend keeps the index in memory — persist it to disk.
  if (CONFIG.rag.store.backend === "local") {
    await (store as LocalStore).save(CONFIG.rag.store.localPath);
    console.log(`ingest: wrote ${CONFIG.rag.store.localPath}`);
  }
  console.log(`ingest: ${res.chunks} chunks from ${docs.length} docs (store=${CONFIG.rag.store.backend})`);
}

main().catch((err) => {
  console.error("ingest failed:", err);
  process.exit(1);
});
