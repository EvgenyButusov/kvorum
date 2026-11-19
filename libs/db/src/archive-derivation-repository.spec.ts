import { describe, expect, it, vi } from 'vitest';
import { ArchiveDerivationRepository } from './archive-derivation-repository';
import type { ArchiveDerivationRow } from './archive-derivation-repository';

const ARCHIVE_ROW: ArchiveDerivationRow = {
  id: 'row-1',
  source_type: 'compound_governor_bravo',
  dao_source_id: 'source-1',
  chain_id: '0x1',
  block_number: '100',
  block_hash: '0xblock',
  tx_hash: '0xtx',
  log_index: 1,
  event_type: 'ProposalCreated',
  received_at: new Date('2026-01-01T00:00:00Z'),
  derivation_attempt_count: 2,
};

function makeSelectChain(returnValue: unknown[]) {
  const execute = vi.fn().mockResolvedValue(returnValue);
  const executeTakeFirst = vi.fn().mockResolvedValue(returnValue[0]);
  const chain = {
    select: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    execute,
    executeTakeFirst,
  };
  chain.select.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  chain.orderBy.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  const selectFrom = vi.fn().mockReturnValue(chain);

  return { selectFrom, ...chain };
}

function makeUpdateChain() {
  const execute = vi.fn().mockResolvedValue(undefined);
  const where = vi.fn().mockReturnValue({ execute });
  const set = vi.fn().mockReturnValue({ where });
  const updateTable = vi.fn().mockReturnValue({ set });

  return { updateTable, set, where, execute };
}

describe('ArchiveDerivationRepository', () => {
  it('selects underived rows in deterministic order', async () => {
    const pgSelect = makeSelectChain([ARCHIVE_ROW]);
    const repo = new ArchiveDerivationRepository({ selectFrom: pgSelect.selectFrom } as never);

    await expect(repo.findUnderived(['ProposalCreated'], 50)).resolves.toEqual([ARCHIVE_ROW]);

    expect(pgSelect.selectFrom).toHaveBeenCalledWith('archive_event');
    // external_id IS NULL restricts to EVM rows (ADR-071) so coords are non-null.
    expect(pgSelect.where.mock.calls).toEqual([
      ['external_id', 'is', null],
      ['derived_at', 'is', null],
      ['event_type', 'in', ['ProposalCreated']],
    ]);
    expect(pgSelect.orderBy.mock.calls).toEqual([
      ['chain_id', 'asc'],
      ['block_number', 'asc'],
      ['log_index', 'asc'],
      ['id', 'asc'],
    ]);
    expect(pgSelect.limit).toHaveBeenCalledWith(50);
  });

  it('short-circuits underived lookup for empty event type list', async () => {
    const pgSelect = makeSelectChain([ARCHIVE_ROW]);
    const repo = new ArchiveDerivationRepository({ selectFrom: pgSelect.selectFrom } as never);

    await expect(repo.findUnderived([], 10)).resolves.toEqual([]);
    expect(pgSelect.selectFrom).not.toHaveBeenCalled();
  });

  it('marks a row derived', async () => {
    const update = makeUpdateChain();
    const repo = new ArchiveDerivationRepository({ updateTable: update.updateTable } as never);

    await repo.markDerived('row-1');

    expect(update.updateTable).toHaveBeenCalledWith('archive_event');
    expect(update.where).toHaveBeenCalledWith('id', '=', 'row-1');
  });

  it('checks whether an EVM archive tuple is already derived', async () => {
    const pgSelect = makeSelectChain([{ derived_at: new Date('2026-01-01T00:00:00Z') }]);
    const repo = new ArchiveDerivationRepository({ selectFrom: pgSelect.selectFrom } as never);

    await expect(
      repo.isDerivedByEvmTuple({
        sourceType: 'dual_governance',
        chainId: '0x1',
        txHash: '0xtx',
        logIndex: 1,
      }),
    ).resolves.toBe(true);

    expect(pgSelect.where.mock.calls).toEqual([
      ['source_type', '=', 'dual_governance'],
      ['chain_id', '=', '0x1'],
      ['tx_hash', '=', '0xtx'],
      ['log_index', '=', 1],
    ]);
  });

  it('reports an absent or pending EVM archive tuple as not derived', async () => {
    const pending = makeSelectChain([{ derived_at: null }]);
    const absent = makeSelectChain([]);

    await expect(
      new ArchiveDerivationRepository({
        selectFrom: pending.selectFrom,
      } as never).isDerivedByEvmTuple({
        sourceType: 'dual_governance',
        chainId: '0x1',
        txHash: '0xtx',
        logIndex: 1,
      }),
    ).resolves.toBe(false);
    await expect(
      new ArchiveDerivationRepository({
        selectFrom: absent.selectFrom,
      } as never).isDerivedByEvmTuple({
        sourceType: 'dual_governance',
        chainId: '0x1',
        txHash: '0xtx',
        logIndex: 1,
      }),
    ).resolves.toBe(false);
  });

  it('increments derivation attempt count', async () => {
    const update = makeUpdateChain();
    const repo = new ArchiveDerivationRepository({ updateTable: update.updateTable } as never);

    await repo.incrementAttemptCount('row-1');

    expect(update.updateTable).toHaveBeenCalledWith('archive_event');
    expect(update.where).toHaveBeenCalledWith('id', '=', 'row-1');
  });

  it('marks a row held until a re-check time, leaving it underived', async () => {
    const update = makeUpdateChain();
    const repo = new ArchiveDerivationRepository({ updateTable: update.updateTable } as never);
    const holdUntil = new Date('2026-01-01T00:01:00Z');

    await repo.markHeld('row-1', holdUntil);

    expect(update.updateTable).toHaveBeenCalledWith('archive_event');
    // Only the hold marker moves — a deferral must never mark the row derived (KNOWN-028).
    expect(update.set).toHaveBeenCalledWith({ derivation_hold_until: holdUntil });
    expect(update.where).toHaveBeenCalledWith('id', '=', 'row-1');
  });
});
