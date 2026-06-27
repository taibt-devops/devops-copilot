import { query } from "@anthropic-ai/claude-agent-sdk";
import { CONFIG } from "./config.js";
import { readonlyGate, disallowedTools } from "./readonly.js";
import { loadMcpServers } from "./mcp.js";
import { buildSystemPrompt } from "./knowledge.js";
import { skillsServer, skillCatalogPrompt } from "./skills.js";
import { spillHook, resultsServer } from "./spill.js";
import { hostServer } from "./hostcmd.js";
import { jenkinsServer, hasJenkinsFinder } from "./jenkins.js";
import { historyServer } from "./history.js";
import { memoryServer } from "./memory.js";
import { createSearchKnowledgeServer, createRagDeps } from "./rag/search.js";

/**
 * The core agent loop. `ask()` runs one question through the Claude Agent SDK
 * and yields normalized SSE events. Authentication is implicit: the SDK reads
 * CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) from the environment.
 */

// RAG (search_knowledge) — opt-in. Built lazily so a misconfig never crashes boot.
const ragDeps = CONFIG.rag.enabled
  ? createRagDeps({
      embedModelId: CONFIG.rag.embedModelId,
      region: CONFIG.rag.store.region,
      defaultK: CONFIG.rag.defaultK,
      store: { ...CONFIG.rag.store, backend: CONFIG.rag.store.backend as never },
    })
  : undefined;

// Hub/AWS servers + in-process servers: skills (fetch_skill), results (query_result),
// history (search_history), memory (save_memory), knowledge (search_knowledge, opt-in).
const mcpServers = {
  ...loadMcpServers(),
  skills: skillsServer,
  results: resultsServer,
  history: historyServer,
  memory: memoryServer,
  // Recursive Jenkins folder search (the hub jenkins tools are top-level only).
  ...(hasJenkinsFinder ? { "jenkins-find": jenkinsServer } : {}),
  ...(CONFIG.hostInspectEnabled ? { host: hostServer } : {}),
  ...(ragDeps ? { knowledge: createSearchKnowledgeServer(ragDeps, CONFIG.rag.defaultK) } : {}),
};

export type SSEEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; content: string }
  | { type: "tool"; name: string }
  | { type: "done"; sessionId?: string; usage?: unknown }
  | { type: "error"; message: string };

export async function* ask(
  question: string,
  sessionId?: string,
): AsyncGenerator<SSEEvent> {
  // Hard wall-clock cap: abort so a question never hangs forever on "Thinking…".
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CONFIG.requestTimeoutMs);

  const options: Record<string, unknown> = {
    model: CONFIG.model,
    // Rebuilt per request so freshly saved memories take effect on the next question.
    systemPrompt: buildSystemPrompt() + skillCatalogPrompt(),
    mcpServers,
    includePartialMessages: true,
    permissionMode: "default", // canUseTool decides; never hangs in headless
    maxTurns: CONFIG.maxTurns,
    disallowedTools,
    canUseTool: readonlyGate,
    // Spill oversized tool results to disk; agent re-reads slices via query_result.
    hooks: { PostToolUse: [{ hooks: [spillHook] }] },
    abortController: ac,
  };
  // Let Grep/Glob/Read reach the source repos (local dev) for code-level investigation.
  if (CONFIG.codeDirs.length) options.additionalDirectories = CONFIG.codeDirs;
  if (sessionId) options.resume = sessionId;

  let finished = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const m of query({ prompt: question, options } as any)) {
      const msg = m as any;
      if (msg.type === "system" && msg.subtype === "init") {
        yield { type: "session", sessionId: msg.session_id };
      } else if (msg.type === "stream_event") {
        const ev = msg.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          yield { type: "text", content: ev.delta.text };
        } else if (
          ev?.type === "content_block_start" &&
          ev.content_block?.type === "tool_use"
        ) {
          yield { type: "tool", name: ev.content_block.name };
        }
      } else if (msg.type === "result") {
        finished = true;
        yield { type: "done", sessionId: msg.session_id, usage: msg.usage };
      }
    }
  } catch (err) {
    if (ac.signal.aborted) {
      yield {
        type: "text",
        content:
          "\n\n_(Stopped — this took too long, so here's the partial result above. Ask a narrower question or for one specific check.)_",
      };
    } else {
      yield { type: "error", message: (err as Error)?.message ?? String(err) };
    }
  } finally {
    clearTimeout(timer);
    if (!finished) yield { type: "done" }; // always end so the UI stops "Thinking…"
  }
}
