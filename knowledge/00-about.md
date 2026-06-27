# Knowledge base

Every `*.md` file in this directory is concatenated into the agent's system prompt
at startup (sorted by filename). Put runbooks, the API domain map, service catalog,
and incident patterns here.

Guidance:
- Keep each file focused; prefix with a number to control ordering (`10-`, `20-`…).
- Encode the **trust-label convention** so answers carry calibrated confidence:
  `[OBS]` observed, `[CANDIDATE]` plausible, `[?]` uncertain.
- Prefer terse, operational facts ("X symptom → usually Y cause → check Z").
- Do NOT put secrets here — this becomes prompt text.

To wire in the real domain map, copy or symlink the relevant docs from the hub
(e.g. `devops-mcp-hub/docs/API_DOMAIN_MAP.md`, per-repo `DOMAIN.md`) into this folder,
or point `COPILOT_KNOWLEDGE_DIR` at a directory that already contains them.
