# TODO: `db_query` — read-only DB investigation tool (with prod redaction)

**Status:** Not started · **Priority:** Medium · **Effort:** ~1 day code (dev-first); prod gated on infra.

## Goal
Make "error log → read the DB to see recent records" a first-class, SAFE capability — especially for
**prod** incident investigation — without leaking PII to chat. Today the agent can only do this via
`inspect_host` running raw `mysql` (clunky, dev-only in practice) or by handing the operator the SQL.

## Design
In-process SDK MCP tool `db_query(service, env, sql)` (same pattern as `query_result`/`inspect_host`):
1. **SELECT-only** — parse with `node-sql-parser`; reject any non-SELECT, DDL, multi-statement, or
   comment-hidden writes. (Don't trust command-name checks.)
2. **Auto-LIMIT** — append/enforce a cap (e.g. ≤100 rows).
3. **Redaction (deny-by-default for prod)** — return diagnostic columns in clear (`id`, `status`,
   `type`, `error_code`, `*_at` timestamps, `*_id` FKs, flags); MASK anything matching sensitive
   patterns (email/phone/name/password/token/secret/api_key/auth_data/balance/amount/card/cvv/ssn/
   dob/address/ip). Deny-by-default for prod: unknown columns → masked unless operator explicitly asks.
   Value-level mask for email/token-looking strings even in odd columns.
4. **Prod-data policy** stays in force — this tool is the *sanctioned* way to read prod (redacted),
   replacing the blanket block for investigation. Dev = full values (exempt).
5. **Connection resolve** — map (service, env) → host/db from service-catalog/env-files; creds from a
   read-only DB user (NOT the app user).
6. **Audit** — log every prod query (who/when/SQL/rows) to the server log.

## Safety layers (prod)
- **Read-only DB user** (`GRANT SELECT` only) → hard guarantee no mutation even if SELECT-parse misses.
- SELECT-only parse + auto-LIMIT.
- Deny-by-default column redaction.
- Audit log.

## Infra prerequisites (the actual blockers — NOT code)
1. **Read-only DB user on prod RDS** (`GRANT SELECT`) — must be provisioned (DBA/operator).
2. **Network path to prod RDS** — local machine canNOT reach RDS (private + SG). Options:
   - **SSM-on-host**: run `mysql` via SSM on a host inside the VPC that reaches RDS (works pre-deploy).
   - **Direct connect** (mysql2): only from the EKS pod (in-VPC) — i.e. after Phase-2 deploy.

## Open decisions (from chat)
1. Connection path: **SSM-on-host** (recommended, works now for in-VPC reach) vs direct (EKS only).
2. Redaction: **deny-by-default** (recommended, safest) vs denylist-of-sensitive-columns (more convenient).
3. Read-only DB user: provision per env? (strongly recommended).

## Build plan
1. **Dev-first**: build the tool + SELECT-only + auto-LIMIT + redaction; wire connection via SSM-on-host
   (dev DBs are local on AIO hosts, creds in env-files). Testable immediately.
2. **Prod**: same code; enable once the read-only user + RDS path exist → config-only.

## Fallback (zero-infra, current behavior)
The agent already refuses to dump prod data and instead **hands the operator the SQL to run themselves**
+ offers non-sensitive aggregates (count/status/exists). Keep this until the tool lands.

## References
- Read-only enforcement: `src/readonly.ts` · host inspect + validator: `src/hostcmd.ts`
- Prod secrets & data policy: persona in `src/knowledge.ts` ("Production secrets & sensitive data")
- In-process tool pattern (alwaysLoad): `src/skills.ts`, `src/spill.ts`
- Service/DB inventory: `knowledge/40-service-catalog.md`, `knowledge/41-infra-inventory.md`
