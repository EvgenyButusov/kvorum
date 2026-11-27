# Parked derivation rows

An archive row stops being derivable once `derivation_attempt_count` reaches the
projection ceiling (`DEFAULT_MAX_DERIVATION_ATTEMPTS`, 50; override with
`DERIVATION_MAX_ATTEMPTS`). The ceiling exists so a row whose failure never clears
stops being reselected every tick. The cost is that a row whose failure _does_
later clear does not generally return on its own, and the proposal it would have
advanced keeps a stale state the reconciler is not allowed to correct. The one
automatic path back is an Aave proposal insert, which unparks its own
`dao_source` — see below.

This runbook covers returning those rows to the queue.

## Recognise it

```bash
kubectl --context kvorum-prod -n kvorum exec deploy/kvorum-indexer -- \
  node -e "fetch('http://localhost:9091/metrics').then(r=>r.text()).then(t=>console.log(t.split('\n').filter(l=>/parked|underived/.test(l)).join('\n')))"
```

`indexer_derivation_parked_rows` is the count past the ceiling, per source type.
`indexer_ingestion_underived_depth` is every un-derived row, parked or not, so a
parked count below the underived depth is normal — held rows and rows still under
the ceiling make up the difference. Neither gauge subtracts DLQ-quarantined rows:
a quarantined row past the ceiling appears in both, which is why the split below
matters before you act on a parked count.

The symptom that usually surfaces first is a proposal stuck in a non-terminal
state past its deadline, with the reconciler logging `state_reconcile_missed_event`
every tick. Per ADR-0049 the reconciler will not overwrite an event-driven state,
so it reports the divergence and leaves it — the repair belongs here, not there.

## Confirm the cause before unparking

```sql
select source_type, event_type, count(*), max(derivation_attempt_count) as attempts,
       min(received_at) as oldest
from archive_event
where derived_at is null and derivation_attempt_count >= 50
group by 1, 2 order by 3 desc;
```

Then establish that the original failure has cleared, because unparking a row
whose cause is still live only spends the ceiling again. The usual causes:

| cause                  | check                                                                                               | cleared when               |
| ---------------------- | --------------------------------------------------------------------------------------------------- | -------------------------- |
| parent proposal absent | `select 1 from proposal where source_type = … and source_id = …`                                    | the row exists             |
| archive payload absent | `select count(*) from kvorum.archive_event_<source> final where block_number = … and log_index = …` | ClickHouse returns the row |
| undecodable payload    | the `reason` on the last `*_derivation_failed` log line                                             | never — leave parked       |

For an absent parent the Aave sources handle both halves themselves, so check
before reaching for the command:

- Within `AAVE_MISSING_PROPOSAL_HOLD_MAX_MS` (2h of the row's `received_at`) the
  event is held rather than failed, so it never spends attempts on mere ordering.
- Past that bound it escalates and walks to the ceiling as before — but when the
  parent's `ProposalCreated` is finally derived, that insert unparks every
  past-ceiling un-derived row of its `dao_source`. Each restored row is counted on
  `aave_derivation_unparked` and logged with its archive tuple as
  `aave_derivation_unparked_on_create` (`aave_v2_…` for governor-v2).

So a manual unpark is for rows whose parent arrived before this behaviour
existed, for sources without it, or when the cause was never the parent at all.
Since the park reason is not stored, that automatic reset also catches rows
parked for an unrelated cause; those simply fail and re-park, which is why the
table above still matters.

## Unpark

Dry-run first; it prints the per-source-type breakdown without writing:

```bash
admin-cli derive unpark --source aave_governance_v3 --dry-run
```

```bash
admin-cli derive unpark --source aave_governance_v3 --confirm --production
```

Scope with `--source` unless every parked row has been accounted for. The command
resets `derivation_attempt_count` only, and filters on `derived_at IS NULL`, so it
cannot un-derive an already-applied row. Re-running it is a no-op once the rows
have derived.

Do **not** use `derive replay` for this. It is scoped to a whole `dao_source` and
also clears `derived_at`, so it re-derives that source's entire history to recover
a handful of rows.

## Rows it will not move

A row also quarantined in a projection DLQ stays quarantined: the derivable query
excludes it on the DLQ predicate independently of the attempt count. Split the
parked set before unparking, so the result is not mistaken for a failed recovery:

```sql
select a.source_type, count(*) as parked,
       count(*) filter (where d.id is not null) as also_in_projection_dlq
from archive_event a
left join ingestion_dlq d
  on  d.archive_source_type = a.source_type
 and d.archive_chain_id    = a.chain_id
 and d.archive_tx_hash     = a.tx_hash
 and d.archive_log_index   = a.log_index
 and d.archive_block_hash  = a.block_hash
 and d.stage like '%projection_stage'
where a.derived_at is null and a.derivation_attempt_count >= 50
group by 1 order by 1;
```

Clear the quarantined ones with `dlq list --stage <stage>` and `dlq retry` /
`dlq retry-batch` instead — and note that a stage with no registered retry
adapter cannot be re-driven from the CLI at all.

## Verify

Derivation is performed by the running indexer, not by the command. After the next
tick:

```sql
select count(*) from archive_event
where derived_at is null and derivation_attempt_count >= 50;
```

Then confirm the state the rows were meant to advance, for example:

```sql
select source_id, state, state_updated_at from proposal
where source_type = 'aave_governance_v3' and state in ('pending', 'active', 'queued');
```

For Aave lifecycle transitions `state_updated_at` is taken from the archive row's
`received_at`, so a recovered event dates the transition to when it was
originally ingested rather than to the unpark. Other sources derive that instant
differently — check the applier before relying on it.
