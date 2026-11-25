import { defineCounter, defineGauge } from '@libs/observability';
import type { CompoundReconcilePluginDeps } from '@sources/compound';

export const compoundMetrics = {
  archiveAuditLag: defineGauge({
    name: 'compound_archive_audit_lag_blocks',
    description: 'Blocks remaining behind the safe Compound archive reconciliation target',
  }),
  archiveEventsRepaired: defineCounter({
    name: 'compound_archive_audit_events_repaired',
    description: 'Individual missing Compound events restored and verified in both archives',
  }),
} as const;

export function buildArchiveAuditMetrics(): Required<
  Pick<CompoundReconcilePluginDeps, 'recordArchiveAuditLag' | 'recordArchiveRepair'>
> {
  // Export zero-valued series before the first repair so Prometheus can
  // measure the first increment and distinguish healthy zero from no data.
  for (const source_type of [
    'compound_governor_alpha',
    'compound_governor_bravo',
    'compound_governor_oz',
  ]) {
    for (const event_type of [
      'ProposalCreated',
      'ProposalQueued',
      'ProposalExecuted',
      'ProposalCanceled',
      'VoteCast',
    ]) {
      for (const missing_store of ['postgres', 'clickhouse', 'both']) {
        compoundMetrics.archiveEventsRepaired.add(0, { source_type, event_type, missing_store });
      }
    }
  }
  return {
    recordArchiveAuditLag: (sourceType, blocks) =>
      compoundMetrics.archiveAuditLag.record(blocks, { source_type: sourceType }),
    recordArchiveRepair: (labels) => compoundMetrics.archiveEventsRepaired.add(1, { ...labels }),
  };
}
