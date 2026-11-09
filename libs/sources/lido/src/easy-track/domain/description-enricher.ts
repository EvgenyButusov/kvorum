import { createHash } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { PgDatabase } from '@libs/db';
import type { ProposalActionEnricher } from '@sources/core';
import {
  EASY_TRACK_GENERATED_DESCRIPTION_PREFIX,
  buildEasyTrackDescription,
  type EasyTrackDescriptionAction,
} from './description';

interface EasyTrackDescriptionProposal {
  id: string;
  factoryAddress: string;
  description: string;
  descriptionHash: string;
}

/** Refreshes generated Easy Track descriptions after the generic ABI decoder enriches an action. */
export class EasyTrackDescriptionEnricher implements ProposalActionEnricher {
  readonly sourceTypes = ['easy_track'] as const;

  async refreshProposal(trx: Transaction<PgDatabase>, proposalId: string): Promise<void> {
    const proposal = await trx
      .selectFrom('proposal as p')
      .innerJoin('easy_track_motion_meta as m', 'm.proposal_id', 'p.id')
      .select([
        'p.id',
        'p.description',
        'p.description_hash as descriptionHash',
        'm.factory_address as factoryAddress',
      ])
      .where('p.id', '=', proposalId)
      .where('p.source_type', '=', 'easy_track')
      .executeTakeFirst();
    if (proposal === undefined) return;

    const actions = await selectDescriptionActions(trx, [proposalId]);
    await updateDescription(trx, proposal, actions);
  }
}

/** Data-migration entry point for repairing descriptions derived before this formatter existed. */
export async function refreshAllEasyTrackDescriptions(db: Kysely<PgDatabase>): Promise<void> {
  const proposals = await db
    .selectFrom('proposal as p')
    .innerJoin('easy_track_motion_meta as m', 'm.proposal_id', 'p.id')
    .select([
      'p.id',
      'p.description',
      'p.description_hash as descriptionHash',
      'm.factory_address as factoryAddress',
    ])
    .where('p.source_type', '=', 'easy_track')
    .execute();
  if (proposals.length === 0) return;

  const actions = await selectDescriptionActions(
    db,
    proposals.map((proposal) => proposal.id),
  );
  const byProposal = new Map<string, EasyTrackDescriptionAction[]>();
  for (const action of actions) {
    const group = byProposal.get(action.proposalId) ?? [];
    group.push(action);
    byProposal.set(action.proposalId, group);
  }

  for (const proposal of proposals) {
    await updateDescription(db, proposal, byProposal.get(proposal.id) ?? []);
  }
}

async function selectDescriptionActions(
  db: Kysely<PgDatabase> | Transaction<PgDatabase>,
  proposalIds: readonly string[],
): Promise<(EasyTrackDescriptionAction & { proposalId: string })[]> {
  const rows = await db
    .selectFrom('proposal_action')
    .select([
      'proposal_id as proposalId',
      'action_index as actionIndex',
      'target_address as targetAddress',
      'target_chain_id as targetChainId',
      'value_wei as valueWei',
      'function_signature as functionSignature',
      'decoded_function as decodedFunction',
      'decoded_arguments as decodedArguments',
      'calldata',
    ])
    .where('proposal_id', 'in', proposalIds)
    .orderBy('proposal_id')
    .orderBy('payload_index')
    .orderBy('action_index')
    .execute();
  return rows;
}

async function updateDescription(
  db: Kysely<PgDatabase> | Transaction<PgDatabase>,
  proposal: EasyTrackDescriptionProposal,
  actions: readonly EasyTrackDescriptionAction[],
): Promise<void> {
  if (
    proposal.description !== '' &&
    !proposal.description.startsWith(EASY_TRACK_GENERATED_DESCRIPTION_PREFIX)
  ) {
    return;
  }
  const description = buildEasyTrackDescription({
    factoryAddress: proposal.factoryAddress,
    actions,
  });
  const descriptionHash = createHash('sha256').update(description).digest('hex');
  if (proposal.description === description && proposal.descriptionHash === descriptionHash) return;

  await db
    .updateTable('proposal')
    .set({
      description,
      description_hash: descriptionHash,
      updated_at: sql<Date>`now()`,
    })
    .where('id', '=', proposal.id)
    .execute();
}
