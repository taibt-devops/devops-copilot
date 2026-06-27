import { readFileSync } from "node:fs";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { CONFIG } from "./config.js";
import { expandEnvPlaceholders } from "./mcp.js";

/**
 * Recursive Jenkins job finder (READ-ONLY).
 *
 * Why this exists: the hub `jenkins` MCP server's `jenkins_list_jobs` /
 * `jenkins_search_jobs` are TOP-LEVEL ONLY — they do not descend into folders.
 * Our Jenkins organises everything in nested folders
 * (e.g. `TeamA/Backend/DEV/service-build-dev`), so a substring
 * search for "service" against the root returns [] and the agent wrongly concludes
 * "no such job". This tool walks the folder tree via the Jenkins REST API and
 * returns the FULL slash-paths of matching leaf jobs — which can then be passed
 * straight to `jenkins_get_job_status` / `jenkins_get_console_log` etc.
 *
 * It only ever issues GET requests (read-only). Credentials are reused from the
 * same `jenkins` server block in the hub .mcp.json the rest of the app loads.
 */

interface JenkinsCreds {
  base: string;
  user: string;
  token: string;
}

function loadJenkinsCreds(): JenkinsCreds | null {
  if (!CONFIG.mcpConfigPath) return null;
  try {
    const raw = JSON.parse(readFileSync(CONFIG.mcpConfigPath, "utf8"));
    const servers = raw.mcpServers ?? raw.servers ?? {};
    const s = servers.jenkins ?? servers.Jenkins;
    const env = s?.env ?? {};
    // Values may be ${VAR} placeholders in the committed template — expand from the
    // environment (hydrated from Secrets Manager at boot). process.env wins if set.
    const pick = (envName: string, cfgVal: unknown): string =>
      process.env[envName] ?? expandEnvPlaceholders(String(cfgVal ?? ""));
    const base = pick("MCP_JENKINS_URL", env.MCP_JENKINS_URL ?? env.JENKINS_URL).replace(/\/+$/, "");
    const user = pick("MCP_JENKINS_USER", env.MCP_JENKINS_USER ?? env.JENKINS_USER);
    const token = pick("MCP_JENKINS_API_TOKEN", env.MCP_JENKINS_API_TOKEN ?? env.JENKINS_API_TOKEN);
    if (!base || !user || !token) return null;
    return { base, user, token };
  } catch {
    return null;
  }
}

const CREDS = loadJenkinsCreds();

const FOLDER_CLASS = /(folder|MultiBranchProject|OrganizationFolder)/i;
const MAX_FETCHES = 300; // hard backstop against pathological trees
const MAX_DEPTH = 8;

interface JobItem {
  name: string;
  url: string;
  _class?: string;
}

/** URL → slash path usable by the other jenkins tools (drops the `/job/` segments). */
function urlToPath(url: string, base: string): string {
  let p = url.startsWith(base) ? url.slice(base.length) : new URL(url).pathname;
  return decodeURIComponent(p)
    .split("/job/")
    .filter(Boolean)
    .join("/")
    .replace(/\/+$/, "");
}

async function fetchJobs(
  url: string,
  creds: JenkinsCreds,
  counter: { n: number },
): Promise<JobItem[]> {
  if (counter.n >= MAX_FETCHES) return [];
  counter.n++;
  const api = url.replace(/\/+$/, "") + "/api/json?tree=jobs[name,url,_class]";
  const auth = Buffer.from(`${creds.user}:${creds.token}`).toString("base64");
  const res = await fetch(api, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) return [];
  const data = (await res.json()) as { jobs?: JobItem[] };
  return data.jobs ?? [];
}

interface Found {
  path: string;
  url: string;
}

async function walk(
  url: string,
  creds: JenkinsCreds,
  query: string,
  depth: number,
  counter: { n: number },
  out: Found[],
): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= 50 || counter.n >= MAX_FETCHES) return;
  const jobs = await fetchJobs(url, creds, counter);
  for (const j of jobs) {
    if (!j.url) continue;
    const isFolder = FOLDER_CLASS.test(j._class ?? "");
    if (isFolder) {
      await walk(j.url, creds, query, depth + 1, counter, out);
    } else {
      const path = urlToPath(j.url, creds.base);
      if (!query || path.toLowerCase().includes(query.toLowerCase())) {
        out.push({ path, url: j.url });
      }
    }
    if (out.length >= 50) return;
  }
}

/** In-process MCP server exposing the read-only recursive `jenkins_find_job` tool. */
export const jenkinsServer = createSdkMcpServer({
  name: "jenkins-find",
  version: "1.0.0",
  alwaysLoad: true,
  tools: [
    tool(
      "jenkins_find_job",
      "Recursively search Jenkins folders for jobs whose full path matches a query " +
        "(case-insensitive substring), returning each job's FULL slash-path (e.g. " +
        "'TeamA/Backend/DEV/service-build-dev'). USE THIS instead of " +
        "jenkins_search_jobs/jenkins_list_jobs, which are top-level-only and miss every " +
        "job inside a folder. Pass the returned path to jenkins_get_job_status / " +
        "jenkins_get_console_log / jenkins_get_job_config. Empty query lists all leaf jobs.",
      { query: z.string().describe("substring to match anywhere in the job path, e.g. 'service build' → use 'service'") },
      async (args) => {
        if (!CREDS) {
          return {
            content: [
              {
                type: "text",
                text: "jenkins_find_job unavailable: no Jenkins credentials found in the MCP config (jenkins server env MCP_JENKINS_URL/USER/API_TOKEN).",
              },
            ],
          };
        }
        const q = String(args.query ?? "").trim();
        const out: Found[] = [];
        const counter = { n: 0 };
        try {
          await walk(CREDS.base, CREDS, q, 0, counter, out);
        } catch (err) {
          return {
            content: [
              { type: "text", text: `jenkins_find_job error: ${(err as Error).message}` },
            ],
          };
        }
        if (!out.length) {
          return {
            content: [
              {
                type: "text",
                text: `No Jenkins job path matched "${q}" (searched ${counter.n} folders). Try a shorter/different substring; the job may genuinely not exist, or widen the query.`,
              },
            ],
          };
        }
        const capped = out.length >= 50 ? " (truncated at 50 — narrow the query)" : "";
        const lines = out.map((f) => `- ${f.path}`).join("\n");
        return {
          content: [
            {
              type: "text",
              text: `Matched ${out.length} job(s)${capped}. Pass a path to jenkins_get_job_status/console_log/config:\n${lines}`,
            },
          ],
        };
      },
    ),
  ],
});

export const hasJenkinsFinder = CREDS !== null;
