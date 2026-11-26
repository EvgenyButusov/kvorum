import { defineCounter } from '@libs/observability';

// Same name and description as the indexer's own derivation counter, so applier outcomes and the
// worker's land in one metric family instead of two near-identical ones. OTel merges identical
// instrument definitions; a divergent description here would split them.
const derivationProcessed = defineCounter({
  name: 'derivation_processed',
  description: 'Derivation row outcomes by source, event type, outcome, and failure reason',
});

/** Applier `processed` callback. `reason` is bounded by each applier's failure-reason union. */
export function recordDerivationOutcome(labels: {
  source_type: string;
  event_type: string;
  outcome: string;
  reason: string | null;
}): void {
  derivationProcessed.add(1, {
    source_type: labels.source_type,
    event_type: labels.event_type,
    outcome: labels.outcome,
    reason: labels.reason ?? 'none',
  });
}
