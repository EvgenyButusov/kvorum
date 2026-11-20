import type { Kysely } from 'kysely';
import { isoSeconds, isoSecondsRequired, type PgDatabase } from '@libs/db';
import type { ProposalExtension } from '@libs/domain';
import type {
  AragonProposalMetadataView,
  DualGovernanceProposalMetadataView,
  EasyTrackProposalMetadataView,
} from './proposal-metadata-views';
import {
  buildEasyTrackMotionSummary,
  type EasyTrackMotionSummaryAction,
} from '../easy-track/domain/motion-summary';
import { easyTrackFactoryLabel } from '../easy-track/factories';
import '../persistence/schema';

// Reads the per-proposal metadata for the three Lido on-chain tracks and shapes it into the
// discriminated ProposalExtension.metadata. Aragon/DG/Easy Track carry no cross-chain
// payloads-controller `voting`/`payloads` surface (that is Aave-only), so those stay null/empty.
export class LidoProposalExtensionReadRepository {
  constructor(private readonly db: Kysely<PgDatabase>) {}

  async getExtension(proposalId: string, sourceType: string): Promise<ProposalExtension | null> {
    switch (sourceType) {
      case 'aragon_voting':
        return this.aragon(proposalId);
      case 'dual_governance':
        return this.dualGovernance(proposalId);
      case 'easy_track':
        return this.easyTrack(proposalId);
      default:
        return null;
    }
  }

  private async aragon(proposalId: string): Promise<ProposalExtension | null> {
    const row = await this.db
      .selectFrom('aragon_proposal_metadata')
      .selectAll()
      .where('proposal_id', '=', proposalId)
      .executeTakeFirst();
    if (row === undefined) return null;

    const metadata: AragonProposalMetadataView = {
      kind: 'aragon_voting',
      app_address: row.app_address,
      app_version: row.app_version,
      support_required_pct: row.support_required_pct,
      min_accept_quorum_pct: row.min_accept_quorum_pct,
      main_phase_ends_at: isoSeconds(row.main_phase_ends_at),
      objection_phase_ends_at: isoSeconds(row.objection_phase_ends_at),
      executed_at: isoSeconds(row.executed_at),
    };
    return { voting: null, payloads: [], metadata };
  }

  private async dualGovernance(proposalId: string): Promise<ProposalExtension | null> {
    const row = await this.db
      .selectFrom('dual_governance_proposal')
      .selectAll()
      .where('proposal_id', '=', proposalId)
      .executeTakeFirst();
    if (row === undefined) return null;

    const metadata: DualGovernanceProposalMetadataView = {
      kind: 'dual_governance',
      origin: row.origin,
      dg_proposal_id: row.dg_proposal_id,
      status: row.status,
      executor: row.executor,
      aragon_source_id: row.aragon_source_id,
      submitted_at: isoSecondsRequired(row.submitted_at),
      scheduled_at: isoSeconds(row.scheduled_at),
      executed_at: isoSeconds(row.executed_at),
      cancelled_at: isoSeconds(row.cancelled_at),
    };
    return { voting: null, payloads: [], metadata };
  }

  private async easyTrack(proposalId: string): Promise<ProposalExtension | null> {
    const row = await this.db
      .selectFrom('easy_track_motion_meta')
      .selectAll()
      .where('proposal_id', '=', proposalId)
      .executeTakeFirst();
    if (row === undefined) return null;

    const factoryLabel = easyTrackFactoryLabel(row.factory_address);
    const metadata: EasyTrackProposalMetadataView = {
      kind: 'easy_track',
      motion_id: row.motion_id,
      factory_address: row.factory_address,
      factory_label: factoryLabel,
      action_summary: buildEasyTrackMotionSummary({
        factoryAddress: row.factory_address,
        factoryLabel,
        actions: await this.motionActions(proposalId),
      }),
      objection_ends_at: isoSecondsRequired(row.objection_ends_at),
      state: row.state,
    };
    return { voting: null, payloads: [], metadata };
  }

  private async motionActions(proposalId: string): Promise<EasyTrackMotionSummaryAction[]> {
    return this.db
      .selectFrom('proposal_action')
      .select([
        'payload_index as payloadIndex',
        'action_index as actionIndex',
        'target_address as targetAddress',
        'target_chain_id as targetChainId',
        'value_wei as valueWei',
        'function_signature as functionSignature',
        'decoded_function as decodedFunction',
        'decoded_arguments as decodedArguments',
        'calldata',
      ])
      .where('proposal_id', '=', proposalId)
      .orderBy('payload_index')
      .orderBy('action_index')
      .execute();
  }
}
