import { Module, Logger } from '@nestjs/common';
import { ChainContextRegistry } from '@libs/chain';
import {
  ArchiveEventRepository,
  ArchiveDerivationRepository,
  DlqRepository,
  ProposalRepository,
  VoteEventsProjectionReadRepository,
  VoteEventsProjectionWriter,
  chDb,
  pgDb,
} from '@libs/db';
import { defineCounter, defineGauge } from '@libs/observability';
import {
  COMPOUND_ACTOR_SWEEP_EXTRACTOR,
  CompTokenArchiveWriter,
  CompTokenArchivePayloadRepository,
  CompTokenEventRepository,
  CompTokenDelegationProjectionApplier,
  CompoundProposalRepository,
  CompoundArchiveReconcileRepository,
  GovernorArchivePayloadRepository,
  GovernorArchiveWriter,
  GovernorEventRepository,
  GovernorProjectionApplier,
  GovernorVoteProjectionApplier,
  createCompTokenPlugin,
  createCompoundGovernorAlphaReconcilePlugin,
  createCompoundGovernorBravoReconcilePlugin,
  createCompoundGovernorOzReconcilePlugin,
  createCompoundPlugins,
  compoundReadExtension,
} from '@sources/compound';
import type { SourcePlugin } from '@sources/core';
import { ChainContextModule } from '@nest/chain';
import { toChainLogger } from '@nest/chain';
import { DbModule } from '@nest/db';
import { createReconcileLogger } from './reconcile-logger';
import { buildDriverMetrics } from '../../reconcile-metrics';

export const COMPOUND_SOURCE_PLUGIN = 'COMPOUND_SOURCE_PLUGIN';
const archiveAuditLag = defineGauge({
  name: 'compound_archive_audit_lag_blocks',
  description: 'Blocks remaining behind the safe Compound archive reconciliation target',
});
const archiveEventsRepaired = defineCounter({
  name: 'compound_archive_audit_events_repaired',
  description: 'Individual missing Compound events restored and verified in both archives',
});

