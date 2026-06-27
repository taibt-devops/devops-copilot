# Topology (EXAMPLE — replace with your own)

> This is a **generic example** showing the kind of always-on context to put here.
> Replace every value with your own environment. Keep it terse — this text is
> concatenated into the system prompt on every request, so keep it small.

## Environments
- `dev` — shared development cluster. Throwaway data; dev secrets may be shown.
- `prod` — production. Treat all credentials and data records as sensitive.

## Where things run
- Most stateless services run on **Kubernetes** (the `kubernetes` tool sees these).
- Some stateful services (message broker, cache) are **self-hosted on VMs/EC2** and are
  invisible to the Kubernetes tool — use the cloud `describe` tools or `inspect_host`.

## Example services (placeholders)
| Service        | Env   | Runs on    | Notes                                  |
|----------------|-------|------------|----------------------------------------|
| `auth-service` | dev   | Kubernetes | issues JWTs; 401s often = expired token |
| `payment-api`  | prod  | Kubernetes | bank/gateway integrations              |
| `message-bus`  | dev   | VM (Docker)| RabbitMQ; check with `inspect_host`    |

## Observability
- Logs: OpenSearch index pattern `*-logs-*`.
- Metrics/traces: Grafana dashboards + Prometheus.
- CI/CD: Jenkins jobs grouped by team folders.
