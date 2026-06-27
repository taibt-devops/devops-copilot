# RAG plan (Phase B) — semantic knowledge retrieval

Goal: let the agent draw on the *entire* documentation corpus (hub docs, per-repo
`DOMAIN.md`/`CLAUDE.md`/`DECISIONS.md`, runbooks, past incidents) without stuffing it all into
the prompt. Today the always-on KB (`knowledge/`) must stay small; `skills/` is a curated,
named-fetch set. RAG covers the **long tail**: hundreds of docs, searched by meaning.

**When RAG vs skills:** skills = a handful of named, high-value runbooks (enumerable). RAG = a
large, growing corpus you can't enumerate, queried semantically. They coexist.

**RAG is an OPT-IN tier.** The app must run fully on just `knowledge/` + `skills/` with **zero
extra infra**. RAG is enabled by a deploy flag; when off, nothing about Bedrock/S3 is required.
When on, it degrades soft — if the index/embed backend is unreachable, the agent falls back to
`knowledge/` + `skills/` + live tools instead of erroring.

---

## 1. Architecture

```
INGESTION (offline: script now, CronJob on EKS — only runs when RAG is enabled)
  doc sources ──chunk──▶ Cohere embed (Bedrock) ──▶ vector store
                                                     (local file → S3 Vectors → OpenSearch k-NN)

QUERY (agent, read-only)
  agent calls search_knowledge("why does order-service drop events?")
    ─▶ embed query (Cohere/Bedrock)
    ─▶ k-NN / cosine top-K chunks   (in the configured store)
    ─▶ (optional) Cohere rerank top-N
    ─▶ return chunks + source citations  (agent reads, cites, verifies with live tools)
```

The small always-on KB (`service-catalog`, `topology`, `config-locations`) stays — it's the map.
RAG is the deep library behind it.

---

## 2. Deploy toggles (layered, opt-in)

| Env | Default | Effect |
|---|---|---|
| `COPILOT_RAG_ENABLED` | `false` | Master switch. Off → `search_knowledge` tool is NOT registered, no Bedrock/S3 needed, persona doesn't mention it. |
| `COPILOT_RAG_STORE` | `local` | Which vector store backend (see §3). |
| `COPILOT_RAG_SOURCES` | — | Doc roots to index (when enabled). |
| `COPILOT_RAG_BUCKET` | — | S3 bucket / vector bucket (for `s3-file` / `s3-vectors`). |

Wiring follows the existing conditional-server pattern in `agent.ts`
(`...(CONFIG.hostInspectEnabled ? { host: hostServer } : {})`), so RAG slots in as
`...(CONFIG.ragEnabled ? { knowledge: searchKnowledgeServer } : {})`.

---

## 3. Vector store — tiers (one interface, swap by flag)

All backends implement the same `store.search(queryVector, k)` / `store.upsert(chunks)` interface,
so moving up a tier is a drop-in change, not a rewrite.

| `COPILOT_RAG_STORE` | Where vectors live | k-NN runs | Good when | Infra / cost |
|---|---|---|---|---|
| `local` | a file on the pod/disk (`.bin`/JSON) | in-process (cosine in RAM) | dev, single pod | **zero infra** |
| `s3-file` | one index file in S3; pods download at boot | in-process (cosine in RAM) | many stateless pods, no DB | **~cents** (S3 storage) |
| **`s3-vectors`** ⭐ | **Amazon S3 Vectors** (native vector bucket) | **in S3 (native k-NN)** | large/growing corpus, **infrequent** queries | **lowest** — ~up to 90% cheaper than vector DBs |
| `opensearch` | OpenSearch index (k-NN enabled) | in the cluster | high QPS / realtime / very large | reuse cluster |

**Recommended path:** `local` for dev → **`s3-vectors` for production.**

### Why S3 Vectors is the production default
- **Native similarity search in S3** — no need to load the whole index into RAM (unlike `s3-file`)
  and no cluster to run (unlike OpenSearch). You query the vector bucket directly.
- **Cost** — purpose-built as low-cost vector storage (AWS positions it ~up to 90% cheaper than
  running a vector DB), trading sub-second (not millisecond) latency for price.
- **Fits this workload** — a single-operator incident tool queries the corpus **infrequently**
  (tens of times/day) and tolerates sub-second retrieval — exactly S3 Vectors' sweet spot.
- **Integrates** with Bedrock and OpenSearch, so a later hot/cold tiering (hot vectors in
  OpenSearch, cold in S3 Vectors) is possible without re-architecting.
- **Reuses IAM/IRSA** already wired for `inspect_host` (read-only `s3:GetVectors` for the pod;
  ingestion writes with a separate scoped identity).

> If you ever need high-QPS realtime retrieval, set `COPILOT_RAG_STORE=opensearch`. For this app's
> usage pattern, S3 Vectors is cheaper and simpler.

---

## 4. Tech choices

| Concern | Choice | Why |
|---|---|---|
| Embeddings | **Cohere `embed-v4` on Bedrock** | multilingual (docs mix EN/VN); non-Anthropic Bedrock works on the AWS account |
| Rerank (optional) | **Cohere `rerank-v3-5` on Bedrock** | big precision boost on top-K |
| Vector store | **tiered: `local` → `s3-file` → `s3-vectors` (default prod) → `opensearch`** | start zero-infra, scale by flag; S3 Vectors = cheapest for infrequent queries |
| Retrieval surface | in-process SDK MCP tool `search_knowledge` | same pattern as `fetch_skill`; read-only; gate already allows "search" |
| AWS calls | `@aws-sdk/client-bedrock-runtime` + `@aws-sdk/client-s3` (S3 Vectors API) | reuse the IAM/IRSA path already used by `inspect_host` |

