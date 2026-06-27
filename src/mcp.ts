import { readFileSync } from "node:fs";
import { CONFIG } from "./config.js";

/**
 * Loads a read-relevant subset of MCP servers from an existing .mcp.json
 * (e.g. the devops-mcp-hub config). Read-only is enforced by the tool gate
 * (readonly.ts), so we can safely reuse the same server definitions.
 */

/** Default servers to include when COPILOT_MCP_SERVERS is not set. */
const DEFAULT_SERVERS = [
  "grafana",
  "opensearch",
  "jenkins",
  "kubernetes",
  "backlog",
  "aws-api",
];

/**
 * App-local server definitions (not in the hub .mcp.json). Lets the Copilot add
 * read-only tools — like the AWS API server for EC2/SSM visibility — without
 * touching the shared hub config.
 *
 * `aws-api`: AWS API access pinned READ-ONLY two ways: READ_OPERATIONS_ONLY=true
 * (server compares each CLI command against a read-only allowlist) AND the
 * input-inspection in readonly.ts. Production should additionally use a read-only
 * IAM role (IRSA). Note: first start downloads a small embedding model (slow).
 */
const EXTRA_SERVERS: Record<string, unknown> = {
  "aws-api": {
    command: "uvx",
    args: ["awslabs.aws-api-mcp-server@latest"],
    env: {
      READ_OPERATIONS_ONLY: "true",
      AWS_PROFILE: process.env.AWS_PROFILE ?? "default",
      AWS_REGION: process.env.AWS_REGION ?? "ap-northeast-1",
      FASTMCP_LOG_LEVEL: "ERROR",
    },
  },
};

/** Replace `${VAR}` in a string with process.env.VAR (empty if unset). */
export function expandEnvPlaceholders(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => process.env[k] ?? "");
}

/**
 * Expand `${VAR}` placeholders inside a server definition's `env` values and `args`,
 * pulling from process.env (which is hydrated from Secrets Manager at boot). Lets the
 * committed MCP config template carry NO secret values — only placeholders.
 */
function expandServerDef(def: unknown): unknown {
  const out = JSON.parse(JSON.stringify(def)) as {
    env?: Record<string, unknown>;
    args?: unknown[];
  };
  if (out.env) {
    for (const k of Object.keys(out.env)) {
      if (typeof out.env[k] === "string") {
        out.env[k] = expandEnvPlaceholders(out.env[k] as string);
      }
    }
  }
  if (Array.isArray(out.args)) {
    out.args = out.args.map((a) => (typeof a === "string" ? expandEnvPlaceholders(a) : a));
  }
  return out;
}

export function loadMcpServers(): Record<string, unknown> {
  let all: Record<string, unknown> = {};
  if (CONFIG.mcpConfigPath) {
    try {
      const raw = JSON.parse(readFileSync(CONFIG.mcpConfigPath, "utf8"));
      all = raw.mcpServers ?? raw.servers ?? {};
    } catch (err) {
      throw new Error(
        `Failed to read MCP config at ${CONFIG.mcpConfigPath}: ${(err as Error).message}`,
      );
    }
  }

  const wanted = CONFIG.mcpServers
    ? CONFIG.mcpServers.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_SERVERS;

  const out: Record<string, unknown> = {};
  for (const name of wanted) {
    if (EXTRA_SERVERS[name]) out[name] = EXTRA_SERVERS[name];
    else if (all[name]) out[name] = expandServerDef(all[name]);
  }
  return out;
}
