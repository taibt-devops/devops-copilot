import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { CONFIG } from "./config.js";

/**
 * Secret hydration from AWS Secrets Manager.
 *
 * Instead of baking MCP tokens / the Claude token into the image or a .env file on
 * the host, the app pulls them from ONE Secrets Manager secret at boot. The secret is
 * a flat JSON object of ENV_VAR -> value, e.g.:
 *
 *   {
 *     "CLAUDE_CODE_OAUTH_TOKEN": "...",
 *     "GRAFANA_SERVICE_ACCOUNT_TOKEN": "...",
 *     "OPENSEARCH_USERNAME": "opensearch-reader",
 *     "OPENSEARCH_PASSWORD": "...",
 *     "MCP_JENKINS_USER": "jenkins-bot",
 *     "MCP_JENKINS_API_TOKEN": "...",
 *     "BACKLOG_API_KEY": "...",
 *     "GITLAB_PERSONAL_ACCESS_TOKEN": "..."
 *   }
 *
 * Each key is injected into process.env (an already-set env var WINS, so a per-deploy
 * override is still possible). The MCP config template then references these via
 * ${VAR} placeholders (see mcp.ts / deploy/mcp.template.json), and the SDK reads
 * CLAUDE_CODE_OAUTH_TOKEN straight from the environment.
 *
 * The only secret that must reach the container directly is the AWS credential used to
 * READ this secret (env AWS_ACCESS_KEY_ID/SECRET on a non-EC2 host, or an IAM role on
 * EC2/EKS). Everything else lives in Secrets Manager.
 *
 * No-op when COPILOT_SECRET_ID is unset (e.g. local dev with a .env).
 */
export async function hydrateSecrets(): Promise<void> {
  const id = CONFIG.secretId;
  if (!id) return;

  const client = new SecretsManagerClient({ region: CONFIG.awsRegion });
  const res = await client.send(new GetSecretValueCommand({ SecretId: id }));
  const raw = res.SecretString;
  if (!raw) {
    console.warn(`[secrets] ${id} has no SecretString — nothing to hydrate`);
    return;
  }

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error(`[secrets] ${id} is not valid JSON`);
  }

  let injected = 0;
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === "") continue; // skip empty placeholders (e.g. unset Claude token)
    const cur = process.env[k];
    if (cur === undefined || cur === "") {
      process.env[k] = String(v);
      injected++;
      keys.push(k);
    }
  }
  // Names only — never log values.
  console.log(`[secrets] hydrated ${injected} value(s) from ${id}: ${keys.join(", ")}`);
}
