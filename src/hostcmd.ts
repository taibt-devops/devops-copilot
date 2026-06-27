import { posix as ppath } from "node:path";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from "@aws-sdk/client-ssm";
import { CONFIG } from "./config.js";

/**
 * inspect_host — run a SINGLE read-only diagnostic command on an EC2 host via SSM.
 *
 * Closes the blind spot for services self-hosted on EC2 (RabbitMQ users, systemd
 * status, open ports) that no read-only AWS API or the kubernetes tool can see.
 *
 * SECURITY (this is the highest-trust feature — keep the allowlist tight):
 *  - No shell metacharacters / pipes / redirects / substitution (single command only;
 *    large output auto-spills, the agent filters with query_result).
 *  - No streaming/follow flags.
 *  - Binary must be on a read-only allowlist; binaries with subcommands (rabbitmqctl,
 *    systemctl, docker, kubectl, journalctl) must use a read-only subcommand.
 *  - Sensitive paths (shadow, private keys, aws/ssh creds) are blocked.
 *  - SSM SendCommand is invoked by us directly (not via the read-only aws-api server,
 *    which would reject it) — the validator below is the safety boundary.
 *  - Production must scope the IAM/IRSA role's ssm:SendCommand to read use only.
 */

// shell control / redirect / substitution / pipe → reject (forces one simple command)
const META = /(\$\(|`|&&|\|\||[;&|<>(){}\\])/;
// streaming follow flags → reject (would never return)
const FOLLOW = /(^|\s)(-f|--follow)(\s|$)/;
// sensitive file references → reject even for cat/grep/tail
const SENSITIVE =
  /(\/etc\/shadow|\/etc\/gshadow|id_rsa|id_ed25519|id_ecdsa|\.pem(\s|$)|\.key(\s|$)|\/proc\/\d+\/environ|\.aws\/credentials|\.ssh\/|private[_-]?key)/i;

// binaries whose whole invocation is read-only
const ALWAYS_READ = new Set([
  "ss", "netstat", "ps", "ls", "df", "free", "uptime", "uname", "hostname",
  "whoami", "nproc", "date", "id", "lsof", "dmesg", "mount", "lscpu", "lsblk",
  "stat", "getent", "cat", "head", "tail", "grep", "wc",
]);
// binaries that require a read-only subcommand as their first argument
const SUBCOMMAND_READ: Record<string, RegExp> = {
  rabbitmqctl: /^(list_\w+|status|environment|cluster_status|node_health_check|ping|version)\b/,
  systemctl: /^(status|is-active|is-enabled|is-failed|list-units|list-unit-files|show|cat)\b/,
  journalctl: /^(?!.*(--follow|-f)).*$/,
  docker: /^(ps|logs|inspect|images|stats|version|info|top|port|diff)\b/,
  kubectl: /^(get|describe|logs|top|version|events|api-resources|api-versions|explain)\b/,
};

// docker exec flags that consume the next token (skip when finding the container)
const DOCKER_EXEC_VALUE_FLAGS = new Set(["-u", "--user", "-w", "--workdir"]);
// docker exec flags we refuse (env injection / privilege)
const DOCKER_EXEC_DENY_FLAGS = new Set(["-e", "--env", "--env-file", "--privileged"]);

// ---- permissive mode: allow everything EXCEPT clearly destructive operations ----
// Destructive binaries/verbs (whole-word).
const DESTRUCTIVE_TOKEN =
  /\b(rm|rmdir|unlink|shred|dd|mkfs\w*|mke2fs|fdisk|parted|wipefs|kill|pkill|killall|reboot|shutdown|poweroff|halt|telinit|terminate|destroy|delete|drop|purge|prune|flushall|flushdb|truncate|userdel|groupdel|deluser|useradd|usermod|groupadd|passwd|chpasswd|crontab|iptables|umount|visudo|mysqldump|pg_dump|pg_dumpall|mongodump|mongoexport)\b/i;
// Destructive subcommands of common tools.
const DESTRUCTIVE_SUBCMD = new RegExp(
  "\\b(systemctl|service)\\s+(stop|start|restart|reload|kill|disable|mask|isolate|reboot|poweroff)\\b" +
    "|\\bkubectl\\s+(delete|apply|edit|patch|replace|scale|drain|cordon|uncordon|taint|rollout|cp|annotate|label|set|create|expose|run|autoscale)\\b" +
    "|\\bdocker\\s+(rm|rmi|stop|start|restart|kill|prune|update|rename|create|run|build|push|commit|cp|exec\\s+\\S+\\s+(rm|kill|sh|bash))\\b" +
    "|\\brabbitmqctl\\s+(delete_\\w+|clear_\\w+|set_\\w+|change_\\w+|add_\\w+|reset|force_reset|stop\\w*|start_app|purge_\\w+|rename_\\w+|join_cluster|forget_cluster_node|update_\\w+|close_\\w+|enable_\\w+|disable_\\w+)\\b" +
    "|\\b(apt|apt-get|yum|dnf|apk|pip|pip3|npm|gem|snap)\\s+(install|remove|uninstall|purge|upgrade|autoremove|add|del)\\b" +
    "|\\bgit\\s+(push|reset|clean|checkout|rebase|commit|merge|rm)\\b",
  "i",
);
const WRITE_REDIRECT = />>?\s*(?!(\/dev\/null|&\d|&-))/; // redirect that writes a real file
const EXEC_SUBST = /(\$\(|`)/; // command substitution
const PIPE_TO_INTERP = /\|\s*(sudo\s+)?(sh|bash|zsh|ksh|python\d?|perl|ruby|node|eval|xargs)\b/i;
const NESTED_SHELL = /\b(bash|sh|zsh|ksh)\s+-[a-z]*c\b|\bsu\b|\bchroot\b/i;

function permissiveCheck(cmd: string): { ok: boolean; reason?: string } {
  if (FOLLOW.test(cmd)) return { ok: false, reason: "follow/stream flags (-f) not allowed (would hang)" };
  if (SENSITIVE.test(cmd)) return { ok: false, reason: "references a sensitive path (shadow/keys/creds)" };
  if (EXEC_SUBST.test(cmd)) return { ok: false, reason: "command substitution $()/`` not allowed" };
  if (WRITE_REDIRECT.test(cmd)) return { ok: false, reason: "writing redirect (> file) not allowed" };
  if (PIPE_TO_INTERP.test(cmd)) return { ok: false, reason: "piping into a shell/interpreter not allowed" };
  if (NESTED_SHELL.test(cmd)) return { ok: false, reason: "nested shell (sh -c / su / chroot) not allowed" };
  if (DESTRUCTIVE_TOKEN.test(cmd)) return { ok: false, reason: "destructive command (kill/terminate/restart/rm/delete/format/…) not allowed" };
  if (DESTRUCTIVE_SUBCMD.test(cmd)) return { ok: false, reason: "destructive subcommand not allowed" };
  return { ok: true };
}

export function validateHostCommand(
  raw: string,
  depth = 0,
  mode: string = CONFIG.hostMode,
): { ok: boolean; reason?: string } {
  const cmd = raw.trim();
  if (!cmd) return { ok: false, reason: "empty command" };

  // Permissive: allow read/view freely; block only the destructive denylist + escalation.
  if (mode === "permissive") return permissiveCheck(cmd);

  if (META.test(cmd))
    return { ok: false, reason: "no shell metacharacters/pipes/redirects — use one simple command (large output auto-spills; filter with query_result)" };
  if (FOLLOW.test(cmd)) return { ok: false, reason: "follow/stream flags (-f) not allowed" };
  if (SENSITIVE.test(cmd)) return { ok: false, reason: "references a sensitive path" };

  const c = cmd.replace(/^sudo\s+/, ""); // allow a single leading sudo, then validate the rest
  const toks = c.split(/\s+/);
  const bin = ppath.basename(toks[0]); // basename so /usr/sbin/rabbitmqctl validates as rabbitmqctl
  const rest = toks.slice(1);

  // `docker exec [flags] <container> <inner cmd>` — validate the INNER command read-only too
  if (bin === "docker" && rest[0] === "exec") {
    if (depth > 0) return { ok: false, reason: "nested docker exec not allowed" };
    let i = 1;
    while (i < rest.length && rest[i].startsWith("-")) {
      if (DOCKER_EXEC_DENY_FLAGS.has(rest[i])) return { ok: false, reason: `docker exec flag '${rest[i]}' not allowed` };
      i += DOCKER_EXEC_VALUE_FLAGS.has(rest[i]) ? 2 : 1;
    }
    const container = rest[i];
    const inner = rest.slice(i + 1).join(" ");
    if (!container) return { ok: false, reason: "docker exec: missing container" };
    if (!inner) return { ok: false, reason: "docker exec: missing command" };
    const innerCheck = validateHostCommand(inner, depth + 1);
    return innerCheck.ok ? { ok: true } : { ok: false, reason: `docker exec inner command: ${innerCheck.reason}` };
  }

  if (bin in SUBCOMMAND_READ) {
    return SUBCOMMAND_READ[bin].test(rest.join(" "))
      ? { ok: true }
      : { ok: false, reason: `'${bin} ${rest[0] ?? ""}' is not a read-only subcommand` };
  }
  if (ALWAYS_READ.has(bin)) return { ok: true };
  return { ok: false, reason: `'${bin}' is not on the read-only allowlist` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ssm = new SSMClient({ region: CONFIG.awsRegion });

async function runViaSsm(instanceId: string, command: string): Promise<string> {
  const send = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: "AWS-RunShellScript",
      Parameters: { commands: [command] },
      TimeoutSeconds: 60,
    }),
  );
  const id = send.Command?.CommandId;
  if (!id) return "SSM did not return a command id.";
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    try {
      const inv = await ssm.send(
        new GetCommandInvocationCommand({ CommandId: id, InstanceId: instanceId }),
      );
      if (inv.Status && ["Success", "Failed", "Cancelled", "TimedOut"].includes(inv.Status)) {
        const out = inv.StandardOutputContent ?? "";
        const err = inv.StandardErrorContent ? `\n[stderr]\n${inv.StandardErrorContent}` : "";
        return `[${inv.Status}] ${command} @ ${instanceId}:\n${out || "(no stdout)"}${err}`;
      }
    } catch {
      /* InvocationDoesNotExist right after send — keep polling */
    }
  }
  return `SSM command ${id} timed out waiting for output.`;
}

