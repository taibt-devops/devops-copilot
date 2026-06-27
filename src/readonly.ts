/**
 * Read-only enforcement — the defining security property of this app.
 *
 * `readonlyGate` is wired into the SDK's `canUseTool`. It is the single source of
 * truth that decides, per tool call, whether the agent may proceed. Read-only is
 * enforced HERE, in code — never by trusting the system prompt.
 *
 * Three independent layers protect against mutation (see SPEC §6):
 *   1. this gate (deny any mutating tool),
 *   2. `disallowedTools` (hard-deny shell/file-write built-ins),
 *   3. read-only credentials/roles on the MCP servers themselves.
 */

/**
 * Verb classification by WHOLE TOKEN, not substring — otherwise "fetch_skill"
 * matches "kill" and "get_build_status" matches "build". We tokenize the action
 * (split on _, -, non-alnum, and camelCase) and classify:
 *   - any READ verb present  -> read  (a read verb wins, e.g. get_build_status)
 *   - else any WRITE verb     -> write
 *   - else                    -> read (no recognizable verb; e.g. call_aws — the
 *                                command-input guard in the gate handles those)
 */
const READ_VERBS = new Set([
  "get", "list", "search", "query", "count", "fetch", "read", "describe", "show",
  "find", "lookup", "watch", "head", "scan", "view", "logs", "log", "status", "stat",
  "inspect", "top", "ping", "check", "summary", "summarize", "explain", "analyze",
  "diff", "history", "events", "metadata", "info", "tail", "resolve", "suggest",
]);
const WRITE_VERBS = new Set([
  "create", "update", "delete", "put", "post", "apply", "patch", "scale", "restart",
  "exec", "add", "remove", "trigger", "build", "set", "edit", "write", "drain",
  "cordon", "rollout", "annotate", "label", "cancel", "stop", "start", "reboot",
  "terminate", "destroy", "modify", "attach", "detach", "enable", "disable", "grant",
  "revoke", "send", "publish", "approve", "reject", "merge", "push", "deploy",
  "rollback", "run", "invoke", "kill", "drop", "truncate", "insert", "register",
  "unregister", "mark", "reset", "import", "export", "copy", "move", "rename",
]);

function actionTokens(action: string): string[] {
  return action
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // split camelCase
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/** Built-in tools that are safe to read with. */
const READ_BUILTINS = new Set(["Read", "Grep", "Glob", "WebSearch", "TodoWrite"]);

/** Built-ins that could mutate or exfiltrate — always denied. */
const HARD_DENY = new Set([
  "Bash",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch", // arbitrary URL fetch = exfiltration risk
]);

/** Exposed to the SDK as `disallowedTools` (defense-in-depth with the gate). */
export const disallowedTools = [...HARD_DENY];

/**
 * Command-execution tools carry the REAL operation inside their input, not the
 * tool name (e.g. the AWS API server's `call_aws` with `aws ec2 terminate-instances`).
 * For these we must inspect the input — the name-based check alone would wave them through.
 */
const COMMAND_TOOLS = /(call_aws|aws_cli|execute|run_command|exec)/i;
/** Obvious mutating AWS CLI operations to deny if seen in a command tool's input. */
const AWS_WRITE_OP =
  /\b(create|delete|terminate|put-|update|modify|reboot|stop-instances|start-instances|attach|detach|authorize|revoke|associate|disassociate|register|deregister|set-|enable|disable|cancel|release|allocate|import-|restore|reset|send|publish|invoke|deploy|add-|remove-|replace-|tag-resources|untag)/i;

function commandLooksMutating(input: Record<string, unknown>): boolean {
  try {
    return AWS_WRITE_OP.test(JSON.stringify(input ?? {}));
  } catch {
    return true; // unparseable → assume unsafe
  }
}

/** Pure decision function for name-based read/write classification. */
export function isReadOnlyTool(toolName: string): boolean {
  if (HARD_DENY.has(toolName)) return false;
  if (READ_BUILTINS.has(toolName)) return true;
  if (toolName.startsWith("mcp__")) {
    // tool name shape: mcp__<server>__<action>
    const action = toolName.split("__").slice(2).join("__");
    const toks = actionTokens(action);
    if (toks.some((t) => READ_VERBS.has(t))) return true; // a read verb wins
    if (toks.some((t) => WRITE_VERBS.has(t))) return false;
    return true; // no recognizable verb (e.g. call_aws) — command guard handles it
  }
  return false; // default deny
}

type PermissionResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/** The `canUseTool` callback passed to the SDK. */
export async function readonlyGate(
  toolName: string,
  input: Record<string, unknown>,
): Promise<PermissionResult> {
  if (!isReadOnlyTool(toolName)) {
    return {
      behavior: "deny",
      message: `DevOps Copilot is read-only: tool '${toolName}' is blocked. Describe the change instead of performing it.`,
    };
  }
  // Extra guard: command-execution tools hide the operation in their input.
  const action = toolName.startsWith("mcp__")
    ? toolName.split("__")[2] ?? ""
    : toolName;
  if (COMMAND_TOOLS.test(action) && commandLooksMutating(input)) {
    return {
      behavior: "deny",
      message: `DevOps Copilot is read-only: the command for '${toolName}' appears to mutate. Only read operations (describe/get/list) are allowed.`,
    };
  }
  return { behavior: "allow", updatedInput: input };
}
