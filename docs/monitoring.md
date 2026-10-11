# Private application monitoring

Configure the same independently generated, private `MONITORING_TOKEN` (32–256 characters) on API and worker. `/internal/metrics` requires its exact bearer token; absent configuration leaves the route disabled. It is not a workspace API key. Keep the metrics endpoints on the private ingress/network, use HTTPS for remote collection and mount the collector's bearer file read-only. Never put the token in query strings, screenshots or committed configuration.

`deploy/monitoring/prometheus.yml` supplies private API/worker scrape jobs. Its example `api` and `worker` names assume the collector joins the Compose service network; adapt targets for a separate private collector. Mount the token at `/run/secrets/agentconnect_monitoring_token` and the example rules at `/etc/prometheus/alerts.yml`. Import `deploy/monitoring/dashboard.json` into Grafana and select the appropriate Prometheus datasource. These files configure existing organization-managed monitoring services; they do not provision public dashboards or notification destinations.

## Collected signals

- API request counts and cumulative latency buckets by registered route template, bounded HTTP method and status class. Raw paths/IDs, query strings, headers, bodies, prompts, provider messages, recipients and credentials are excluded. Health/metrics requests do not inflate application traffic metrics.
- Actual API dependency readiness from the same bounded shared readiness probe used for traffic admission.
- Every worker loop's last completion time/duration, consecutive failures, iteration/error counters and overall readiness. Polls that found no work count as progress; these counters are not completed-job counts. Counters reset on process restart.
- Cross-tenant aggregate pending/running queue counts where supported, rolling 24-hour failed job counts and the oldest eligible queued job age for knowledge, workflows, evaluations, connectors, support triage, webhooks, mail and retention. Webhook failures use creation time because that queue has no failure timestamp. Future retry delays are excluded from due-age calculations. Workflow approval waiting is excluded. Support triage `failed` and retention object `blocked` counts are current gauges, not 24-hour failure counts; mail has no failed/running state to report.
- Actual completed/failed/cancelled agent runs in the last hour. This matters because a failed SSE chat can still have HTTP status 200. This is a rolling gauge, not a lifetime counter.

Metrics aggregate all organizations and therefore require an independent operational credential; they are not exposed through workspace permissions. Fixed route/task/queue/state labels avoid tenant-derived cardinality. HTTP metrics and worker progress are process-local, so retain each instance's Prometheus labels when scaling.

Queue collection uses a separate one-connection PostgreSQL pool with a two-second connect and statement limit, coalesces concurrent scrapes, caches successes for 15 seconds and briefly backs off failures. Collection failure returns 503 with only a fixed failure gauge, rather than stale successful queue metrics or a raw error. The API health routes and metrics route bypass the application Redis rate limiter so an operational scrape is not blocked by user traffic.

## Worker probes

The worker exposes `/health/live`, `/health/ready` and optional protected metrics on `WORKER_HEALTH_PORT=4100`. Development binds `WORKER_HEALTH_HOST=127.0.0.1`; the container image binds its private service port to `0.0.0.0`, with host publication limited to loopback by the release Compose file.

Readiness is false until every loop has completed an initial attempt, if any loop has three consecutive failures, if any loop has not completed within `WORKER_STALL_SECONDS` (default 300), or while stopping. Tune the threshold to exceed the longest legitimate task duration; an exceptionally long connector/evaluation job can intentionally make the worker unready. The current worker completes in-flight tasks on SIGTERM and stops future polling; the service manager's grace period bounds shutdown. Readiness failure alone does not make Docker restart an unhealthy container. Monitor and investigate before restarting, and rely on existing durable lease recovery rather than assuming exactly-once execution.

## Alert response

The included Prometheus rules cover lost scrapes, API/worker readiness failure, due jobs waiting ten minutes, blocked retention objects, HTTP error ratios and multiple failed agent runs. Thresholds are starting defaults to tune against observed workload. Configure receiver routing through the organization's Alertmanager; no messages or external notifications were sent by this implementation.

For worker/backlog alerts, check sanitized loop failure codes and dependency health, then inspect the corresponding workspace job histories. Check provider destination policy, credentials/account limits and current model configuration for agent failures. A stalled loop may require restarting the worker after confirming active job/lease status. Do not delete durable jobs or clear production Redis to silence alerts. For retention blocking, follow [retention](retention.md) before retrying deletion. For readiness or rollout failures, use the [release runbook](releases.md).

Prometheus/Grafana storage, host resource metrics, trace collection/privacy review, alert delivery, production cardinality/volume testing and HA/failover acceptance remain infrastructure/operator work. The existing OpenTelemetry opt-in behavior is unchanged. Monitoring signals do not certify backup recoverability or provider/business correctness.
