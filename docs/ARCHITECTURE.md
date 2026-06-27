# Architecture

DevOps Copilot is a single-user, **read-only** AI incident-response assistant. It wraps the
[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) in a small
Fastify server, exposes a streaming mobile UI, and lets the agent investigate your
infrastructure through your existing **MCP** servers — with every mutating tool blocked in
code, not by prompt.

This document is the map of how the pieces fit. For the *why* and the product spec see
[`SPEC.md`](SPEC.md); for the retrieval layer see [`RAG_PLAN.md`](RAG_PLAN.md).

---

## 1. Request flow (end to end)

```
 ┌─────────┐   HTTPS    ┌───────────────┐   (optional)   ┌──────────────┐
 │  Phone  │──────────▶│ ALB + OIDC SSO │───────────────▶│  your IdP    │
 │ browser │           └───────┬───────┘  locked to the  │ (Keycloak/…) │
 └─────────┘                   │          single operator └──────────────┘
                               ▼
                     ┌───────────────────┐
                     │   server.ts       │  Fastify
                     │   POST /ask (SSE) │  GET / (UI)  GET /healthz
                     │   GET /history    │  GET/DELETE /memory
                     └─────────┬─────────┘
                               │ ask(question, sessionId)  → async generator of SSE events
                               ▼
                     ┌───────────────────┐
                     │   agent.ts        │  Claude Agent SDK `query()` loop
                     │                   │
                     │  systemPrompt ────┼─ knowledge.ts (persona + knowledge/ + memory + RAG note)
                     │  canUseTool ──────┼─ readonly.ts   (per-tool gate)  ◀── HARD READ-ONLY
                     │  disallowedTools ─┼─ readonly.ts   (shell/write/fetch denied)
                     │  hooks.PostToolUse┼─ spill.ts      (spill oversized output)
                     │  mcpServers ──────┼─ see §4
                     └─────────┬─────────┘
                               │ tool calls (READ-ONLY)
              ┌────────────────┼─────────────────────────────┐
              ▼                ▼                              ▼
        Hub MCP servers   In-process SDK tools          AWS (read-only)
        Grafana, Open-    fetch_skill, search_history,  EC2/SSM describe,
        Search, Jenkins,  save_memory, query_result,    Bedrock embed,
        Kubernetes, …     search_knowledge, inspect_host S3 (Vectors/file)
                               │
                               ▼  text deltas + tool events
                     stream back over SSE → rendered live in web/index.html
```

Notable details:
- **`server.ts` hydrates secrets *before* importing `agent.ts`.** The agent builds its MCP
  servers from env-expanded config at import time, so `hydrateSecrets()` (AWS Secrets Manager →
  `process.env`) must run first; `agent.js` is then dynamically imported.
- **`/ask` is a raw SSE stream.** The handler hijacks the reply and writes `data: {…}` events
  (`session`, `text`, `tool`, `done`, `error`) as the agent yields them.
- **State is the app's own, never infra.** Each Q&A is appended to a JSONL history; the agent can
  recall past investigations via `search_history` and durable facts via learned memory.

---

## 2. Read-only enforcement (3 independent layers)

Read-only is the defining property and is enforced **in code**, never by trusting the prompt.

```
 tool call
    │
    ▼
 ┌─────────────────────────────────────────────┐
 │ Layer 1 — canUseTool gate (readonly.ts)      │
 │  • classify the action verb (get/list/…) ✓   │
 │  • deny any write verb (create/delete/…) ✗   │
 │  • for command tools (call_aws), inspect the │
 │    INPUT for mutating ops (terminate, put-…) │
 └───────────────┬─────────────────────────────┘
                 │ allowed?
                 ▼
 ┌─────────────────────────────────────────────┐
 │ Layer 2 — disallowedTools                    │
 │  hard-deny Bash, Edit, Write, NotebookEdit,  │
 │  WebFetch (shell / file-write / exfiltration)│
 └───────────────┬─────────────────────────────┘
                 │
                 ▼
 ┌─────────────────────────────────────────────┐
 │ Layer 3 — read-only credentials / roles      │
 │  read-only IAM (IRSA), read-only MCP users,  │
 │  EKS RBAC get/list/watch, READ_OPERATIONS    │
 │  on the aws-api server                        │
 └─────────────────────────────────────────────┘
```

If a fix needs a mutation, the agent **describes** the exact change for a human to run — it can
never perform it. A separate persona rule also prevents dumping production secrets/PII to the chat.

---

## 3. Context management — how it stays small and cheap

The agent's knowledge is layered so the always-on prompt stays small while depth is available on
demand:

| Tier | Mechanism | In the prompt? |
|---|---|---|
| **Knowledge base** (`knowledge/*.md`) | concatenated into the system prompt (prompt-cached) | always (keep small) |
| **Skills** (`skills/*.md`) | runbooks fetched on demand via `fetch_skill` | only a 1-line catalog |
| **Learned memory** | durable facts via `save_memory`, injected each request | small, curated |
| **Q&A history** | every answer to JSONL; recalled via `search_history` | no (tool-fetched) |
| **Output spill** | oversized tool results spilled to disk; read via `query_result` | no (a preview + pointer) |
| **RAG** (opt-in) | semantic search over a large corpus via `search_knowledge` | no (tool-fetched) |

This is the core idea: **inject a map, fetch the territory on demand.**

---

