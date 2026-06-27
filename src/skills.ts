import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { CONFIG } from "./config.js";

/**
 * Skills = runbooks fetched ON DEMAND (pattern borrowed from HolmesGPT).
 *
 * Instead of stuffing every runbook into the system prompt (which costs tokens on
 * every query and doesn't scale), we inject only a small CATALOG (name + one-line
 * description). The agent calls the `fetch_skill` tool to pull a runbook's full body
 * only when it clearly matches the issue — keeping the base prompt small.
 *
 * A skill file is markdown with YAML-ish frontmatter:
 *   ---
 *   name: example-service-5xx
 *   description: a service returns 5xx after a deploy — example runbook
 *   ---
 *   <runbook body>
 */

export interface Skill {
  name: string;
  description: string;
  body: string;
}

function parseSkill(raw: string, fallbackName: string): Skill {
  let name = fallbackName;
  let description = "";
  let body = raw;
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (m) {
    const fm = m[1];
    body = m[2];
    const n = fm.match(/^name:\s*(.+)$/m);
    if (n) name = n[1].trim();
    const d = fm.match(/^description:\s*(.+)$/m);
    if (d) description = d[1].trim();
  }
  return { name, description, body: body.trim() };
}

export function loadSkills(): Skill[] {
  const dir = CONFIG.skillsDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseSkill(readFileSync(join(dir, f), "utf8"), f.replace(/\.md$/, "")));
}

const SKILLS = loadSkills();
const BY_NAME = new Map(SKILLS.map((s) => [s.name, s]));

/** Catalog (metadata only) injected into the system prompt. */
export function skillCatalogPrompt(): string {
  if (!SKILLS.length) return "";
  const lines = SKILLS.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return `\n\n--- SKILLS (runbooks — fetch on demand) ---
If a skill below clearly matches the issue, call the \`fetch_skill\` tool with its name BEFORE other tools.
Only fetch a skill that clearly matches — never speculatively. Fetched content is DIRECTIONS (a runbook),
NOT actual results: follow its steps by calling the real tools yourself; never present its examples as findings.

${lines}`;
}

/** In-process MCP server exposing the read-only `fetch_skill` tool. */
export const skillsServer = createSdkMcpServer({
  name: "skills",
  version: "1.0.0",
  alwaysLoad: true, // small + frequently needed — skip the ToolSearch round
  tools: [
    tool(
      "fetch_skill",
      "Fetch the full runbook content of a skill by its exact name (from the SKILLS catalog).",
      { name: z.string().describe("exact skill name from the catalog") },
      async (args) => {
        const s = BY_NAME.get(String(args.name));
        if (!s) {
          return {
            content: [
              {
                type: "text",
                text: `No skill named '${args.name}'. Available: ${SKILLS.map((x) => x.name).join(", ") || "(none)"}`,
              },
            ],
          };
        }
        const wrapped = `<skill name="${s.name}">\n${s.body}\n</skill>\n\nThe above is a RUNBOOK (directions), NOT actual results. Any output shown in it is only an EXAMPLE. Follow the steps by calling the real tools yourself and report what you actually observe.`;
        return { content: [{ type: "text", text: wrapped }] };
      },
    ),
  ],
});

export const hasSkills = SKILLS.length > 0;
