import type { Logger } from '@libs/chain';
import type { ProposalRepository } from '@libs/db';
import {
  ReconcileDriver,
  type ReconcileDriverConfig,
  type ReconcileDriverMetrics,
  type SourceIngester,
} from '@sources/core';
import { CompoundArchiveReconciler, type ArchiveRepairLabels } from './compound-archive-reconciler';
import { CompoundStateReconciler } from './compound-state-reconciler';
import type { GovernorArchiveWriter } from '../ingestion/archive-writer';
import type { CompoundArchiveReconcileRepository } from '../persistence/compound-archive-reconcile-repository';
import type { CompoundProposalRepository } from '../persistence/compound-proposal-repository';
import { SUPPORTED_CHAIN_IDS, DaoSourceConfigSchema } from '../plugin/plugin';

export interface CompoundReconcilePluginDeps {
  proposals: CompoundProposalRepository;
  proposalRepo: ProposalRepository;
  archiveRepository: CompoundArchiveReconcileRepository;
  archiveWriter: GovernorArchiveWriter;
  recordArchiveAuditLag?: (sourceType: string, blocks: number) => void;
  recordArchiveRepair?: (labels: ArchiveRepairLabels) => void;
  metrics: ReconcileDriverMetrics;
  logger: Logger;
}

function createReconcilePlugin(
  sourceType: string,
  targetSourceType: string,
  deps: CompoundReconcilePluginDeps,
): SourceIngester {
  const reconciler = new CompoundStateReconciler(
    deps.logger,
    [targetSourceType],
    deps.proposalRepo,
    deps.metrics,
  );
  const config: ReconcileDriverConfig = {
    batchSize: Number(process.env['COMPOUND_STATE_RECONCILE_BATCH_SIZE'] ?? 50),
    rpcFailEscalateAfter: Number(process.env['COMPOUND_STATE_RECONCILE_RPC_FAIL_ESCALATE'] ?? 5),
  };
  const driver = new ReconcileDriver(reconciler, deps.proposals, deps.metrics, deps.logger, config);
  const audit = new CompoundArchiveReconciler(
    {
      repository: deps.archiveRepository,
      writer: deps.archiveWriter,
      metrics: deps.metrics,
      logger: deps.logger,
      recordLag: deps.recordArchiveAuditLag,
      recordRepair: deps.recordArchiveRepair,
    },
    targetSourceType,
  );

  return {
    sourceType,
    supportedChainIds: SUPPORTED_CHAIN_IDS,
    parseConfig: (raw) => DaoSourceConfigSchema.parse(raw),
    buildIngestSpec: (ctx, rawCfg) => ({
      kind: 'evm-block-head-poller',
      listener: ({ chainCfg, headBlock, client }) => {
        const headLag = BigInt(chainCfg.headLag);
        if (headBlock < headLag) return;
        void audit.onConfirmedHead({
          reconcileSourceId: ctx.daoSourceId,
          governorAddress: (rawCfg as { governor_address: string }).governor_address,
          chainId: chainCfg.chainId,
          confirmedHead: headBlock - headLag,
          client,
        });
        const blocksPerMinute = chainCfg.blocksPerMinute ?? 5;
        const recheckGapSeconds = Number(
          process.env['COMPOUND_STATE_RECONCILE_RECHECK_GAP_SECONDS'] ?? 7_200,
        );
        const recheckGapBlocks = Math.ceil((recheckGapSeconds / 60) * blocksPerMinute);
        void driver.onConfirmedHeads([
          {
            chainId: chainCfg.chainId,
            confirmedThresholdBlock: (headBlock - headLag).toString(),
            recheckGapBlocks,
            client,
          },
        ]);
      },
    }),
  };
}

export function createCompoundGovernorBravoReconcilePlugin(
  deps: CompoundReconcilePluginDeps,
): SourceIngester {
  return createReconcilePlugin(
    'compound_governor_bravo_reconcile',
    'compound_governor_bravo',
    deps,
  );
}

export function createCompoundGovernorOzReconcilePlugin(
  deps: CompoundReconcilePluginDeps,
): SourceIngester {
  return createReconcilePlugin('compound_governor_oz_reconcile', 'compound_governor_oz', deps);
}

/**
 * GovernorAlpha is superseded (Bravo took over in 2021) and will never receive another proposal,
 * but four of its historical proposals ended in defeat — a state that emits no event, since it is
 * the *absence* of enough votes at endBlock. Without a reconciler nothing ever resolves them and
 * they sit in `pending` forever.
 *
 * Alpha needs no reconciler changes: it exposes the same `state(uint256)` with the same enum
 * ordering as Bravo, and computes defeat from stored vote counts against a constant `quorumVotes()`
 * — no external governance-strategy call, so it does not revert when read at the confirmed head.
 *
 * State-check RPCs stop when the backlog drains. The archive audit still verifies
 * the confirmed range, because its cursor is independent of proposal state.
 */
export function createCompoundGovernorAlphaReconcilePlugin(
  deps: CompoundReconcilePluginDeps,
): SourceIngester {
  return createReconcilePlugin(
    'compound_governor_alpha_reconcile',
    'compound_governor_alpha',
    deps,
  );
}