## 4. MCP tool surface

`agent.ts` assembles one `mcpServers` map. Some servers are conditional (registered only when
enabled), mirroring the existing pattern:

```
mcpServers = {
  ...loadMcpServers(),        // hub: grafana, opensearch, jenkins, kubernetes, backlog, aws-api
  skills,                     // fetch_skill        (runbooks on demand)
  results,                    // query_result       (read a slice of spilled output)
  history,                    // search_history     (recall past Q&A)
  memory,                     // save_memory        (record a durable fact)
  ...(hasJenkinsFinder        ? { "jenkins-find": … } : {}),   // recursive Jenkins folder search
  ...(hostInspectEnabled      ? { host: … }          : {}),    // inspect_host (allowlisted SSM)
  ...(rag.enabled             ? { knowledge: … }     : {}),    // search_knowledge (RAG, opt-in)
}
```

- **Hub servers** come from an existing `.mcp.json` (read-only subset selected by config); the
  read-only gate lets the app safely reuse the same definitions.
- **In-process SDK servers** are tiny tools defined in this repo (`createSdkMcpServer`). They are
  read-only and operate on the app's own state or read-only APIs.

---

## 5. RAG pipeline (opt-in)

Disabled by default (`COPILOT_RAG_ENABLED=false`) → zero extra infra. When enabled, two halves:

```
INGESTION  (offline: `npm run ingest`, or a cron/CronJob)
  knowledge/ + docs ──chunk──▶ embed (Bedrock) ──▶ vector store
   chunk.ts: heading-aware     embed.ts:            store-factory.ts:
   split, overlap, metadata    Cohere or Titan      local | s3-file | s3-vectors | opensearch
                               (provider auto-                  ▲
                                inferred from id)               │ stable ids → idempotent re-index

QUERY  (agent, read-only — search.ts `search_knowledge` tool)
  query ──embed──▶ k-NN top-K ──▶ format + cite ──▶ agent reads, cites, verifies w/ live tools
   retrieve.ts                        (fail-soft: if embed/store is down, returns a fallback
                                        message so the agent uses knowledge/skills/live tools)
```

- **One `VectorStore` interface, many backends** (`store.ts` + `store-*.ts`), chosen by
  `COPILOT_RAG_STORE`. `local` is the zero-infra default; **Amazon S3 Vectors** is the
  recommended production store (native k-NN, lowest cost for infrequent queries).
- **Provider-agnostic embeddings.** `embed.ts` infers Cohere vs Titan from the model id and
  parses each response shape. (Cohere on Bedrock is Marketplace-gated and may be blocked in some
  countries; Amazon Titan works everywhere — verified end-to-end.)
- **Fail-soft by design** (`searchKnowledgeText` never throws) — RAG is additive, never a
  single point of failure for a request.

See [`RAG_PLAN.md`](RAG_PLAN.md) for the full design and decisions.

---

## 6. Module map

```
src/
  server.ts      HTTP + SSE, session handling, /history & /memory endpoints
  agent.ts       the Claude Agent SDK loop; assembles the read-only tool surface
  readonly.ts    canUseTool gate + disallowedTools (read-only, layers 1–2)
  knowledge.ts   builds the system prompt (persona + knowledge/ + memory + RAG note)
  skills.ts      fetch_skill — on-demand runbooks
  memory.ts      save_memory — durable learned facts
  history.ts     search_history — recall past Q&A
  spill.ts       PostToolUse hook + query_result — tame oversized output
  mcp.ts         load a read-only subset of hub MCP servers (+ app-local aws-api)
  hostcmd.ts     inspect_host — allowlisted read-only command via SSM
  jenkins.ts     recursive Jenkins folder search
  secrets.ts     hydrate tokens from AWS Secrets Manager at boot
  config.ts      12-factor config from env
  rag/           chunk · embed · store(+s3file/s3vectors/factory) · retrieve · search · ingest
scripts/ingest.ts  build/refresh the RAG index (offline)
test/              node:test unit tests
web/index.html     mobile-first streaming UI
```

---

## 7. Deploy topology

```
                    Internet
                       │  HTTPS
              ┌────────▼─────────┐
              │  ALB + OIDC SSO  │  (locked to the operator identity)
              └────────┬─────────┘
                       │
        ┌──────────────▼───────────────┐   single container / EKS pod (non-root)
        │  devops-copilot               │
        │   Node + tsx/dist             │
        │   reads MCP tokens + Claude    │◀── AWS Secrets Manager (hydrated at boot)
        │   token from env (hydrated)    │
        └───┬───────────────┬───────────┘
            │ read-only      │ read-only mounts
            ▼ IAM (IRSA)     ▼
     AWS describe / SSM /    /srv/code  (source, ro)   ~/.kube (ro)
     Bedrock / S3 Vectors    Greppable code for the    read-only EKS
                             agent                     get/list/watch
```

- **One read-only IAM identity** for everything (secret read, EC2/SSM describe, Bedrock, S3,
  EKS get/list/watch). No write actions anywhere.
- **No secrets in the image.** The MCP config template carries only `${VAR}` placeholders; values
  are injected from Secrets Manager at boot.
- **Source code** is bind-mounted read-only so the agent can Grep/Read it directly during an
  investigation (kept fresh by `deploy/refresh-source.sh`).

See [`../deploy/README.md`](../deploy/README.md) for the concrete container setup.