@Module({
  imports: [
    ChainContextModule,
    DbModule.forFeature([
      ArchiveDerivationRepository,
      ArchiveEventRepository,
      DlqRepository,
      ProposalRepository,
      VoteEventsProjectionReadRepository,
      VoteEventsProjectionWriter,
    ]),
  ],
  providers: [
    {
      provide: GovernorArchiveWriter,
      useFactory: (archiveEventRepo: ArchiveEventRepository, dlqRepo: DlqRepository) => {
        const eventRepo = new GovernorEventRepository({ chDb });
        return new GovernorArchiveWriter({
          eventRepo,
          archiveEventRepo,
          dlqRepo,
          logger: toChainLogger(new Logger('GovernorArchiveWriter')),
        });
      },
      inject: [ArchiveEventRepository, DlqRepository],
    },
    {
      provide: CompoundProposalRepository,
      useFactory: () => new CompoundProposalRepository(pgDb),
    },
    {
      provide: CompTokenEventRepository,
      useFactory: () => new CompTokenEventRepository({ chDb }),
    },
    {
      provide: CompTokenArchiveWriter,
      useFactory: (
        eventRepo: CompTokenEventRepository,
        archiveEventRepo: ArchiveEventRepository,
        dlqRepo: DlqRepository,
      ) =>
        new CompTokenArchiveWriter({
          eventRepo,
          archiveEventRepo,
          dlqRepo,
          logger: toChainLogger(new Logger('CompTokenArchiveWriter')),
        }),
      inject: [CompTokenEventRepository, ArchiveEventRepository, DlqRepository],
    },
    {
      provide: GovernorProjectionApplier,
      useFactory: (archive: ArchiveDerivationRepository, registry: ChainContextRegistry) =>
        new GovernorProjectionApplier({
          pgDb,
          chDb,
          archive,
          payloads: new GovernorArchivePayloadRepository(chDb),
          registry,
          metrics: {
            batchLookupSeconds: () => undefined,
            processed: () => undefined,
          },
          logger: toChainLogger(new Logger('GovernorProjectionApplier')),
        }),
      inject: [ArchiveDerivationRepository, ChainContextRegistry],
    },
    {
      provide: GovernorVoteProjectionApplier,
      useFactory: (
        archive: ArchiveDerivationRepository,
        dlq: DlqRepository,
        proposals: ProposalRepository,
        voteRead: VoteEventsProjectionReadRepository,
        voteWrite: VoteEventsProjectionWriter,
        registry: ChainContextRegistry,
      ) =>
        new GovernorVoteProjectionApplier({
          archive,
          dlq,
          payloads: new GovernorArchivePayloadRepository(chDb),
          proposals,
          voteRead,
          voteWrite,
          registry,
          metrics: {
            batchLookupSeconds: () => undefined,
            chWriteSeconds: () => undefined,
            processed: () => undefined,
          },
          logger: toChainLogger(new Logger('GovernorVoteProjectionApplier')),
        }),
      inject: [
        ArchiveDerivationRepository,
        DlqRepository,
        ProposalRepository,
        VoteEventsProjectionReadRepository,
        VoteEventsProjectionWriter,
        ChainContextRegistry,
      ],
    },
    {
      provide: CompTokenDelegationProjectionApplier,
      useFactory: (archive: ArchiveDerivationRepository, dlq: DlqRepository) =>
        new CompTokenDelegationProjectionApplier({
          pgDb,
          chDb,
          archive,
          dlq,
          payloads: new CompTokenArchivePayloadRepository(chDb),
          metrics: {
            batchLookupSeconds: () => undefined,
            chWriteSeconds: () => undefined,
            processed: () => undefined,
          },
          logger: toChainLogger(new Logger('CompTokenDelegationProjectionApplier')),
        }),
      inject: [ArchiveDerivationRepository, DlqRepository],
    },
    {
      provide: COMPOUND_SOURCE_PLUGIN,
      useFactory: (
        archiveWriter: GovernorArchiveWriter,
        dlqRepo: DlqRepository,
        proposalRepo: CompoundProposalRepository,
        compTokenArchiveWriter: CompTokenArchiveWriter,
        projectionApplier: GovernorProjectionApplier,
        voteProjectionApplier: GovernorVoteProjectionApplier,
        delegationProjectionApplier: CompTokenDelegationProjectionApplier,
        sharedProposalRepo: ProposalRepository,
      ): SourcePlugin => {
        const governorPayloads = new GovernorArchivePayloadRepository(chDb);
        const compTokenPayloads = new CompTokenArchivePayloadRepository(chDb);
        const reconcileLogger = createReconcileLogger();
        const metrics = buildDriverMetrics();
        const archiveRepository = new CompoundArchiveReconcileRepository(pgDb, chDb);
        const recordArchiveAuditLag = (sourceType: string, blocks: number) =>
          archiveAuditLag.record(blocks, { source_type: sourceType });
        const recordArchiveRepair: NonNullable<
          Parameters<typeof createCompoundGovernorOzReconcilePlugin>[0]['recordArchiveRepair']
        > = (labels) => archiveEventsRepaired.add(1, { ...labels });
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
              archiveEventsRepaired.add(0, { source_type, event_type, missing_store });
            }
          }
        }
        const logger = new Logger('CompoundSourceModule');
        logger.log('compound_comp_token plugin registered');

        return {
          name: 'compound',
          ingesters: [
            ...createCompoundPlugins({
              archiveWriter,
              dlqRepo,
              logger: toChainLogger(new Logger('CompoundGovernor')),
            }),
            createCompTokenPlugin({
              archiveWriter: compTokenArchiveWriter,
              dlqRepo,
              logger: toChainLogger(new Logger('CompTokenIngester')),
            }),
            createCompoundGovernorBravoReconcilePlugin({
              archiveRepository,
              archiveWriter,
              recordArchiveAuditLag,
              recordArchiveRepair,
              proposals: proposalRepo,
              proposalRepo: sharedProposalRepo,
              metrics,
              logger: reconcileLogger,
            }),
            createCompoundGovernorOzReconcilePlugin({
              archiveRepository,
              archiveWriter,
              recordArchiveAuditLag,
              recordArchiveRepair,
              proposals: proposalRepo,
              proposalRepo: sharedProposalRepo,
              metrics,
              logger: reconcileLogger,
            }),
            createCompoundGovernorAlphaReconcilePlugin({
              archiveRepository,
              archiveWriter,
              recordArchiveAuditLag,
              recordArchiveRepair,
              proposals: proposalRepo,
              proposalRepo: sharedProposalRepo,
              metrics,
              logger: reconcileLogger,
            }),
          ],
          derivers: [
            projectionApplier,
            voteProjectionApplier,
            delegationProjectionApplier,
            {
              kind: 'actor-address',
              sourceTypes: COMPOUND_ACTOR_SWEEP_EXTRACTOR.sourceTypes,
              eventTypes: COMPOUND_ACTOR_SWEEP_EXTRACTOR.eventTypes,
              fetchPayloads: async (rows) => {
                if (rows.length === 0) return [];
                const sourceType = rows[0]!.source_type;
                if (
                  sourceType === 'compound_governor_alpha' ||
                  sourceType === 'compound_governor_bravo' ||
                  sourceType === 'compound_governor_oz'
                ) {
                  return governorPayloads.fetchPayloads(rows);
                }
                if (sourceType === 'compound_comp_token') {
                  return compTokenPayloads.fetchPayloads(rows);
                }
                throw new Error(`unsupported source_type for actor sweep: ${sourceType}`);
              },
              extractAddresses: COMPOUND_ACTOR_SWEEP_EXTRACTOR.extractAddresses,
            },
          ],
          readExtension: compoundReadExtension,
        };
      },
      inject: [
        GovernorArchiveWriter,
        DlqRepository,
        CompoundProposalRepository,
        CompTokenArchiveWriter,
        GovernorProjectionApplier,
        GovernorVoteProjectionApplier,
        CompTokenDelegationProjectionApplier,
        ProposalRepository,
      ],
    },
  ],
  exports: [COMPOUND_SOURCE_PLUGIN],
})
export class CompoundSourceModule {}
