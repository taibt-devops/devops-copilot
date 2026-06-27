# DevOps Copilot — Specification

**Version:** 0.1 (draft)
**Owner:** ops (single operator)
**Status:** Pre-implementation. This document defines what we will build before any code.

---

## 1. Problem & Purpose

The team's DevOps capability — querying Grafana/OpenSearch/Jenkins/Kubernetes, correlating
logs to traces, applying accumulated runbook knowledge — currently lives only inside Claude
Code running in VS Code on one workstation. It is not reachable when away from that machine,
and nothing runs proactively.

**DevOps Copilot** packages that capability as an always-on, single-user service the operator
can reach from a phone during an incident. It answers natural-language operational questions
("why is `auth-service` returning 401?", "is `payment-api` actually down or is the client
stuck at 95%?") by autonomously investigating through the existing MCP tooling, then replies
with cited evidence and a confidence level.

It is **diagnostic only**: it can read everything, change nothing.

---

## 2. Goals & Non-Goals

### Goals
- Answer operational/incident questions in natural language, from a phone, anywhere.
- Reuse the **existing MCP hub** (no re-implementing integrations).
- **Read-only**: physically incapable of mutating infrastructure.
- Cite sources (which log index, dashboard, job, namespace) and surface a confidence level
  using the existing trust-label convention (`[OBS]`/`[CANDIDATE]`/`[?]`).
- Be cheap to start (Claude Max subscription, $0 extra) and trivially switchable to API
  billing later.
- Deploy as a single pod on the existing EKS cluster.

### Non-Goals (v1)
- Multi-user / multi-tenant access, RBAC, per-team data isolation. **Single operator only.**
- Taking actions (scaling, restarting, deploying). Explicitly out of scope — read-only.
- Proactive alert triage / pushing incidents. (Possible later; see §12.)
- Replacing Grafana/PagerDuty/existing dashboards. It complements them.

---

## 3. Users & Use Cases

**User:** one operator (the DevOps engineer). No login federation needed beyond gating access
to that one identity.

**Primary use case — incident response from mobile:**
1. Operator gets paged (existing alerting).
2. Opens the Copilot URL on phone, authenticates once via your OIDC provider (SSO).
3. Asks: *"why is auth-service returning 401?"*
4. Copilot investigates (queries OpenSearch logs, checks recent Jenkins deploys, reads
   runbook context) and answers: probable cause, evidence, confidence, and — if a fix is
   needed — *describes* the fix without performing it.
5. Follow-up in the same session: *"and is prod affected?"* (multi-turn context retained).

**Secondary use cases:**
- Quick "what is the state of X" lookups without opening five dashboards.
- Onboarding/recall of runbook knowledge ("how do we usually fix EMS 401 noise?").

---

## 4. Architecture

```
[Phone browser]
   │  HTTPS
   ▼
[ALB (internet-facing)]  ── authenticate-oidc ──>  [your OIDC provider]  (locked to operator identity)
   │  (forwards only after auth)
   ▼
┌──────────────────── EKS pod: devops-copilot ────────────────────┐
│  Node.js service (TypeScript)                                    │
│  ┌───────────┐   ┌──────────────┐   ┌─────────────────────────┐ │
│  │ server.ts │──▶│  agent.ts    │──▶│ Claude Agent SDK query()│ │
│  │ HTTP/SSE  │◀──│ stream map   │◀──│  (Max OAuth token)      │ │
│  └───────────┘   └──────┬───────┘   └─────────────────────────┘ │
│                         │ canUseTool (readonly.ts)              │
│                         ▼                                        │
│              [ MCP hub — read-only subset ]                     │
│         grafana · opensearch · jenkins · kubernetes · backlog   │
└──────────────────────────┬───────────────────────────────────────┘
                           │  in-cluster network + IRSA
                           ▼
         OpenSearch NLB · Jenkins · Grafana · K8s API · AWS (read)
```

**Why this shape:**
- **In-cluster deploy** gives native network reach to internal endpoints (OpenSearch NLB,
  Jenkins, in-cluster K8s API) and AWS access via **IRSA** — no static keys, no VPN for the
  service itself.
- **ALB + `authenticate-oidc` → your OIDC provider** reuses the operator's existing IdP. The pod is
  never directly exposed; the ALB enforces auth before any request reaches it. No external
  vendor (no Cloudflare/Tailscale required).
- **Claude Agent SDK** is the same engine as Claude Code, headless — reuses MCP config and
  tool model directly.

---

## 5. Application Logic

### 5.1 Request lifecycle (one question → streamed answer)

1. `POST /ask` (SSE) receives `{ question, sessionId }`.
2. `agent.ts` calls the SDK `query()` with assembled `options` (see §5.2).
3. The SDK runs the agent loop: Claude reasons → calls a read MCP tool → reads the result →
   reasons again → … (bounded by `maxTurns`).
4. The service maps SDK stream events to SSE events:
   - text deltas → incremental answer text,
   - `tool_use` start/stop → activity line ("🔍 querying OpenSearch `auth-service-logs`…"),
   - final `result` → done + token usage.
5. The browser renders the streaming answer, the tool-activity trail, and source links.

### 5.2 The core call (`agent.ts`)

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const m of query({
  prompt: question,
  options: {
    model: CONFIG.model,                  // e.g. "claude-opus-4-8"
    systemPrompt: KNOWLEDGE_PROMPT,       // persona + runbook/domain knowledge (§7)
    mcpServers: READONLY_HUB,             // §8
    includePartialMessages: true,         // enable streaming
    permissionMode: "dontAsk",            // never hang in headless
    maxTurns: 8,                          // bound the agent loop
    canUseTool: readonlyGate,             // read-only enforcement (§6)
    resume: sessionId,                    // multi-turn continuity (§5.4)
  },
})) {
  if (m.type === "stream_event") emit(mapToSSE(m.event));
  if (m.type === "result")       emit({ type: "done", usage: m.usage });
}
```

Authentication is implicit: the SDK reads `CLAUDE_CODE_OAUTH_TOKEN` from the environment.

### 5.3 MCP server lifecycle — **persistent pool**

The SDK's default is to spawn MCP servers per `query()` and tear them down when the generator
completes. For an always-on server answering many questions, per-request spawn adds seconds of
latency and risks the exact orphaned-MCP accumulation we have already had to clean up on the
workstation.

**Decision:** maintain a **persistent pool** of MCP connections reused across requests, with
explicit teardown on `SIGTERM`/shutdown. This keeps responses fast and avoids process leaks.
(See §11 risks.)

### 5.4 Sessions & multi-turn

Incident triage is conversational ("…and prod?"). The service keeps a **session per browser
connection** and uses the SDK's `resume` to retain context across turns. The server keeps no
transcripts.

Conversation **history lives client-side in the browser's `localStorage`** — the sidebar lists
past conversations and reopens them, but nothing is persisted on the server (preserves the
no-server-transcript stance). History is therefore per-device; cross-device sync would require
an opt-in server-side store (future).

---

## 6. Security Model — Read-Only Enforcement

This is the defining property. Read-only is enforced **in code, not by prompt**.

### 6.1 The gate (`readonly.ts`)

A `canUseTool` callback is the single source of truth. It allowlists read built-ins, hard-denies
mutating built-ins, and for MCP tools denies any whose name matches a mutating verb:

```ts
const WRITE_VERBS = /(create|update|delete|put|post|apply|patch|scale|restart|
                      exec|add|remove|trigger|build|set|edit|write|drain|cordon|
                      rollout|annotate|label|cancel|stop|start)/i;
