# DevOps Copilot

**Ask your infrastructure what's wrong — in plain language, from your phone — and get a
cited answer instead of five open dashboards.**

DevOps Copilot is an open, **read-only** AI assistant that investigates production incidents
for you. You ask a normal question; it autonomously queries your existing observability, CI,
and cloud stack through **MCP**, correlates the evidence, and replies with the probable cause,
the **sources it used**, and a **confidence level** — without ever touching production.

```
You:  Why is checkout-api returning 401 in prod since ~10:40?
      ↓
Copilot:  [OBS] checkout-api started returning 401 at 10:41, right after deploy #482.
          The deploy rotated the auth service account but the API still holds the old
          JWT audience. Evidence: OpenSearch `checkout-*` logs (401 "aud mismatch"),
          Jenkins job #482 (10:39), k8s rollout at 10:40.
          Fix (for you to run — I can't): redeploy checkout-api to pick up the new aud,
          or roll back #482.
```

## The problem it solves

When something breaks at 2am, diagnosis is slow and lonely:

- You're **alt-tabbing across five tools** — logs, traces, dashboards, CI, tickets — trying to
  line up *what changed* with *what broke*.
- The know-how to do that fast lives in **one senior engineer's head** (and their laptop). When
  they're asleep or on leave, MTTR balloons.
- Most "AI for ops" tools are scary because they can **act** on prod. You don't want an LLM
  restarting things at 2am.

DevOps Copilot turns that tribal, single-machine capability into an **always-on service you can
reach from a phone**, and makes it safe to trust by being **read-only by construction** — it can
read and reason across everything, but it is *physically incapable* of changing your
infrastructure (enforced in code across three layers, not by a prompt). It accelerates the
slowest part of an incident — *diagnosis* — and leaves the *fix* to a human.

Built on the **[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)**
(the same engine as Claude Code), it **reuses the MCP servers you already run** (Grafana,
OpenSearch, Jenkins, Kubernetes, AWS, …) — no new agents to install on your boxes.

> **Use it / fork it.** This is an open reference implementation: clone it, point it at your own
> stack via env + the `knowledge/` folder, and you have an incident copilot for *your* infra. All
> example hostnames, services, and runbooks in the repo are placeholders.

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
