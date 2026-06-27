# Deploy — Docker on a VM

Single-container deploy. Secrets (Claude + MCP tokens) live in **AWS Secrets Manager**; the
only thing on the host is a **read-only AWS credential** to read that secret. Your application
source is cloned to a host folder and bind-mounted read-only so the agent Greps raw code directly.

> All values below (account, hostnames, paths, IAM names) are **examples** — replace with your own.

## Layout on the VM (`/opt/devops-copilot`)
```
/opt/devops-copilot/                 # git clone of this repo
  deploy/code-docs/                  # curated DOMAIN.md/etc (transferred, gitignored)
  source/<repo>/                     # cloned raw code + overlaid docs (refresh-source.sh)
  runtime/
    .env                             # NO secrets — profile/region/secret-id/port
    aws/{credentials,config}         # ONLY a read-only IAM user, uid 10001, chmod 600
    kube/config                      # kubeconfig (exec: aws, read-only profile)
```
Container mounts (all read-only):
`runtime/aws -> /secrets/aws`, `runtime/kube -> /home/appuser/.kube`,
`source -> /srv/code`.
AWS creds are mounted at `/secrets/aws` (NOT `~/.aws`) and pointed to via
`AWS_SHARED_CREDENTIALS_FILE`/`AWS_CONFIG_FILE`, so `~/.aws` stays writable — the
`aws-api` MCP server hardcodes a log dir at `~/.aws/aws-api-mcp` and crashes on a
read-only `~/.aws`.

## AWS identity — one read-only user
Use a single **read-only IAM user** (e.g. `devops-copilot-ro`) for everything: read the secret,
the `aws-api` MCP server, EKS (mapped in `aws-auth` to a read-only group → ClusterRole
`get/list/watch`), and SSM host inspection. Permissions:
- AWS managed `ReadOnlyAccess` + an inline policy for `secretsmanager:GetSecretValue` on the
  one secret.
- inline policy for `ssm:SendCommand` scoped to the `AWS-RunShellScript` document + account
  instances, plus `ssm:GetCommandInvocation` — for `inspect_host` (`COPILOT_HOST_INSPECT=true`).
  Read-only at the COMMAND level is enforced by the app's allowlist validator
  (`src/hostcmd.ts`), NOT by IAM — `SendCommand` itself is powerful, so the app gate is the
  real guarantee. No write actions anywhere else.

## Secret: `devops-copilot/config` (Secrets Manager)
Flat JSON of `ENV_VAR -> value`, injected into the env at boot (see `src/secrets.ts`):
`CLAUDE_CODE_OAUTH_TOKEN`, `GRAFANA_SERVICE_ACCOUNT_TOKEN`, `OPENSEARCH_PASSWORD`,
`MCP_JENKINS_API_TOKEN`, `BACKLOG_API_KEY`, `GITLAB_PERSONAL_ACCESS_TOKEN` (used only by
`refresh-source.sh` to clone, NOT as an MCP server). The MCP template
(`deploy/mcp.template.json`) references these via `${VAR}` placeholders.

## Source code for the agent
`deploy/refresh-source.sh` clones your repos into `source/<repo>` (shallow, default branch)
and overlays any curated docs, using the read-only GitLab PAT from Secrets Manager. Run it once
at setup and on a **cron (~hourly)**:
```bash
# /etc/cron.d/devops-copilot-source  (on the VM)
0 * * * * root COPILOT_SECRET_ID=devops-copilot/config AWS_REGION=us-east-1 \
  AWS_SHARED_CREDENTIALS_FILE=/opt/devops-copilot/runtime/aws/credentials \
  AWS_PROFILE=devops-copilot-ro bash /opt/devops-copilot/deploy/refresh-source.sh >> /var/log/copilot-source.log 2>&1
```
The container reads the mount per-request, so no restart is needed after a refresh.

## Build & run
```bash
# workstation (has the local-only curated docs):
node deploy/gather-docs.mjs ./source            # stage deploy/code-docs/
git push

# VM:
git clone https://gitlab.example.com/your-group/devops-copilot.git /opt/devops-copilot
#   transfer curated docs: tar -czf - -C deploy code-docs | ssh root@<vm> 'tar -xzf - -C /opt/devops-copilot/deploy'
cd /opt/devops-copilot
bash deploy/refresh-source.sh                   # initial clone of source/
docker build -f deploy/Dockerfile -t devops-copilot:latest .
docker run -d --name devops-copilot --restart unless-stopped \
  -p 8787:8787 --env-file runtime/.env \
  -v /opt/devops-copilot/runtime/aws:/secrets/aws:ro \
  -v /opt/devops-copilot/runtime/kube:/home/appuser/.kube:ro \
  -v /opt/devops-copilot/source:/srv/code:ro \
  devops-copilot:latest
```
`runtime/.env` must set `AWS_SHARED_CREDENTIALS_FILE=/secrets/aws/credentials` and
`AWS_CONFIG_FILE=/secrets/aws/config` (the AWS SDK/CLI + kubeconfig exec read creds from
there; `~/.aws` is left writable for `aws-api`).

NOTE: after editing `runtime/.env`, you must `docker rm -f devops-copilot` + `docker run`
again — `docker restart` does NOT re-read `--env-file`.

## Set the Claude token (one-time, kept out of any log)
```bash
claude setup-token                 # Max subscription, ~1 year (interactive terminal only)
./deploy/set-claude-token.sh       # paste at the hidden prompt -> updates Secrets Manager
ssh root@<vm> 'docker restart devops-copilot'   # token is read at boot; restart re-hydrates
```

## Hardening checklist
- [ ] Scoped **read-only IAM user** (no write; secret read limited to the one secret).
- [ ] EKS mapped read-only (ClusterRole `get/list/watch`; `auth can-i create` → no).
- [ ] `inspect_host` `ssm:SendCommand` scoped to `AWS-RunShellScript`; read-only enforced by
  the app allowlist validator (the IAM grant alone is not read-only).
- [ ] Read-only GitLab PAT (`read_api`/`read_repository`) in the secret.
- [ ] TLS + SSO (e.g. an OIDC provider) if exposed beyond the LAN.
- Note: k8s RBAC `*` includes secrets at the API level; secret EXPOSURE is blocked by the
  agent persona, not RBAC. Tighten by excluding `secrets` from the ClusterRole if desired.
