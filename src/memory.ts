import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { CONFIG } from "./config.js";

/**
 * Learned memory — durable, distilled FACTS the agent has confirmed and will reuse.
 * Unlike history (every Q&A), memory holds a small set of high-value statements that are
 * injected into the system prompt on every question (e.g. "auth-service 401 on /profile =
 * benign noise", "10.0.0.5 = db-host-dev MySQL host"). The agent records them via the
 * `save_memory` tool; the operator can review/prune them in the UI (/memory endpoint).
 *
 * Writing memory is the app's OWN state — it does not touch infrastructure.
 */

export interface MemoryRecord {
  id: string;
  ts: number;
  fact: string;
  evidence?: string;
}

const FILE = () => join(CONFIG.dataDir, "memory.jsonl");
const MAX_ITEMS = 200;       // safety cap on how many we keep
const PROMPT_MAX_CHARS = 6000; // cap on how much we inject into the prompt

function ensureDir(): void {
  if (!existsSync(CONFIG.dataDir)) mkdirSync(CONFIG.dataDir, { recursive: true });
}

export function loadMemories(): MemoryRecord[] {
  try {
    if (!existsSync(FILE())) return [];
    return readFileSync(FILE(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as MemoryRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is MemoryRecord => r != null && Boolean(r.fact));
  } catch {
    return [];
  }
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Append a fact (deduped against existing). Returns a short status string. */
export function saveMemory(fact: string, evidence?: string): string {
  const f = fact.trim();
  if (f.length < 8) return "rejected: fact too short";
  const existing = loadMemories();
  if (existing.some((m) => norm(m.fact) === norm(f))) return "skipped: already remembered";
  if (existing.length >= MAX_ITEMS) return `rejected: memory full (${MAX_ITEMS}); prune first`;
  const rec: MemoryRecord = {
    id: "m_" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
    ts: Date.now(),
    fact: f,
    evidence: evidence?.trim() || undefined,
  };
  try {
    ensureDir();
    appendFileSync(FILE(), JSON.stringify(rec) + "\n", "utf8");
    return `saved (${existing.length + 1} total)`;
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }
}

/** Remove a memory by id (operator curation via /memory). */
export function deleteMemory(id: string): boolean {
  const kept = loadMemories().filter((m) => m.id !== id);
  try {
    ensureDir();
    writeFileSync(FILE(), kept.map((m) => JSON.stringify(m)).join("\n") + (kept.length ? "\n" : ""), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** The `--- LEARNED MEMORY ---` block injected into the system prompt (capped). */
export function memoryPromptSection(): string {
  const mems = loadMemories();
  if (!mems.length) return "";
  let body = "";
  for (const m of mems) {
    const line = `- ${m.fact}${m.evidence ? ` _(evidence: ${m.evidence})_` : ""}\n`;
    if (body.length + line.length > PROMPT_MAX_CHARS) break;
    body += line;
  }
  return `\n\n--- LEARNED MEMORY (confirmed facts from past investigations; still verify time-sensitive ones) ---\n${body}`;
}

/** In-process MCP server exposing the `save_memory` tool. */
export const memoryServer = createSdkMcpServer({
  name: "memory",
  version: "1.0.0",
  alwaysLoad: true,
  tools: [
    tool(
      "save_memory",
      "Record a DURABLE, confirmed fact worth reusing in future investigations — e.g. a known-noise " +
        "pattern, a stable identity mapping (IP↔host, service↔repo), or a settled root cause. Save " +
        "SPARINGLY: only [OBS]-confirmed, reusable, slow-to-change facts — never per-question details, " +
        "guesses, or time-sensitive values. The fact is shown to you on every future question.",
      {
        fact: z.string().describe("one concise durable statement, e.g. 'wallet-api-dev 401 RestApiUtils profile = benign background noise, not an incident'"),
        evidence: z.string().optional().describe("brief source/why it's trustworthy"),
      },
      async (args) => {
        const status = saveMemory(String(args.fact ?? ""), args.evidence ? String(args.evidence) : undefined);
        return { content: [{ type: "text", text: `memory ${status}` }] };
      },
    ),
  ],
});
