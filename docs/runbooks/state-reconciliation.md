# State Reconciliation Runbook (Issue #133)

This runbook covers operation and validation of the indexer state reconciler for event-silent governor transitions (`defeated`, `expired`, `active` corrections).

## Scope

- Source types: `compound_governor_alpha`, `compound_governor_bravo`, `compound_governor_oz` (reconciler plugins enabled).
- State reconciliation writes event-silent states and corrects OZ voting deadlines. Event-backed transitions are derived from archived logs.
- Independent archive reconciliation repairs missing confirmed governance logs, including votes (issue #725).

## Archive completeness reconciliation (issue #725)

Apply migrations `0017_archive_reconcile_cursor` (the per-source durable audit cursor, shared by every source) and `compound_005_archive_reconcile_index` (a partial range index over the governor archive rows) before deploying the updated indexer.

The existing Compound reconcile head listeners audit both PostgreSQL and ClickHouse against `eth_getLogs` for the original governor source. The worker audits only through the lesser of the confirmed head, the source's persisted live cursor minus 600 blocks (roughly two hours on Ethereum), and its configured end block. On its first run, it checks up to the preceding 50,000 blocks within the source's active range; thereafter it resumes from the independent durable checkpoint. Each tick processes at most 10,000 blocks in 2,000-block chunks. It restores missing events through the normal archive writer and checks both stores again before checkpointing. Missing events are projected by the ordinary indexer. Failed writes, malformed RPC logs, and missing readback leave the audit cursor unchanged; a later tick retries. It does not change the live or backfill cursor.

Monitor the `indexer_archive_audit_lag_blocks` gauge (normally near zero after the initial backlog drains), and the `indexer_state_reconcile_total` counter outcomes `archive_verified`, `archive_repaired`, and `archive_audit_failed`. Both have panels in the Platform Health dashboard. Investigate persistent lag or repeated failures; a stalled or absent live cursor also requires investigation. The failure log is `compound_archive_audit_failed`. Repairs log `compound_archive_repaired` with the audited block interval and recovered count.

### Repair volume KPI: north star = 0

Use `indexer_archive_audit_events_repaired_total` to count individual verified repairs (one logical event even if both stores were missing it). The low-cardinality labels are `source_type`, `event_type`, and `missing_store` (`postgres`, `clickhouse`, or `both`). Grafana displays rolling 24-hour volume and breakdown; the target is **zero after the initial historical catch-up**. Prometheus counters are process-local and `increase` estimates the count across scrape intervals and restarts; use structured logs for individual identities. Always interpret zero together with audit lag, verification progress, and failure outcomes — an inactive audit is not healthy.

```promql
sum(increase(indexer_archive_audit_events_repaired_total[24h])) or vector(0)
```

Each missing event produces `compound_archive_repair_started` followed by either `compound_archive_event_repaired` (after both stores are verified) or `compound_archive_repair_failed`. Logs include source, chain, governor, proposal ID, block and transaction hashes, log index, missing store, and relevant decoded vote or lifecycle values. Full proposal descriptions, calldata, and free-text vote reasons are deliberately omitted; the canonical event identity allows them to be retrieved when needed. Verified events are counted before the next event or checkpoint so a later failure does not erase partial progress. A crash between persistence and telemetry emission can still lose a metric increment; the start record identifies the interrupted repair for triage.

For each nonzero repair count, inspect the per-event logs and correlate the source block/transaction with ingestion logs, queue/DLQ outcomes, RPC responses, and archive failures; identify and fix the upstream cause. Preserve relevant JSON logs during triage: Kubernetes container logs are subject to rotation and are not a permanent audit ledger. Track legitimate event-silent state transitions (`corrected`), OZ deadline refreshes (`deadline_corrected`), and eligible voting power fills (`eligible_voting_power_filled`) separately in the state reconciler counter and corresponding `compound_*_reconciled` logs. They can be normal protocol behavior; distinguish those from unexpected repairs instead of treating all reconciliation writes as ingestion defects.

```sql
SELECT s.source_type, s.poll_cursor_block, c.last_checked_block,
       s.poll_cursor_block - 600 - c.last_checked_block AS blocks_behind_safe_cursor
FROM dao_source s
LEFT JOIN archive_reconcile_cursor c ON c.dao_source_id = s.id
WHERE s.source_type IN ('compound_governor_alpha', 'compound_governor_bravo', 'compound_governor_oz');
```

This is a rolling completeness check, not a full-history validation or a proof of RPC completeness. An RPC provider that silently omits the same event on both the original ingestion and the independent audit can still evade detection. Historical ranges preceding the initial audit window require a separately scoped canonical audit. Reorg cleanup remains the responsibility of the existing reorg pipeline. Projection rows whose parent proposal is not yet derived are held for retry rather than dropped, but the hold is bounded — see below.

## Prerequisites

1. Migration `compound_001_schema` is applied. It creates:

- `compound_proposal_meta.queued_at_block` — populated by the applier on `ProposalQueued` events; used by the reconciler to timestamp `expired` transitions
- `compound_proposal_meta.last_reconcile_check_block` — watermark updated on every reconcile check

2. Indexer is deployed with `CompoundReconcileService` and source reconciler plugins.
3. RPC provider can serve:

- `eth_getBlockByNumber` for old historical blocks (timestamp lookup)
- `eth_call state(uint256)` at confirmed-threshold block tags
- `eth_call timelock()`, `GRACE_PERIOD()`, `delay()` at confirmed-threshold block tags (for `expired` transitions)

## Configuration

| Env var                                        | Default     | Notes                                                                                                                |
| ---------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `COMPOUND_STATE_RECONCILE_BATCH_SIZE`          | `50`        | proposals processed per confirmed-head tick                                                                          |
| `COMPOUND_STATE_RECONCILE_RECHECK_GAP_SECONDS` | `7200` (2h) | minimum wall-clock time between rechecks of the same proposal; converted to blocks per chain using `blocksPerMinute` |
| `COMPOUND_STATE_RECONCILE_RPC_FAIL_ESCALATE`   | `5`         | consecutive RPC failures before escalation log                                                                       |
| `COMPOUND_GOVERNOR_GRACE_MIN_SECONDS`          | `3600`      | sanity floor for on-chain `GRACE_PERIOD()` reads                                                                     |
| `COMPOUND_GOVERNOR_GRACE_MAX_SECONDS`          | `7776000`   | sanity ceiling (~90 days)                                                                                            |

**Chain config** (`CHAIN_CONFIG` JSON): set `blocksPerMinute` per chain to ensure the gap converts correctly (default `5` = Ethereum mainnet ~12s/block; Optimism/Base ≈ `30`; Arbitrum ≈ `240`).

Tick cadence: driven by the head tracker — one reconcile attempt per confirmed head, gated by the `inFlight` guard to prevent overlap.

## Deployment checks

1. Boot indexer and confirm no startup errors from `CompoundReconcileService`.
2. Confirm source types are seeded:

```sql
SELECT value
FROM source_type
WHERE value IN ('compound_governor_bravo', 'compound_governor_alpha', 'compound_governor_oz');
```

Expected: both rows exist.

3. Confirm backlog visibility:

```sql
SELECT count(*)
FROM proposal p
JOIN dao d ON d.id = p.dao_id
WHERE p.source_type = 'compound_governor_bravo'
  AND p.state IN ('pending','active','succeeded','queued');
```

## First-run backlog drain expectations

- Rows without a `compound_proposal_meta` entry (or with `last_reconcile_check_block IS NULL`) are eligible immediately.
- Batch drains in `COMPOUND_STATE_RECONCILE_BATCH_SIZE` chunks per tick.
- The recheck gap prevents already-checked rows from re-entering the batch until the confirmed head has advanced by `ceil(recheckGapSeconds / 60 * blocksPerMinute)` blocks.

Check watermark progress:

```sql
SELECT
  count(*) FILTER (WHERE m.last_reconcile_check_block IS NULL) AS unchecked,
  count(*) FILTER (WHERE m.last_reconcile_check_block IS NOT NULL) AS checked
FROM proposal p
LEFT JOIN compound_proposal_meta m ON m.proposal_id = p.id
WHERE p.source_type = 'compound_governor_bravo'
  AND p.state IN ('pending','active','succeeded','queued');
```

## Acceptance verification

### 1) Known stale rows corrected by reconciler (no manual SQL)

```sql
SELECT source_id, state, state_updated_at
FROM proposal
WHERE source_type = 'compound_governor_bravo'
  AND source_id IN ('166','257');
```

Expected: no longer stale `pending`; values match on-chain lifecycle.

### 2) No lingering past-deadline rows beyond normal reconciliation window

```sql
SELECT count(*)
FROM proposal p
JOIN dao d ON d.id = p.dao_id
WHERE p.source_type = 'compound_governor_bravo'
  AND p.state IN ('pending','active','succeeded','queued')
  AND p.voting_ends_block IS NOT NULL
  AND p.voting_ends_block::bigint < 0; -- replace 0 with current confirmed threshold
```

Expected after steady-state: near-zero and decreasing.

### 3) Missed authoritative events are surfaced, not silently overwritten

Watch logs/metrics for `state_reconcile_missed_event` (on-chain `executed|queued|canceled` while local non-terminal).

## Troubleshooting

### Repeated `rpc_failed`

- Symptom: `state_reconcile_rpc_failed` with streak growth and escalations.
- Action:

1. Validate RPC health and quota.
2. Verify historical header availability (`eth_getBlockByNumber` for blocks near `voting_ends_block`).
3. Reduce `COMPOUND_STATE_RECONCILE_BATCH_SIZE` temporarily.

### `expired_no_queued_at_block`

- Means a `queued` proposal has no entry in `compound_proposal_meta.queued_at_block`.
- This happens for proposals queued before the indexer was deployed (no `ProposalQueued` event was processed).
- Reconciler intentionally skips write and logs outcome.
- Backfill/re-derivation of the `ProposalQueued` event is required before the `expired` timestamp can be authored.

### Grace period / delay out of range

- Symptom: `resolveTimelockParams` returns null; reconciler emits `expired_no_queued_at_block`.
- Cause: on-chain `GRACE_PERIOD()` or `delay()` falls outside `[COMPOUND_GOVERNOR_GRACE_MIN_SECONDS, COMPOUND_GOVERNOR_GRACE_MAX_SECONDS]`.
- Action: adjust the env var bounds to match the deployed timelock and restart the indexer.

## Optional manual SQL escape hatch

Manual correction SQL is emergency-only and must be recorded in incident notes. Normal path is reconciler + backfill/event re-derivation.

## Orphaned projection rows

A vote or lifecycle event whose parent proposal has not derived yet is held, not failed: a catch-up
can archive it before its creation. `ProposalCreated` precedes both in block order on one chain, so
a parent still missing after `COMPOUND_MISSING_PROPOSAL_HOLD_MAX_MS` (default two hours, measured
from `archive_event.received_at`) is an ingestion gap rather than ordering — which is long enough
for the archive audit above to restore it on one of its ticks.

Past the bound the row stops being held. A vote goes through the normal vote-projection failure
path and is quarantined in `ingestion_dlq` once `VOTE_PROJECTION_DLQ_THRESHOLD` attempts are spent;
inspect and retry it with the `dlq` commands. A lifecycle event has no projection DLQ, so it records
a `failed` outcome with a rising `derivation_attempt_count` and logs
`compound_lifecycle_parent_absent` with the event identity and how long it waited.

The bound exists because `markHeld` leaves `derivation_attempt_count` untouched: without it, a
permanently orphaned row retried every minute forever, reaching neither the DLQ nor any failure
count. Currently held rows are visible in PostgreSQL:

```sql
SELECT source_type, event_type, chain_id, tx_hash, log_index, received_at,
       derivation_hold_until, derivation_attempt_count
FROM archive_event
WHERE derivation_hold_until IS NOT NULL
  AND derived_at IS NULL
ORDER BY received_at
LIMIT 50;
```

A row whose `received_at` is older than the bound and that is still listed here means the derivation
worker is not reaching it — check the worker's lag and the projection DLQ before assuming the hold
is at fault.

Compound's appliers report outcomes into `derivation_processed`, the same counter the derivation
worker uses, labelled `source_type`, `event_type`, `outcome` and `reason`. "Held and failed
derivations" on the Platform Health dashboard charts the `held` and `failed` series. A sustained
`held` count is the signal to investigate; `failed` with `reason="no_proposal"` means rows have
passed the bound. Lido's appliers still pass no-op metrics, so this panel covers Compound and Aave
only.
