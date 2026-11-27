# Ingestion DLQ triage

Covers `ingestion_dlq`: chain events that failed an archive or projection stage past
their retries. For the AI job queue see [m5-ai-dlq-triage.md](m5-ai-dlq-triage.md).

## Why this matters

A dead-lettered archive event is **absent from ClickHouse**, and the poll cursor has
already advanced past it. Nothing re-drives it automatically. Between 2026-09-30 and
2026-11-22 ClickHouse refused inserts — error 241 against its 768 MiB
`max_server_memory_usage` cap, and `ECONNREFUSED` while it restarted — and 1230 rows
accumulated unread. 499 of them were still missing from the archive two months later.

The DLQ row is the only record of the loss, and it carries the canonical identity
(`archive_source_type`, `archive_chain_id`, `archive_tx_hash`, `archive_log_index`), so
a re-drive is always possible.

## Alerts

`KvorumIngestionDlqGrowing`, `KvorumArchiveWriteDlqRouted`,
`KvorumArchiveLogTransientDlq` and `KvorumDerivationParkedRising`
(`infra/k8s/components/monitoring/prometheus-rules.yaml`) watch for _new_ loss. They
deliberately alert on growth, not depth, so a backlog awaiting re-drive does not pin
them on — which also means an existing backlog is invisible to them. Check depth
directly when you want the standing number.

No Alertmanager is deployed: these appear in the Prometheus UI and as `ALERTS` series
in Grafana.

## Triage

Depth by stage and source:

```bash
kubectl -n kvorum exec kvorum-postgres-0 -- psql -U kvorum -d kvorum -c "select stage, archive_source_type, count(*), min(first_seen_at), max(last_attempt_at) from ingestion_dlq group by 1,2 order by 3 desc"
```

The error class tells you whether a re-drive will succeed:

```bash
kubectl -n kvorum exec kvorum-postgres-0 -- psql -U kvorum -d kvorum -c "select stage, error->>'code' code, left(error->>'message',60), count(*) from ingestion_dlq group by 1,2,3 order by 4 desc limit 20"
```

`archive_log` rows carry only `job <uuid> exhausted retries`, because pg-boss's
dead-letter path does not keep the last error. The cause is in the inner stage's own
rows, or in the indexer logs for that window.

How much is genuinely still missing — a repaired identity leaves a stale DLQ row behind:

```bash
kubectl -n kvorum exec kvorum-postgres-0 -- psql -U kvorum -d kvorum -c "select d.stage, d.archive_source_type, count(*) dlq, count(ae.id) archived, count(ae.derived_at) derived from ingestion_dlq d left join archive_event ae on ae.source_type=d.archive_source_type and ae.chain_id=d.archive_chain_id and ae.tx_hash=d.archive_tx_hash and ae.log_index=d.archive_log_index where d.archive_source_type is not null group by 1,2 order by 3 desc"
```

Rows where `archived` equals `dlq` are already repaired and want `dlq accept`, not a
retry.

## Re-drive

Confirm the dependency is healthy first — a bulk retry against a ClickHouse that is
still refusing inserts just re-dead-letters everything.

```bash
pnpm admin-cli dlq retry-batch --stage delegation_archive_stage --source compound_comp_token --limit 500 --dry-run
```

Drop `--dry-run` to apply. It works oldest first and **stops at the first failure**,
reporting how many succeeded, so a systemic problem surfaces on row one instead of
row four hundred. Re-run it to continue after a fix. Every run is recorded in
`admin_audit`.

A single row still goes through `dlq retry <dlq_id>`. `dlq accept <dlq_id> --reason …`
discards one permanently (ADR-032) and is correct only for a row that is already
repaired or provably not recoverable.

Verify with the missing-identity query above, then confirm the archive is derived:
un-derived rows are the projection's problem, not the archive's, and
[state-reconciliation.md](state-reconciliation.md) covers parked and held derivations.

## If ClickHouse is the cause

`max_server_memory_usage` is 768 MiB against the pod's 1280 MiB limit
(`infra/k8s/components/data/kvorum-limits.xml`), because the node also carries
Postgres, four Node services and Prometheus. Compare `would use` against `current RSS` in
the error first: a stable gap means tracker drift, which a restart clears — see
[clickhouse-memory-tracker-drift.md](clickhouse-memory-tracker-drift.md). Otherwise
establish what actually consumed the memory — `system.errors` for code 241, the pod's
`restartCount`, and what else ran at that moment. The September 2026 window was
ClickHouse's own system-log merges, fixed by removing those tables, not by raising
the cap.
