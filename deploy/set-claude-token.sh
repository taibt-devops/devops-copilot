#!/usr/bin/env bash
# Set CLAUDE_CODE_OAUTH_TOKEN in the DevOps Copilot Secrets Manager secret WITHOUT
# printing it anywhere. Run on a machine with AWS creds + node, after `claude setup-token`.
#
#   claude setup-token            # prints a token (Max subscription, ~1 year)
#   ./deploy/set-claude-token.sh  # paste it at the prompt (hidden input)
#
# Then restart the container so it re-hydrates:
#   ssh root@<vm> 'docker restart devops-copilot'
set -euo pipefail

SECRET="${COPILOT_SECRET_ID:-devops-copilot/config}"
REGION="${AWS_REGION:-us-east-1}"
TOKEN="${1:-}"
if [ -z "$TOKEN" ]; then
  read -rsp "Paste CLAUDE_CODE_OAUTH_TOKEN (hidden): " TOKEN; echo
fi
[ -n "$TOKEN" ] || { echo "no token given" >&2; exit 1; }

tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
aws secretsmanager get-secret-value --secret-id "$SECRET" --region "$REGION" \
  --query SecretString --output text \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);o.CLAUDE_CODE_OAUTH_TOKEN=process.argv[1];process.stdout.write(JSON.stringify(o,null,2))})' "$TOKEN" \
  > "$tmp"

aws secretsmanager put-secret-value --secret-id "$SECRET" --region "$REGION" \
  --secret-string "file://$tmp" >/dev/null

echo "OK: CLAUDE_CODE_OAUTH_TOKEN set in $SECRET."
echo "Restart the container to apply:  ssh root@<vm> 'docker restart devops-copilot'"
