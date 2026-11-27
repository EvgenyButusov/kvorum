# ClickHouse memory-tracker drift

ClickHouse refuses queries with `MEMORY_LIMIT_EXCEEDED` while its resident set is well
under the cap. The memory it thinks it is using has drifted upward and never comes back
down.

## Recognising it

The error text carries the diagnosis — compare its two numbers:

```
Memory limit (total) exceeded: would use 770.98 MiB (attempt to allocate chunk of 0 bytes),
current RSS 475.45 MiB, maximum: 768.00 MiB
```

Drift, not demand, when:

- **`would use` exceeds `current RSS` by a stable margin** across several errors. Real
  pressure moves with the workload; drift is a constant offset.
- **Allocations of 0 bytes fail.** The baseline alone is already over the cap, so queries
  are rejected before asking for anything.
- **`MemoryTracking` is absurd.** In the November 2026 case it read 1.2 TiB against a
  resident set of 404 MiB. This metric is a casualty rather than the cause — the limit
  check reads its own value, and failed allocations stay counted here — so treat it as a
  symptom, not a measurement.

```bash
kubectl -n kvorum exec kvorum-clickhouse-0 -- clickhouse-client -q "select (select value from system.metrics where metric='MemoryTracking') tracking, (select value from system.asynchronous_metrics where metric='MemoryResident') rss, (select value from system.errors where name='MEMORY_LIMIT_EXCEEDED') errors, uptime()"
```

Check which client is affected before treating it as an ingestion problem. In the
November 2026 case every error landed on API reads and none on the indexer, so the
dead-letter queue stayed empty while dashboard requests failed:

```bash
kubectl -n kvorum logs deploy/kvorum-api --since=6h | grep -c "Memory limit"
```

## Fixing it

A restart resets the tracker. `kvorum-clickhouse-restart` does this monthly; to do it by
hand:

```bash
kubectl -n kvorum delete pod kvorum-clickhouse-0
```

The replacement keeps the pod name, so wait for the delete before waiting for `Ready` or
the check passes against the still-terminating pod.

Go just after an hourly poll and away from the nightly backup. Reads fail for the few
seconds the pod is down and an archive write landing in that window dead-letters, so
check dead-letter depth afterwards — see [ingestion-dlq.md](ingestion-dlq.md).

Expect the tracked total to drop to tens of MiB and stay below the resident set. In
November 2026 it went from 1.2 TiB to 75 MiB, and errors from 251,039 over 47 days to
none.

## Why not raise the cap

The drift is unbounded, so any cap buys time rather than fixing it, and
`max_server_memory_usage` is already 768 MiB against a 1280 MiB pod limit on a node
shared with Postgres, four Node services and Prometheus
(`infra/k8s/components/data/kvorum-limits.xml`). Raising it moves ClickHouse closer to
its cgroup limit, where an OOM kill produces refused connections — a worse failure than a
rejected query, because writes then dead-letter.

Genuine pressure looks different and does happen: in October 2026 the resident set
reached 990 MiB, above the cap, driven by ClickHouse's own system-log merges. That was
fixed by removing those tables, not by raising the cap.

## The durable fix

Later ClickHouse versions correct the global tracker from a real measurement each tick of
the memory worker. 24.10 has no such setting — confirm against the candidate image rather
than the documentation, since the default has changed between releases:

```bash
clickhouse-client -q "select name, value, default from system.server_settings where name like 'memory_worker%'"
```

Once running a version that corrects the tracker, delete the restart CronJob.

## Related gap

Prometheus scrapes only the three application pods, so ClickHouse and Postgres export
nothing to it. The 251,039 errors above were invisible to monitoring for seven weeks.
Until an exporter exists, the queries in this runbook are the only way to see this.
