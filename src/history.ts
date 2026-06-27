import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { CONFIG } from "./config.js";

/**
 * Q&A history — every question and its answer is appended to a JSONL store on a
 * persistent volume (survives restarts, shared across devices, unlike the browser's
 * localStorage). Two uses:
 *   - the operator can browse/search past investigations (/history endpoint + UI),
 *   - the agent can recall prior similar questions via the read-only `search_history`
 *     tool before investigating from scratch.
 *
 * This is the app's OWN state — writing it does not touch any infrastructure, so it
 * does not violate the read-only-toward-infra guarantee.
 */

export interface HistoryRecord {
  ts: number;
  sid?: string;
  q: string;
  a: string;
  tools?: string[];
  ms?: number;
}

const FILE = () => join(CONFIG.dataDir, "history.jsonl");

function ensureDir(): void {
  if (!existsSync(CONFIG.dataDir)) mkdirSync(CONFIG.dataDir, { recursive: true });
}

export function appendHistory(rec: HistoryRecord): void {
  try {
    ensureDir();
    appendFileSync(FILE(), JSON.stringify(rec) + "\n", "utf8");
  } catch (err) {
    console.warn(`[history] append failed: ${(err as Error).message}`);
  }
}

export function readAllHistory(): HistoryRecord[] {
  try {
    if (!existsSync(FILE())) return [];
    return readFileSync(FILE(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as HistoryRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is HistoryRecord => r != null);
  } catch {
    return [];
  }
}

/** Most recent first, capped. */
export function recentHistory(limit = 50): HistoryRecord[] {
  return readAllHistory().slice(-limit).reverse();
}

const STOP = new Set([
  "the", "a", "an", "is", "are", "to", "of", "in", "on", "for", "and", "or", "vs",
  "có", "không", "là", "gì", "sao", "vì", "cho", "tôi", "giúp", "check", "the",
]);

function terms(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9_\-./]+/gi) ?? [])
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Keyword-overlap search over question + answer; returns scored matches, best first. */
export function searchHistory(query: string, limit = 5): HistoryRecord[] {
  const q = terms(query);
  if (!q.length) return [];
  const scored = readAllHistory().map((r) => {
    const hay = (r.q + " " + r.a).toLowerCase();
    let score = 0;
    for (const t of q) if (hay.includes(t)) score++;
    return { r, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.r.ts - a.r.ts)
    .slice(0, limit)
    .map((x) => x.r);
}

function fmtDate(ts: number): string {
  // ISO without ms; avoids Date.now/locale dependence on the rendered string
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

/** In-process MCP server exposing the read-only `search_history` tool. */
export const historyServer = createSdkMcpServer({
  name: "history",
  version: "1.0.0",
  alwaysLoad: true,
  tools: [
    tool(
      "search_history",
      "Search PAST questions you (DevOps Copilot) have already answered, by keyword. Use it at " +
        "the START of a clear investigation to see if the same/similar thing was asked before — reuse " +
        "or build on the prior answer instead of investigating from scratch. Returns date + question + " +
        "answer snippet. Always re-verify time-sensitive facts; a past answer may be stale.",
      { query: z.string().describe("keywords from the current question, e.g. 'wallet 401 dev'") },
      async (args) => {
        const hits = searchHistory(String(args.query ?? ""), 5);
        if (!hits.length) {
          return { content: [{ type: "text", text: "No prior Q&A matched. Investigate fresh." }] };
        }
        const text = hits
          .map(
            (h) =>
              `[${fmtDate(h.ts)}] Q: ${h.q}\nA: ${h.a.slice(0, 600)}${h.a.length > 600 ? " …" : ""}`,
          )
          .join("\n\n---\n\n");
        return {
          content: [
            {
              type: "text",
              text: `${hits.length} prior match(es). These are PAST answers (may be stale — re-verify time-sensitive facts):\n\n${text}`,
            },
          ],
        };
      },
    ),
  ],
});
