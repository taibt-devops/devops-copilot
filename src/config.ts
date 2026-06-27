import "dotenv/config";

/** 12-factor config — everything from env so localhost → EKS is config-only. */
export const CONFIG = {
  model: process.env.COPILOT_MODEL ?? "claude-opus-4-8",
  port: Number(process.env.COPILOT_PORT ?? 8787),
  maxTurns: Number(process.env.COPILOT_MAX_TURNS ?? 35),
  /** Last-resort anti-hang cap per question (ms). Set high so real multi-step
   *  investigations (source + several log queries) finish naturally; only a true
   *  hang hits this. The tempered prompt — not this — keeps it from over-investigating. */
  requestTimeoutMs: Number(process.env.COPILOT_REQUEST_TIMEOUT_MS ?? 240000),
  sessionTtlMin: Number(process.env.COPILOT_SESSION_TTL_MIN ?? 30),
  /** Path to an existing .mcp.json to load read servers from (e.g. the hub). */
  mcpConfigPath: process.env.COPILOT_MCP_CONFIG ?? "",
  /** AWS Secrets Manager secret id/ARN holding a JSON of tokens to inject into the
   *  environment at boot (so no secret values live in the image or .env). Optional. */
  secretId: process.env.COPILOT_SECRET_ID ?? "",
  /** Comma-separated server names to include; defaults applied in mcp.ts. */
  mcpServers: process.env.COPILOT_MCP_SERVERS ?? "",
  knowledgeDir: process.env.COPILOT_KNOWLEDGE_DIR ?? "./knowledge",
  /** Source repo roots the agent may read with Grep/Glob/Read (local dev). */
  codeDirs: (process.env.COPILOT_CODE_DIRS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** Runbooks fetched on demand via the fetch_skill tool (only metadata in the prompt). */
  skillsDir: process.env.COPILOT_SKILLS_DIR ?? "./skills",
  /** Persisted state dir (Q&A history + learned memory). Mount a volume here in Docker. */
  dataDir: process.env.COPILOT_DATA_DIR ?? "./data",
  /** Tool results larger than this many chars are spilled to disk (query via query_result). */
  spillThreshold: Number(process.env.COPILOT_SPILL_THRESHOLD ?? 12000),
  /** AWS region for the SSM host-inspect tool. */
  awsRegion: process.env.AWS_REGION ?? "ap-northeast-1",
  /** Enable the SSM host-inspect tool (runs commands on EC2 hosts). */
  hostInspectEnabled: (process.env.COPILOT_HOST_INSPECT ?? "true") !== "false",
  /**
   * Host command policy:
   *  - "allowlist"  (default, safest): only known read-only commands.
   *  - "permissive": allow anything EXCEPT a destructive denylist (kill/terminate/
   *    restart/rm/delete/format/stop/disable/install/writes/...). NOT strictly read-only.
   */
  hostMode: (process.env.COPILOT_HOST_MODE ?? "allowlist").toLowerCase(),
};

/** The SDK auto-reads these; we only check that one is present. */
export const hasAuth = Boolean(
  process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN,
);
