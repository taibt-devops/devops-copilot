---
name: example-service-5xx
description: a service returns 5xx after a deploy — example runbook showing the skill format
---

# Example runbook: service returns 5xx after a deploy

> This is a **generic example** demonstrating the skill (runbook) format. The agent
> injects only the `name` + `description` above into its prompt, and fetches this body
> on demand via the `fetch_skill` tool. Replace with your own real runbooks.

When a service starts returning 5xx shortly after a deploy:

1. **Confirm the symptom** — query the logs for the service over the last 30 min and
   group by status code / error message. Is it actually 5xx, and since when?
2. **Correlate with deploys** — check the most recent CI/CD job for the service. Does the
   error start time line up with a rollout?
3. **Read the error** — pull a representative stack trace / error line. If it points at
   application code, Grep the source repo for the message and read `file:line`.
4. **Check dependencies** — DB / cache / downstream service reachable? A 5xx is often a
   failed dependency, not the service itself ("five whys").
5. **Report** — probable cause with `[OBS]`/`[CANDIDATE]` confidence and evidence. If a
   rollback or config change is needed, **describe** it — do not perform it (read-only).
