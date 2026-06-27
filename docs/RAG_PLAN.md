# RAG plan (Phase B) — semantic knowledge retrieval

Goal: let the agent draw on the *entire* documentation corpus (hub docs, per-repo
`DOMAIN.md`/`CLAUDE.md`/`DECISIONS.md`, runbooks, past incidents) without stuffing it all into
the prompt. Today the always-on KB (`knowledge/`) must stay small; `skills/` is a curated,
named-fetch set. RAG covers the **long tail**: hundreds of docs, searched by meaning.

**When RAG vs skills:** skills = a handful of named, high-value runbooks (enumerable). RAG = a
large, growing corpus you can't enumerate, queried semantically. They coexist.

---

## 1. Architecture

```
INGESTION (offline: script now, CronJob on EKS)
  doc sources ──chunk──▶ Cohere embed (Bedrock) ──▶ vector store
                                                     (in-process index file → later OpenSearch k-NN)

QUERY (agent, read-only)
  agent calls search_knowledge("why does order-service drop events?")
    ─▶ embed query (Cohere/Bedrock)
    ─▶ k-NN / cosine top-K chunks
    ─▶ (optional) Cohere rerank top-N
    ─▶ return chunks + source citations  (agent reads, cites, verifies with live tools)
```

The small always-on KB (`service-catalog`, `topology`, `config-locations`) stays — it's the map.
RAG is the deep library behind it.

---

## 2. Tech choices

| Concern | Choice | Why |
|---|---|---|
| Embeddings | **Cohere `embed-v4` on Bedrock** | multilingual (docs mix EN/VN); confirmed invocable on the VN AWS account (non-Anthropic Bedrock works) |
| Rerank (optional) | **Cohere `rerank-v3-5` on Bedrock** | big precision boost on top-K |
| Vector store v1 | **in-process index file** (embeddings + metadata; cosine in memory) | zero new infra; fine for a few-thousand chunks; works local + EKS (built into a volume) |
| Vector store v2 | **OpenSearch k-NN** (existing cluster) | reuse infra; shared/managed; ingestion writes with a write user, agent reads only |
| Retrieval surface | in-process SDK MCP tool `search_knowledge` | same pattern as `fetch_skill`; read-only; gate already allows "search" |
| AWS calls | `@aws-sdk/client-bedrock-runtime` (IRSA in prod) | reuse the IAM path already used by `inspect_host` |

Cost: Cohere embed ≈ $0.10/M tokens. Indexing a few MB of docs = a few cents; per-query embed = negligible.

---

## 3. Components to build

1. **Chunker** (`src/rag/chunk.ts`): markdown-aware split by heading into ~300–800-token chunks
   with small overlap; keep metadata `{ source, heading, repo }`.
2. **Embedder** (`src/rag/embed.ts`): batch-embed chunks/query via Cohere on Bedrock (handles
   batching + retries). Read-only at query time.
3. **Store** (`src/rag/store.ts`): write/load the index; cosine top-K. v1 = a JSON/`.bin` file;
   interface kept so v2 = OpenSearch k-NN is a drop-in.
4. **Ingestion script** (`scripts/ingest.ts`): walk the configured doc roots → chunk → embed →
   write index. Idempotent; logs what it indexed; re-runnable.
5. **`search_knowledge` tool** (`src/rag/server.ts`): in-process SDK MCP server (`alwaysLoad`),
   `search_knowledge(query, k?)` → embed → retrieve → (rerank) → return chunks + citations.
6. **Wiring** (`agent.ts` + persona): register the tool; tell the agent to call `search_knowledge`
   for "how do we…", historical incidents, deep service internals — and to cite the source doc.

---

## 4. Corpus (configurable `COPILOT_RAG_SOURCES`)

Start with the highest-value, already-curated docs:
- `devops-mcp-hub/docs/*` (API_DOMAIN_MAP, SERVICES, SERVICE_CATALOG, runbooks)
- per-repo `DOMAIN.md` / `CLAUDE.md` / `DECISIONS.md` across your local source roots
- (optional, sensitive) the memory files — many encode resolved incidents

Exclude secrets/large binaries. Tag each chunk with its source path for citation.

---

## 5. Phases

| Phase | Deliverable | Effort |
|---|---|---|
| **R1** | chunker + embedder + in-process store + ingestion script; build index over hub docs + a few DOMAIN.md | ~half day |
| **R2** | `search_knowledge` tool + agent wiring + persona note; verify a "how do we…" question retrieves the right doc | ~half day |
| **R3** | add Cohere rerank; expand corpus; tune k/chunk size | ~few hrs |
| **R4 (deploy)** | move store to OpenSearch k-NN; ingestion as a CronJob (re-index on a schedule); IRSA for Bedrock | Phase-2 deploy work |

R1+R2 = a working RAG end-to-end. R3/R4 = quality + production.

---

## 6. Decisions needed
1. **Vector store**: start in-process file index (recommended) vs go straight to OpenSearch k-NN?
2. **Bedrock access for embeddings**: confirm the app's IAM (a local profile / IRSA in prod) can
   `bedrock:InvokeModel` on `cohere.embed-v4` + `cohere.rerank-v3-5`.
3. **Corpus**: hub docs + DOMAIN.md only, or include memory files (incident history)?
4. **Freshness**: one-time build now, CronJob re-index later — OK?

## 7. Risks / notes
- Keep RAG **additive**: the agent should still prefer the small always-on catalog + live tools;
  `search_knowledge` is for depth/history, not a replacement.
- Citations are mandatory — return the source path so answers stay verifiable ([OBS]/[CANDIDATE]).
- Re-embedding only changed files keeps re-index cheap (hash per file).
- Read-only stays intact: ingestion (write) is a separate offline job; the agent only queries.