export const hostServer = createSdkMcpServer({
  name: "host",
  version: "1.0.0",
  alwaysLoad: true,
  tools: [
    tool(
      "inspect_host",
      "Run a SINGLE read-only diagnostic command on an EC2 host via SSM — for services self-hosted on the host (RabbitMQ, Redis, systemd) that no AWS API or the k8s tool can see. Allowed: rabbitmqctl list_*/status, systemctl status, journalctl, ss, ps, cat (non-secret), docker ps/logs, kubectl get/describe/logs, df/free/uptime, etc. No pipes, no writes, no follow. Large output auto-spills — filter with query_result.",
      {
        instance_id: z.string().describe("EC2 instance id, e.g. i-0123abcd"),
        command: z.string().describe("one read-only command (e.g. 'sudo rabbitmqctl list_users')"),
      },
      async (args) => {
        const command = String(args.command);
        const v = validateHostCommand(command);
        if (!v.ok) {
          return {
            content: [
              { type: "text", text: `Blocked (read-only host inspect): ${v.reason}.\nCommand: ${command}` },
            ],
          };
        }
        try {
          const text = await runViaSsm(String(args.instance_id), command);
          return { content: [{ type: "text", text }] };
        } catch (e) {
          return { content: [{ type: "text", text: `SSM error: ${(e as Error).message}` }] };
        }
      },
    ),
  ],
});
