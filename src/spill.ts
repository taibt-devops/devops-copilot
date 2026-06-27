import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { CONFIG } from "./config.js";

/**
 * Output-spill-to-disk (pattern borrowed from HolmesGPT, adapted to stay read-only).
 *
 * Big tool results (huge index lists, kubectl -o yaml, large log dumps) blow the
 * context window and cost tokens, while the agent usually needs only a slice. A
 * PostToolUse hook spills oversized results to a file and replaces the message the
 * model sees with a short preview + a pointer. The agent then calls the read-only
 * `query_result` tool to grep/head exactly what it needs.
 *
 * Unlike HolmesGPT (which uses pre-approved bash `cat | grep`), we keep Bash blocked
 * and expose a dedicated `query_result` tool that can ONLY read files inside the spill
 * directory — no general shell, no arbitrary file read.
 */

const SPILL_DIR = join(tmpdir(), "devops-copilot-spill");
try {
  mkdirSync(SPILL_DIR, { recursive: true });
} catch {
  /* best effort */
}

const PREVIEW_CHARS = 1500;

/** Normalize a tool response (string | MCP content array | object) to text. */
function serialize(resp: unknown): string {
  if (typeof resp === "string") return resp;
  if (resp && typeof resp === "object") {
    const r = resp as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      const txt = (r.content as Array<Record<string, unknown>>)
        .filter((c) => c?.type === "text")
        .map((c) => String(c.text ?? ""))
        .join("\n");
      if (txt) return txt;
    }
    try {
      return JSON.stringify(resp, null, 2);
    } catch {
      return String(resp);
    }
  }
  return String(resp);
}

/** SDK PostToolUse hook: spill oversized results, replace with preview + pointer. */
export async function spillHook(input: unknown): Promise<unknown> {
  try {
    const i = input as { tool_name?: string; tool_response?: unknown };
    const name = String(i?.tool_name ?? "");
    // never spill our own internal tools (avoid loops on query_result/fetch_skill)
    if (name.includes("__results__") || name.includes("__skills__")) return {};

    const text = serialize(i?.tool_response);
    if (text.length <= CONFIG.spillThreshold) return {};

    const fname = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.txt`;
    writeFileSync(join(SPILL_DIR, fname), text, "utf8");
    const lineCount = text.split("\n").length;
    const preview = text.slice(0, PREVIEW_CHARS);

    const msg = `⚠️ Tool result too large (${text.length} chars, ${lineCount} lines) — saved to spill file "${fname}".
Preview (first ${PREVIEW_CHARS} chars):
${preview}${text.length > PREVIEW_CHARS ? "\n…[truncated]" : ""}

Do NOT ask for the whole thing again. Call the \`query_result\` tool with file="${fname}" and one of:
  - pattern: a substring/regex — returns only matching lines (best for finding a specific entry)
  - head: N — returns the first N lines
Query for exactly what you need.`;

    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: msg,
      },
    };
  } catch {
    return {};
  }
}

/** In-process MCP server exposing the read-only `query_result` tool. */
export const resultsServer = createSdkMcpServer({
  name: "results",
  version: "1.0.0",
  alwaysLoad: true, // query_result is needed right after a spill — don't defer it
  tools: [
    tool(
      "query_result",
      "Filter a large tool result previously spilled to a file. Returns only the matching/relevant lines — use this instead of re-requesting the whole result.",
      {
        file: z.string().describe("spill file name from a 'result too large' message"),
        pattern: z.string().optional().describe("substring or regex (case-insensitive); returns only matching lines"),
        head: z.number().optional().describe("return the first N lines"),
        max_lines: z.number().optional().describe("cap on lines returned (default 200, max 1000)"),
      },
      async (args) => {
        const safe = basename(String(args.file)); // strips any path traversal
        const full = join(SPILL_DIR, safe);
        if (!full.startsWith(SPILL_DIR) || !existsSync(full)) {
          return { content: [{ type: "text", text: `No spill file "${safe}".` }] };
        }
        const cap = Math.min(Number(args.max_lines ?? 200), 1000);
        const all = readFileSync(full, "utf8").split("\n");

        let matched: string[];
        if (args.pattern) {
          let re: RegExp | null = null;
          try {
            re = new RegExp(String(args.pattern), "i");
          } catch {
            re = null;
          }
          const p = String(args.pattern).toLowerCase();
          matched = all.filter((l) => (re ? re.test(l) : l.toLowerCase().includes(p)));
        } else if (args.head) {
          matched = all.slice(0, Number(args.head));
        } else {
          matched = all.slice(0, cap);
        }

        const shown = matched.slice(0, cap);
        const text = `${shown.join("\n")}\n\n[${shown.length} of ${matched.length} matching lines from "${safe}" (${all.length} total lines)]`;
        return { content: [{ type: "text", text }] };
      },
    ),
  ],
});
