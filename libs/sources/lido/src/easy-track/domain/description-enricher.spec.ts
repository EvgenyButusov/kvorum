import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildEasyTrackDescription, type EasyTrackDescriptionAction } from './description';
import {
  EasyTrackDescriptionEnricher,
  refreshAllEasyTrackDescriptions,
} from './description-enricher';

const FACTORY = '0x' + '11'.repeat(20);
const TARGET = '0x' + '22'.repeat(20);

interface ProposalRow {
  id: string;
  factoryAddress: string;
  description: string;
  descriptionHash: string;
}

interface ActionRow extends EasyTrackDescriptionAction {
  proposalId: string;
}

function action(proposalId: string, actionIndex = 0): ActionRow {
  return {
    proposalId,
    actionIndex,
    targetAddress: TARGET,
    targetChainId: '0x1',
    valueWei: '0',
    functionSignature: null,
    decodedFunction: 'topUp(uint256,string)',
    decodedArguments: { amount: '1000', reference: 'Node operator top-up' },
    calldata: '0x12345678',
  };
}

function proposal(id: string, description = '', descriptionHash = ''): ProposalRow {
  return { id, factoryAddress: FACTORY, description, descriptionHash };
}

function makeDb(input: {
  singleProposal?: ProposalRow;
  proposals?: ProposalRow[];
  actions?: ActionRow[];
}) {
  const updates: Record<string, unknown>[] = [];
  const selectFrom = vi.fn((table: string) => {
    const builder = {
      innerJoin: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      executeTakeFirst: vi.fn().mockResolvedValue(input.singleProposal),
      execute: vi
        .fn()
        .mockResolvedValue(
          table === 'proposal as p' ? (input.proposals ?? []) : (input.actions ?? []),
        ),
    };
    return builder;
  });
  const updateBuilder = {
    set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
      updates.push(values);
      return updateBuilder;
    }),
    where: vi.fn().mockReturnThis(),
    execute: vi.fn().mockResolvedValue(undefined),
  };
  const db = { selectFrom, updateTable: vi.fn().mockReturnValue(updateBuilder) };
  return { db, selectFrom, updateBuilder, updates };
}

describe('EasyTrackDescriptionEnricher', () => {
  it('declares Easy Track support and ignores a missing proposal', async () => {
    const { db, selectFrom, updates } = makeDb({});
    const enricher = new EasyTrackDescriptionEnricher();

    await enricher.refreshProposal(db as never, 'missing');

    expect(enricher.sourceTypes).toEqual(['easy_track']);
    expect(selectFrom).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([]);
  });

  it('rebuilds an empty description from decoded proposal actions', async () => {
    const { db, updateBuilder, updates } = makeDb({
      singleProposal: proposal('p-1'),
      actions: [action('p-1')],
    });

    await new EasyTrackDescriptionEnricher().refreshProposal(db as never, 'p-1');

    expect(updateBuilder.where).toHaveBeenCalledWith('id', '=', 'p-1');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.['description']).toContain('topUp(uint256,string)');
    expect(updates[0]?.['description']).toContain('Node operator top-up');
    expect(updates[0]?.['description_hash']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not overwrite a human-authored description', async () => {
    const { db, updates } = makeDb({
      singleProposal: proposal('p-1', 'Human-authored motion summary', 'hash'),
      actions: [action('p-1')],
    });

    await new EasyTrackDescriptionEnricher().refreshProposal(db as never, 'p-1');

    expect(updates).toEqual([]);
  });

  it('skips an unchanged generated description but repairs a stale hash', async () => {
    const actions = [action('p-1')];
    const description = buildEasyTrackDescription({ factoryAddress: FACTORY, actions });
    const hash = createHash('sha256').update(description).digest('hex');
    const unchanged = makeDb({
      singleProposal: proposal('p-1', description, hash),
      actions,
    });
    await new EasyTrackDescriptionEnricher().refreshProposal(unchanged.db as never, 'p-1');
    expect(unchanged.updates).toEqual([]);

    const stale = makeDb({
      singleProposal: proposal('p-1', description, 'stale'),
      actions,
    });
    await new EasyTrackDescriptionEnricher().refreshProposal(stale.db as never, 'p-1');
    expect(stale.updates).toHaveLength(1);
    expect(stale.updates[0]?.['description_hash']).toBe(hash);
  });
});

describe('refreshAllEasyTrackDescriptions', () => {
  it('returns without querying actions when there are no existing proposals', async () => {
    const { db, selectFrom } = makeDb({ proposals: [] });

    await refreshAllEasyTrackDescriptions(db as never);

    expect(selectFrom).toHaveBeenCalledTimes(1);
  });

  it('groups ordered actions, handles action-less motions, and preserves human content', async () => {
    const { db, updates } = makeDb({
      proposals: [proposal('p-1'), proposal('p-2'), proposal('p-3', 'Human summary', 'hash')],
      actions: [action('p-1', 0), action('p-1', 1)],
    });

    await refreshAllEasyTrackDescriptions(db as never);

    expect(updates).toHaveLength(2);
    expect(updates[0]?.['description']).toContain('executes 2 on-chain actions');
    expect(updates[1]?.['description']).toContain('No executable calls could be decoded');
  });
});