Cost: Cohere embed ≈ $0.10/M tokens. Indexing a few MB of docs = a few cents; per-query embed =
negligible. S3 Vectors storage/query for this corpus ≈ cents/month.

---

## 5. Components to build

1. **Chunker** (`src/rag/chunk.ts`): markdown-aware split by heading into ~300–800-token chunks
   with small overlap; keep metadata `{ source, heading, repo }`. Non-markdown → split by
   paragraph/length.
2. **Embedder** (`src/rag/embed.ts`): batch-embed chunks/query via Cohere on Bedrock (handles
   batching + retries). Read-only at query time.
3. **Store** (`src/rag/store.ts`): one interface, multiple backends selected by `COPILOT_RAG_STORE`:
   `local` (file + cosine), `s3-file` (S3 object + cosine in RAM), `s3-vectors` (S3 Vectors native
   k-NN), `opensearch` (cluster k-NN). Drop-in by config.
4. **Ingestion script** (`scripts/ingest.ts`): walk the configured doc roots → chunk → embed →
   write to the configured store. Idempotent; re-embeds only changed files (hash per file); logs
   what it indexed. Runs offline / as a CronJob — never in the request path.
5. **`search_knowledge` tool** (`src/rag/server.ts`): in-process SDK MCP server (`alwaysLoad`),
   `search_knowledge(query, k?)` → embed → retrieve → (rerank) → return chunks + citations.
   **Fail-soft**: if embed/store is unavailable, return a clear "knowledge index unavailable" so the
   agent falls back to `knowledge/` + `skills/`.
6. **Wiring** (`agent.ts` + persona): register the tool **only when `COPILOT_RAG_ENABLED`**; tell the
   agent (only then) to call `search_knowledge` for "how do we…", historical incidents, deep service
   internals — and to cite the source doc.

---

## 6. Corpus (configurable `COPILOT_RAG_SOURCES`)

Start with the highest-value, already-curated docs:
- hub docs (API domain map, services, service catalog, runbooks)
- per-repo `DOMAIN.md` / `CLAUDE.md` / `DECISIONS.md` across your local source roots
- (optional, sensitive) the memory files — many encode resolved incidents

Exclude secrets/large binaries. Tag each chunk with its source path for citation.

---

## 7. Phases

| Phase | Deliverable | Effort |
|---|---|---|
| **R1** | chunker + embedder + `local` store + ingestion script; build index over hub docs + a few DOMAIN.md | ~half day |
| **R2** | `search_knowledge` tool + agent wiring behind `COPILOT_RAG_ENABLED` + persona note; verify a "how do we…" question retrieves the right doc; fail-soft fallback | ~half day |
| **R3** | add Cohere rerank; expand corpus; tune k/chunk size | ~few hrs |
| **R4 (deploy)** | add `s3-file` + **`s3-vectors`** backends; ingestion as a CronJob (re-index on a schedule); IRSA for Bedrock + S3 Vectors | Phase-2 deploy work |
| **R5 (optional)** | `opensearch` backend for high-QPS/realtime; or hot/cold tiering with S3 Vectors | as needed |

R1+R2 = a working RAG end-to-end (on `local`). R3 = quality. R4 = production on S3 Vectors.

---

## 8. Decisions needed
1. **Store path**: confirm `local` (dev) → **`s3-vectors`** (prod) as the default, keeping
   `opensearch` as an escape hatch for high QPS.
2. **Bedrock access for embeddings**: confirm the app's IAM (a local profile / IRSA in prod) can
   `bedrock:InvokeModel` on `cohere.embed-v4` + `cohere.rerank-v3-5`.
3. **S3 Vectors access**: confirm the region offers S3 Vectors and the pod IAM can read the vector
   bucket (ingestion writes with a separate scoped identity).
4. **Corpus**: hub docs + DOMAIN.md only, or include memory files (incident history)?
5. **Freshness**: one-time build now, CronJob re-index later — OK?

## 9. Risks / notes
- Keep RAG **additive and opt-in**: default OFF; the agent still prefers the small always-on
  catalog + live tools; `search_knowledge` is for depth/history, not a replacement.
- **Fail-soft** is mandatory: RAG enabled but backend down → fall back, never crash a request.
- Citations are mandatory — return the source path so answers stay verifiable ([OBS]/[CANDIDATE]).
- Re-embedding only changed files keeps re-index cheap (hash per file).
- Read-only stays intact: ingestion (write) is a separate offline job; the agent only queries
  (read-only store access).
- S3 Vectors trades latency for cost — fine for infrequent incident queries; switch to OpenSearch
  if you ever need realtime/high-QPS retrieval.
- **Embedding provider availability:** Cohere on Bedrock is sold via AWS Marketplace and can be
  blocked in some countries ("this offer is not available to accept in this country"). The embedder
  auto-detects the provider from the model id and also supports **Amazon Titan**
  (`amazon.titan-embed-text-v2:0`, no Marketplace, available everywhere) — verified end-to-end
  (chunk → embed → local store → cited retrieval) on the dev AWS account.
