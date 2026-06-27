#!/usr/bin/env bash
# refresh-source — clone/pull your application source repos into a folder that is
# bind-mounted read-only into the container, so the agent can Grep/Glob/Read raw code
# directly (faster & more powerful than per-file API reads). Run by cron on the VM.
#
# Flow per repo: shallow clone (or pull) the default branch, then OVERLAY any curated
# local-only docs (DOMAIN.md/CLAUDE.md/...) on top — those are git-ignored so a clone
# never brings them; they are staged separately (deploy/code-docs, see gather-docs.mjs).
#
# The GitLab token is read from AWS Secrets Manager at runtime (never stored on disk).
# Use a READ-ONLY PAT. Layout mirrors the local checkout so it matches the knowledge docs:
#   $SRC_ROOT/<relpath>/...                  <- raw code + overlaid docs
#   container COPILOT_CODE_DIRS=/srv/code     (== $SRC_ROOT mounted at /srv/code)
set -uo pipefail

SRC_ROOT="${COPILOT_SRC_ROOT:-/opt/devops-copilot/source}"
DOCS_ROOT="${COPILOT_DOCS_ROOT:-/opt/devops-copilot/deploy/code-docs}"
SECRET_ID="${COPILOT_SECRET_ID:-devops-copilot/config}"
REGION="${AWS_REGION:-us-east-1}"
DEPTH="${COPILOT_CLONE_DEPTH:-1}"      # shallow by default; set 0 for full history
HOST="${COPILOT_GIT_HOST:-gitlab.example.com}"

# relpath (under SRC_ROOT/, matches the local checkout & knowledge docs) | git project path
# Replace these example entries with your own repos.
REPOS="
team-a/backend|group/team-a/backend
team-a/frontend|group/team-a/frontend
shared/common|group/shared/common
"

log() { echo "[refresh-source $(date -u +%H:%M:%S)] $*"; }

TOKEN="$(aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --region "$REGION" \
  --query SecretString --output text 2>/dev/null \
  | sed -n 's/.*"GITLAB_PERSONAL_ACCESS_TOKEN"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
if [ -z "$TOKEN" ]; then log "ERROR: no GITLAB_PERSONAL_ACCESS_TOKEN in secret $SECRET_ID"; exit 1; fi

depth_arg=""; [ "$DEPTH" != "0" ] && depth_arg="--depth $DEPTH"
ok=0; fail=0

echo "$REPOS" | while IFS='|' read -r rel proj; do
  [ -z "$rel" ] && continue
  dir="$SRC_ROOT/$rel"
  auth_url="https://oauth2:${TOKEN}@${HOST}/${proj}.git"
  clean_url="https://${HOST}/${proj}.git"
  if [ -d "$dir/.git" ]; then
    if git -C "$dir" pull --ff-only $depth_arg "$auth_url" >/dev/null 2>&1; then
      log "pulled  $rel"; ok=$((ok+1))
    else
      log "FAIL pull $rel"; fail=$((fail+1)); continue
    fi
  else
    mkdir -p "$(dirname "$dir")"
    if git clone $depth_arg "$auth_url" "$dir" >/dev/null 2>&1; then
      git -C "$dir" remote set-url origin "$clean_url"   # scrub token from stored remote
      log "cloned  $rel"; ok=$((ok+1))
    else
      log "FAIL clone $rel"; fail=$((fail+1)); continue
    fi
  fi
  # overlay curated local-only docs (DOMAIN.md/CLAUDE.md/...) on top of the checkout
  if [ -d "$DOCS_ROOT/$rel" ]; then
    cp -f "$DOCS_ROOT/$rel"/*.md "$dir"/ 2>/dev/null || true
  fi
done

# overlay root-level curated docs (SERVICES.md / FINDINGS.md) too
[ -d "$DOCS_ROOT" ] && cp -f "$DOCS_ROOT"/*.md "$SRC_ROOT/" 2>/dev/null || true

log "done. source at $SRC_ROOT"
