# DevOps Copilot — runtime image
# Multi-stage: build TS, then a slim non-root runtime that also carries the MCP
# server runtimes (uv for python servers, npx/node for node servers).

# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# uv provides `uvx` for python-based MCP servers; git/ca-certs for fetches; aws CLI v2 is
# needed by the kubeconfig exec credential plugin (`aws eks get-token`) for the k8s server.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git unzip \
    && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
    && ARCH=$(uname -m) \
    && curl -sSL "https://awscli.amazonaws.com/awscli-exe-linux-${ARCH}.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip \
    && apt-get purge -y unzip && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY web ./web
COPY knowledge ./knowledge
COPY skills ./skills

# Curated, local-only repo docs (DOMAIN.md/CLAUDE.md/DECISIONS.md + root SERVICES.md/
# FINDINGS.md). If you keep such docs git-IGNORED in their source repos, stage them into
# the build context first — run `node deploy/gather-docs.mjs` BEFORE `docker build`.
# Bundled curated docs are a FALLBACK for runs without the source volume. In the real
# deploy, a host folder (cloned by deploy/refresh-source.sh: raw code + overlaid docs) is
# bind-mounted read-only at /srv/code, shadowing this and giving the agent full Grep access.
COPY deploy/code-docs/ /srv/code/
# MCP config TEMPLATE — token fields are ${VAR} placeholders (no secrets in the image);
# expanded at boot from process.env, hydrated from AWS Secrets Manager.
COPY deploy/mcp.template.json ./deploy/mcp.template.json

# Agent Greps/Reads raw code directly from the mounted source at /srv/code.
ENV COPILOT_CODE_DIRS=/srv/code
# aws-api is app-local (read-only). Raw code is read from the mounted source volume
# (cloned by refresh-source.sh); the GitLab PAT is only used there.
ENV COPILOT_MCP_SERVERS=grafana,opensearch,jenkins,kubernetes,backlog,aws-api
# Read MCP tokens (and the Claude token) from this Secrets Manager secret at boot.
ENV COPILOT_MCP_CONFIG=/app/deploy/mcp.template.json \
    COPILOT_SECRET_ID=devops-copilot/config \
    AWS_REGION=us-east-1

# SDK refuses to run with root privileges; run as an unprivileged user.
RUN useradd -m -u 10001 appuser && chown -R appuser:appuser /app /srv/code
USER appuser

EXPOSE 8787
CMD ["node", "dist/server.js"]
