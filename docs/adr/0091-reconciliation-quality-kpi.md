# ADR-0091 — Reconciliation quality KPI and the instrumentation contract every reconciler owes it

- **Status**: Accepted
- **Date**: 2026-11-26
- **Spec sections affected**: 3.10, 3.12
- **Related**: [ADR-0049](0049-onchain-state-reconciliation.md) (the first reconciler), [ADR-041](0041-cross-db-integrity-contract.md) and [ADR-0058](0058-confirmed-head-only-ingestion.md) (the write protocol the archive audit checks), [ADR-0076](0076-lido-easy-track-optimistic-motion-modeling.md) (optimistic-pass reconciliation), [ADR-045](0045-drop-metric-name-prefix.md) (metric naming); `docs/runbooks/state-reconciliation.md`

## Context

Kvorum now runs eight reconcilers across four source families: Compound's state reconciler and archive-completeness audit, Aave's governance-v3, governor-v2 and payloads-controller state reconcilers, and Lido's Aragon voting, Dual Governance and Easy Track reconcilers. They share a driver (`libs/sources/core/src/reconcile/reconcile-driver.ts`) and a metric set (`nest/sources/reconcile-metrics.ts`).

A reconciler is load-bearing in a way that makes it easy to misread. It repairs data, so a working reconciler and a broken ingester look alike from the outside: both end with correct rows in the database. Without a number that separates them, an ingestion defect can run for months behind a reconciler that quietly papers over it every tick, and the papering-over reads as health.

Three failure modes follow from that, and all three have precedent in this repository:

1. **A repair that nobody counts.** Before this ADR's contract was applied, Compound's projection appliers passed `processed: () => undefined`. A row deferred by `markHeld` emitted no metric and no log, so the `held` outcome was invisible — which is also what made an unbounded hold survive review.
2. **A count that measures the wrong thing.** Counting batches, passes or ticks instead of repaired logical records produces a number that moves with the schedule rather than with data quality. One tick that repairs 400 rows and one that repairs none are indistinguishable.
3. **Zero that means nothing.** A stalled loop, a disabled plugin and a genuinely clean system all report zero repairs. Zero is only evidence when read next to progress and failure signals.

The policy that answers these has lived in `CLAUDE.md` since the Compound reconciler shipped. That is the wrong home: it is an architectural constraint on every future source, not a working convention, and `CLAUDE.md` is neither indexed nor versioned as a decision record.

## Decision

**The north star for data-integrity reconciliation is zero unexpected data repairs in steady state.** Reconciliation is a safety net, not a substitute for correct ingestion and projection. A nonzero rolling 24-hour repair count, after historical catch-up, is an ingestion or projection defect until proven otherwise, and warrants root-cause investigation and a preventive fix — not a tuning change to the reconciler.

Every reconciler added or modified owes the KPI four things.

### 1. Counts of repaired logical records, not batches

The unit is the repaired record: one `archive_audit_events_repaired` increment per restored event, one `state_reconcile` increment per classified proposal. Batch-level and tick-level signals (`state_reconcile_batch_saturated`, `state_reconcile_tick_duration_seconds`) are operational telemetry and do not substitute.

### 2. Bounded labels, and nothing identifying

Classification is by source type, event type and repair reason. **Record identifiers, addresses and transaction hashes are never metric labels** — they are unbounded in cardinality and, for addresses, trace back to real participants. Per-record identity belongs in the structured log, which is where triage reads it.

### 3. Structured per-record logs carrying stable identity, changed values and outcome

A count tells the operator that something was repaired; the log is what makes it diagnosable. Identity must be stable across restarts (for archive events, the `(source_type, chain_id, tx_hash, log_index)` 4-tuple). No secrets, no arbitrary unbounded payloads.

### 4. Repairs recorded when verified, independently of the enclosing batch

A repair confirmed in both stores is counted then, not after the checkpoint advances. A later checkpoint or batch failure must not erase evidence of work already done, and must leave the failed attempts visible and retryable. This is why `archive_audit_events_repaired` increments per verified event rather than once per advanced cursor.

### Expected protocol behavior stays separately observable

Event-silent state transitions (ADR-0049), legitimate deadline extensions, optimistic-motion passes (ADR-0076) and enrichment are not ingestion defects. They are counted under their own outcomes and **must not be disabled, folded into a general repair counter, or otherwise suppressed to improve the KPI.** Degrading observability to make a number look better is the one failure this ADR exists to prevent.

### Zero is only read alongside liveness

A stalled or disabled reconciliation loop is not healthy zero. Progress and failure signals — `archive_audit_lag_blocks`, `state_reconcile` failure outcomes, `state_reconcile_rpc_fail_escalated`, `derivation_processed` with `outcome=~"held|failed"` — are read together with the repair count. Historical catch-up, including an operator-initiated `derive audit-rewind`, is expected to produce repairs and a lag spike; the KPI only means anything once lag has drained.

## Alternatives considered

- **Leave the policy in `CLAUDE.md`.** Rejected. It constrains the design of every future source, so it belongs where the ADR index surfaces it and where a change to it is a reviewable decision. A one-line pointer stays in `CLAUDE.md`.
- **Target a nonzero repair budget, or alert only on a rate increase.** Rejected. A budget normalizes the defect it is supposed to surface: any steady-state repair means ingestion wrote something wrong, and a threshold invites tuning the threshold. The cost of zero as the target is that historical catch-up has to be explained each time rather than absorbed.
- **Enforce the instrumentation contract with a lint rule or a shared base class.** Not adopted. `libs/sources/*` is framework-agnostic by design and the reconcilers differ in what a "record" is; the contract is enforced in review, as the module boundaries are. Worth revisiting if a fifth source family lands with the same gaps.
- **Measure repairs from the database instead (diff the projection against chain state on a schedule).** Rejected as the primary signal. It is a second reconciler with the same blind spots, costs RPC, and reports a snapshot rather than attributing a repair to the ingestion path that caused it. It remains the right tool for a one-off audit.
- **Count repairs only at batch granularity, which every reconciler already did.** Rejected per §1: the number tracks the schedule, not the data.

## Consequences

### Positive

- One number per source family answers "is ingestion actually correct?", separately from "is the data currently correct?".
- The contract is a review checklist for new sources, with a stated reason behind each clause, so it survives contact with a reviewer who did not write the original reconciler.
- Metric cardinality stays bounded by construction, and participant addresses stay out of the metrics backend.

### Negative / risks

- **The KPI is only as good as its coverage.** Lido's projection appliers still pass no-op metrics, so the held-and-failed signal covers Compound and Aave only. A zero read across all sources today is partly an absence of instrumentation, not an absence of repairs.
- **Historical catch-up breaks the signal for as long as it runs**, and `derive audit-rewind` is an operator action that deliberately triggers it. The runbook carries that caveat; nothing enforces it.
- Chasing zero can tempt the opposite failure — narrowing what counts as a repair until the number is clean. The "separately observable" clause above is the guard, and it is a review-time guard only.

### Neutral

- No code changes follow from this ADR; it records the contract the Compound reconciler and archive audit already implement and that `docs/runbooks/state-reconciliation.md` operationalizes.
- Expected-behavior outcomes keep their existing metric names, so no dashboard or alert is affected.