const READ_BUILTINS = ["Read", "Grep", "Glob", "WebSearch"];

export const readonlyGate = async (tool: string) => {
  if (READ_BUILTINS.includes(tool)) return true;
  if (["Bash", "Edit", "Write", "NotebookEdit"].includes(tool)) return false;
  if (tool.startsWith("mcp__")) {
    const action = tool.split("__")[2] ?? "";
    return !WRITE_VERBS.test(action);     // mcp__grafana__query_* ✅ ; mcp__k8s__*apply* ❌
  }
  return false;                            // default deny
};
```

### 6.2 Defense in depth
- **Command-tool input inspection**: tools that carry the operation in their *input* rather than
  their name (e.g. the AWS API server's `call_aws`) are inspected — the gate denies them if the
  command looks mutating, since the name-based check alone would wave them through.
- `allowedTools` additionally pins the expected read tools (belt-and-suspenders with the gate).
- `Bash` is denied entirely (no shell → no indirect mutation, no exfiltration via curl).
- The MCP hub passed to the agent is already a **read-only subset** (§8) — write-capable
  servers/credentials are not even wired in.
- `maxTurns` bounds runaway loops; per-request timeout bounds wall-clock.

### 6.3 Access & secrets
- Access gated by ALB + your OIDC provider OIDC to the single operator identity.
- `CLAUDE_CODE_OAUTH_TOKEN` (and later `ANTHROPIC_API_KEY`) stored in a Kubernetes Secret
  sourced from AWS SSM/Secrets Manager (External Secrets), never in the image or git.
- No request/response transcripts persisted in v1.

### 6.4 Host inspection (`inspect_host`) — highest-trust boundary
Running a command on a host is the most dangerous capability, so its safety lives in a strict
validator (`src/hostcmd.ts`), mirroring HolmesGPT's bash-toolset approach:
- **No shell metacharacters / pipes / redirects / substitution** — one simple command only (large
  output spills and is filtered with `query_result`).
- **No follow/stream flags** (`-f`).
- **Binary allowlist**: always-read binaries (`ss`, `ps`, `cat`, …) or, for binaries with
  subcommands (`rabbitmqctl`, `systemctl`, `docker`, `kubectl`, `journalctl`), a read-only
  subcommand only. Binary is basename-normalized (full paths validate).
- **`docker exec <container> <inner>`** is allowed only if the INNER command passes the same
  read-only validator (recursively); env-injection/privilege flags refused.
- **Sensitive paths** (shadow, private keys, aws/ssh creds) blocked even for `cat`/`grep`.
- `SendCommand` is invoked by the app directly (the read-only `aws-api` server would reject it);
  the validator is the safety boundary. Production must scope the IAM/IRSA role's `ssm:SendCommand`
  to read use and ideally to specific instances. Disable entirely with `COPILOT_HOST_INSPECT=false`.
- Validator is unit-tested (36 cases: writes, chaining, traversal, exec-into-container all denied).

---

## 7. Knowledge Base

The agent's edge over a generic chatbot is that it knows *this* infrastructure.

**v1 — curated system prompt.** Assemble a system prompt from existing docs at startup:
- API domain catalog (`API_DOMAIN_MAP.md`), service catalog,
- key runbook patterns (the recurring ones: wallet 401 sources, gameserver "95%" symptom,
  EMS session loops, etc.),
- the trust-label convention so answers carry calibrated confidence,
- behavioral rules: *read-only; cite the tool/log/dashboard you used; if a fix requires a
  mutation, describe it, do not perform it; prefer verify-before-alarm.*

Prompt caching keeps the repeated system-prompt cheap.

**Later — RAG.** When the knowledge base outgrows a single prompt, switch to retrieval: embed
the docs (Cohere embed/rerank on Bedrock — verified usable from this AWS account), retrieve
only relevant chunks per question. The interface to `knowledge.ts` is designed so this is a
drop-in change.

---

## 8. MCP Integration

The service wires a **read-only subset** of the existing hub. Candidate servers (final set TBD):

| Server | Used for | Example read tools |
|---|---|---|
| `grafana` | metrics, traces, dashboards | `query_prometheus`, `query_loki_logs`, `search_dashboards` |
| `opensearch` | application/error logs | search/get on `*-logs-*` indices |
| `jenkins` | recent deploys/build status | `jenkins_get_build_status`, `jenkins_list_jobs` |
| `kubernetes` | pod/deploy state, logs | `get`/`list`/`describe`/`logs` (no apply/delete/exec) |
| `backlog` | related tickets/runbook context | `get_issue`, `get_issues` |
| `aws-api` | EC2/SSM visibility (self-hosted services live on EC2, invisible to k8s) | `aws ec2 describe-*`, `aws ssm get-*` |

**`inspect_host` (highest-trust feature, app-local — SPEC §6.4):** runs a SINGLE allowlisted
READ-ONLY command on an EC2 host via SSM `SendCommand`, to inspect services self-hosted on the
host (e.g. RabbitMQ in Docker, systemd units) that no AWS API or the k8s tool can see. Disable with
`COPILOT_HOST_INSPECT=false`.

The `aws-api` server (`awslabs.aws-api-mcp-server`, app-local) closes a real blind spot:
many dev services are self-hosted on EC2 and the `kubernetes` server cannot see them. It is
pinned read-only three ways: (1) `READ_OPERATIONS_ONLY=true` on the server (CLI commands
checked against a read-only allowlist), (2) the gate's input-inspection denies command tools
whose input looks mutating (§6.1), (3) production uses a read-only IAM role (IRSA). First start
downloads a small embedding model, so its cold-start is slower than the others.

Notes:
- MCP servers run **inside the pod's container image** (uvx/npx), reachable from the agent
  over stdio. They reach internal infra over the in-cluster network.
- The `kubernetes` server uses the pod's **in-cluster ServiceAccount** bound to a **read-only
  ClusterRole** — a second hard guarantee no mutation is possible regardless of tool gating.
- AWS-touching MCP (if any) uses **IRSA** with a read-only IAM policy.
- Mutating tools from these servers are blocked by §6 and, where possible, by the underlying
  credential/role being read-only.

---

## 9. Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript / Node.js 18+ | Agent SDK is TS-native |
| Agent engine | `@anthropic-ai/claude-agent-sdk` | same engine as Claude Code |
| HTTP/SSE | Fastify (or Express) | small, streaming-friendly |
| UI | Single static `index.html` + SSE | mobile-first, no build step needed for v1 |
| Container | Docker (non-root user) | SDK refuses `--dangerously-skip-permissions` as root |
| Orchestration | Kubernetes (EKS) | reaches internal infra natively |
| Secrets | External Secrets ← SSM/Secrets Manager | no secrets in image/git |
| Access | ALB `authenticate-oidc` + your OIDC provider | reuse existing IdP |

---

## 10. Deployment (EKS)

- **Image**: multi-stage Docker; runtime as **non-root** (`appuser`); includes Node, the
  Agent SDK, and the MCP server runtimes (uvx for python servers, npx/node for node servers).
- **Workload**: a single `Deployment` (1 replica) + `Service`.
- **Ingress**: ALB ingress (existing AWS LB Controller, `ingressClass: alb`), internet-facing,
  with `authenticate-oidc` action pointing at your OIDC provider; locked to the operator's identity.
- **ServiceAccount**: IRSA-annotated for read-only AWS; bound to a read-only K8s ClusterRole
  for the in-cluster `kubernetes` MCP.
- **Secret**: `CLAUDE_CODE_OAUTH_TOKEN` (→ later `ANTHROPIC_API_KEY`) via External Secrets.
- **Cluster**: target the dev EKS first (lower blast radius); prod-infra reads happen over the
  network regardless of which cluster the pod runs in.
- **12-factor**: all config via env (see `.env.example`) so localhost → EKS is config-only.

---

## 11. Configuration & Risks

### Config (env)
| Var | Meaning |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Max subscription token (`claude setup-token`) |
| `ANTHROPIC_API_KEY` | alternative auth (takes precedence; for always-on later) |
| `COPILOT_MODEL` | model id, default `claude-opus-4-8` |
| `COPILOT_PORT` | HTTP port, default `8787` |
| `COPILOT_MAX_TURNS` | agent-loop bound, default `8` |
| `COPILOT_SESSION_TTL_MIN` | idle session expiry |

### Risks & mitigations
- **Max OAuth token: ~1-year life, no auto-refresh on headless.** Acceptable to start;
  for 24/7 reliability, switch to `ANTHROPIC_API_KEY`. Provider-agnostic config makes this a
  one-line change. Alert before expiry.
- **MCP process leak** (the workstation problem): mitigated by the persistent pool + explicit
  teardown on shutdown; pod restarts also reap cleanly.
- **Read-only bypass**: mitigated by three independent layers (tool gate, read-only
  credentials/roles, no Bash). Any new MCP server must be reviewed against the gate.
- **Data sensitivity**: answers may contain internal hostnames/log lines; access is gated to a
  single identity and nothing is persisted.

---

## 12. Roadmap

**Phase 0 — this spec.** ✅

**Phase 1 — local MVP.** Agent service + read-only gate + curated knowledge prompt + minimal
MCP subset + mobile-first UI, running on localhost with the Max token. Validate with real
questions ("why is auth-service 401?").

**Phase 2 — deploy to EKS.** Dockerize, k8s manifests, ALB+your OIDC provider OIDC, External Secrets,
IRSA. Reachable from phone.

**Phase 3 — knowledge depth.** Expand runbook coverage; move to RAG (Cohere embeddings on
Bedrock) if the prompt grows too large.

**Phase 4 (optional) — proactive triage.** Subscribe to existing alert streams; on an alert,
auto-run an investigation and push a first-pass diagnosis. (Re-evaluates the single-user/ToS
and notification design before building.)

---

## 13. Open Decisions

1. **Cluster**: deploy to dev EKS (recommended first) vs prod `your-eks-cluster`.
2. **Auth longevity**: stay on Max token vs move to `ANTHROPIC_API_KEY` for Phase 2.
3. **Exact MCP subset** and the read-only ClusterRole scope.
4. **HTTP framework**: Fastify vs Express (lean Fastify recommended).

Defaults above are the recommendation unless changed.
