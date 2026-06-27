# DevOps Copilot

A single-user, **read-only** AI assistant for incident response over your own infrastructure.
Ask it operational questions in natural language ("why is `auth-service` returning 401?") from
your phone during an incident; it investigates by querying your existing observability + CI +
cloud stack through **MCP** and answers with **cited sources** and a **calibrated confidence level**.

Built on the **[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)**
(the same engine as Claude Code), it reuses your existing MCP servers (Grafana, OpenSearch,
Jenkins, Kubernetes, AWS, …) but with **every mutating tool blocked in code** — it can read and
diagnose, never change anything.

> This is a reference implementation / portfolio project. All example hostnames, accounts,
> service names and runbooks are placeholders — wire it to your own stack via env + `knowledge/`.

## Why

A lot of incident-investigation capability tends to live inside one engineer's IDE on one
machine: the MCP tooling, the accumulated runbooks, the muscle memory of correlating logs ↔
traces ↔ deploys ↔ tickets. This turns that into an always-on service reachable from a phone,
so diagnosis isn't gated on one person being at one desk — while staying **read-only by
construction** so it never adds risk to production.

## Key properties

| | |
|---|---|
| **Engine** | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) |
| **Interface** | Mobile-first web UI (streaming chat over SSE) |
| **Tools** | Your existing MCP servers, **read-only** (mutating tools gated off in code) |
| **Safety** | 3 independent layers block mutation (see below) — enforced in code, not by prompt |
| **Auth to Claude** | Max/Pro subscription via `CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_API_KEY` |
| **Deploy** | Single container (Docker); optionally a pod on EKS with IRSA + an OIDC provider |
| **Evidence** | Every claim cites its source + a `[OBS]`/`[CANDIDATE]`/`[?]` confidence label |

### Read-only enforcement (3 layers)
1. **`canUseTool` gate** (`src/readonly.ts`) — classifies every tool call by verb and denies any
   mutating one; inspects command-style tools (e.g. `call_aws`) for write operations in their input.
2. **`disallowedTools`** — hard-denies shell / file-write / arbitrary-fetch built-ins.
3. **Read-only credentials/roles** on the MCP servers and IAM themselves (defense in depth).

### How it keeps context small
- **Knowledge base** (`knowledge/*.md`) concatenated into the system prompt (prompt-cached).
- **Skills** (`skills/*.md`) — runbooks fetched **on demand** via a `fetch_skill` tool; only their
  one-line catalog is in the prompt.
- **Learned memory** + **Q&A history** — durable facts and past investigations, recalled via tools.
- **Output spill-to-disk** — oversized tool results are spilled to a file; the agent pulls only the
  slice it needs via a read-only `query_result` tool.
- **RAG (`src/rag/`, opt-in, off by default)** — semantic retrieval over a large doc corpus: Cohere
  embeddings on AWS Bedrock with a pluggable vector store (local file → **Amazon S3 Vectors** →
  OpenSearch k-NN), exposed as a read-only `search_knowledge` tool. Toggled by `COPILOT_RAG_ENABLED`
  and **fail-soft** (falls back to knowledge/skills/live tools if the index is unavailable). Build the
  index with `npm run ingest ./knowledge`. See [`docs/RAG_PLAN.md`](docs/RAG_PLAN.md).

## Repo layout

```
devops-copilot/
├── src/
│   ├── server.ts      # HTTP + SSE endpoint, session handling
│   ├── agent.ts       # Claude Agent SDK wrapper (the core loop)
│   ├── readonly.ts    # canUseTool gate — blocks all mutating tools
│   ├── knowledge.ts   # builds the system prompt (persona + knowledge/)
│   ├── skills.ts      # on-demand runbook fetch (fetch_skill)
│   ├── memory.ts      # durable learned facts (save_memory)
│   ├── history.ts     # Q&A history (search_history)
│   ├── spill.ts       # spill oversized tool output (query_result)
│   ├── mcp.ts         # load a read-only subset of MCP servers
│   ├── hostcmd.ts     # inspect_host — allowlisted read-only SSM command
│   ├── jenkins.ts     # recursive Jenkins folder search
│   ├── secrets.ts     # hydrate tokens from AWS Secrets Manager at boot
│   ├── config.ts      # 12-factor config from env
│   └── rag/           # opt-in RAG: chunk, embed, store (local/S3-file/S3-Vectors), search_knowledge
├── scripts/ingest.ts  # build/refresh the RAG vector index (offline / cron)
├── test/              # node:test unit tests (chunker, store, embed, retrieve, …)
├── knowledge/         # always-on context (example files; bring your own)
├── skills/            # on-demand runbooks (example file; bring your own)
├── web/index.html     # mobile-first streaming UI
├── deploy/            # Dockerfile, k8s SA, MCP template, source-sync scripts
└── docs/              # ARCHITECTURE (diagrams) + SPEC + RAG plan
```

## Quickstart

```bash
# 1. Authenticate with a Claude Max/Pro subscription (interactive, one-time)
claude setup-token            # prints a token, valid ~1 year

# 2. Configure
cp .env.example .env
#   set CLAUDE_CODE_OAUTH_TOKEN=<token from step 1> (or ANTHROPIC_API_KEY)
#   point COPILOT_MCP_CONFIG at an MCP config (see deploy/mcp.template.json)

# 3. Run locally
npm install
npm run dev                   # http://localhost:8787

# 4. Ask
#   open the UI and type a question about your infra
```

Wire it to your own environment by editing `knowledge/` (topology, conventions), adding your
runbooks to `skills/`, and pointing the MCP config at your Grafana/OpenSearch/Jenkins/etc.
See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the pieces fit (diagrams),
[`deploy/README.md`](deploy/README.md) for the container deploy, and [`docs/SPEC.md`](docs/SPEC.md)
for the full design.

## License

MIT — see [LICENSE](LICENSE).
