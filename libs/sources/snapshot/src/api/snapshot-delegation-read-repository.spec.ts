import { describe, expect, it, vi } from 'vitest';
import {
  SnapshotDelegationReadRepository,
  resolveActorCurrentDelegations,
  resolveCurrentRelationshipsForSpace,
} from './snapshot-delegation-read-repository';
import type { SnapshotDelegation } from '../persistence/schema';

function row(over: Partial<SnapshotDelegation>): SnapshotDelegation {
  return {
    id: 'x',
    dao_id: 'dao-1',
    delegator_address: '0xaa',
    delegate_address: '0xbb',
    space_id: 'lido-snapshot.eth',
    network: '0x1',
    delegation_system: 'delegate_registry',
    weight: null,
    expires_at: null,
    event_type: 'set',
    block_number: '100',
    log_index: 0,
    tx_hash: '0xhash',
    created_at: new Date('2026-01-01'),
    ...over,
  };
}

const NOW = new Date('2026-06-01T00:00:00Z');

function mockDb(args: { sourceConfig?: unknown; rows?: SnapshotDelegation[] }) {
  const selectFrom = vi.fn((table: string) => {
    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    builder['select'] = vi.fn(() => builder);
    builder['selectAll'] = vi.fn(() => builder);
    builder['where'] = vi.fn((...whereArgs: unknown[]) => {
      const callback = whereArgs[0];
      if (typeof callback === 'function') {
        const eb = Object.assign(
          vi.fn(() => ({})),
          {
            and: vi.fn(() => ({})),
            or: vi.fn(() => ({})),
          },
        );
        callback(eb);
      }
      return builder;
    });
    builder['executeTakeFirst'] = vi
      .fn()
      .mockResolvedValue(
        table === 'dao_source' && args.sourceConfig !== undefined
          ? { source_config: args.sourceConfig }
          : undefined,
      );
    builder['execute'] = vi
      .fn()
      .mockResolvedValue(table === 'snapshot_delegation' ? (args.rows ?? []) : []);
    return builder;
  });
  return { db: { selectFrom } as never, selectFrom };
}

describe('SnapshotDelegationReadRepository', () => {
  it('returns immediately when an actor has no addresses', async () => {
    const { db, selectFrom } = mockDb({});
    const repo = new SnapshotDelegationReadRepository(db, () => NOW);

    await expect(repo.findCurrentForActor('dao-1', [])).resolves.toEqual([]);
    expect(selectFrom).not.toHaveBeenCalled();
  });

  it('loads and resolves an actor current delegations using normalized addresses', async () => {
    const { db } = mockDb({ rows: [row({ delegator_address: '0xaa' })] });
    const repo = new SnapshotDelegationReadRepository(db, () => NOW);

    const result = await repo.findCurrentForActor('dao-1', ['0xAA']);

    expect(result).toHaveLength(1);
    expect(result[0]?.delegate_address).toBe('0xbb');
  });

  it.each([undefined, {}, { space: '' }])(
    'returns no relationship edges for a missing or invalid Snapshot space: %j',
    async (sourceConfig) => {
      const { db } = mockDb({ sourceConfig });
      const repo = new SnapshotDelegationReadRepository(db, () => NOW);

      await expect(repo.findCurrentRelationships('dao-1')).resolves.toEqual([]);
    },
  );

  it('resolves current delegate addresses to actors and drops unresolved delegates', async () => {
    const { db } = mockDb({
      sourceConfig: { space: 'lido-snapshot.eth' },
      rows: [
        row({ delegator_address: '0xaa', delegate_address: '0xresolved' }),
        row({ delegator_address: '0xbb', delegate_address: '0xmissing' }),
      ],
    });
    const repo = new SnapshotDelegationReadRepository(db, () => NOW);
    Object.assign(repo, {
      identity: {
        findCurrentActorIdsByAddresses: vi.fn().mockResolvedValue(
          new Map([
            ['0xresolved', 'actor-1'],
            ['0xmissing', null],
          ]),
        ),
      },
    });

    await expect(repo.findCurrentRelationships('dao-1')).resolves.toEqual([
      { delegator_address: '0xaa', delegate_actor_id: 'actor-1' },
    ]);
  });
});

describe('resolveActorCurrentDelegations', () => {
  it('returns the latest SET per (space, system) for delegate_registry', () => {
    const out = resolveActorCurrentDelegations(
      [
        row({ delegate_address: '0xold', block_number: '100' }),
        row({ delegate_address: '0xnew', block_number: '200' }),
      ],
      NOW,
    );
    expect(out).toEqual([
      {
        platform: 'snapshot',
        system: 'delegate_registry',
        scope: 'lido-snapshot.eth',
        network: '0x1',
        delegate_address: '0xnew',
        weight: null,
        expires_at: null,
      },
    ]);
  });

  it('drops a group whose latest event is a CLEAR', () => {
    const out = resolveActorCurrentDelegations(
      [
        row({ delegate_address: '0xbb', block_number: '100', event_type: 'set' }),
        row({ delegate_address: '0x0', block_number: '200', event_type: 'clear' }),
      ],
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('keeps space-specific and global delegate_registry as separate entries', () => {
    const out = resolveActorCurrentDelegations(
      [
        row({ space_id: 'lido-snapshot.eth', delegate_address: '0xspace' }),
        row({ space_id: null, delegate_address: '0xglobal', block_number: '90' }),
      ],
      NOW,
    );
    expect(out.map((d) => [d.scope, d.delegate_address])).toEqual(
      expect.arrayContaining([
        ['lido-snapshot.eth', '0xspace'],
        [null, '0xglobal'],
      ]),
    );
  });

  it('excludes expired split delegations and surfaces weights', () => {
    const out = resolveActorCurrentDelegations(
      [
        // A split event emits its whole delegate set in one log, so they share (block, log_index).
        row({
          delegation_system: 'split_delegation',
          delegate_address: '0xactive',
          weight: '0.7',
          expires_at: new Date('2026-12-01T00:00:00Z'),
          block_number: '300',
          log_index: 0,
        }),
        row({
          delegation_system: 'split_delegation',
          delegate_address: '0xexpired',
          weight: '0.3',
          expires_at: new Date('2026-02-01T00:00:00Z'),
          block_number: '300',
          log_index: 0,
        }),
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.delegate_address).toBe('0xactive');
    expect(out[0]?.weight).toBe('0.7');
    expect(out[0]?.system).toBe('split_delegation');
  });
});

describe('resolveCurrentRelationshipsForSpace', () => {
  it('uses the current space-specific registry delegate instead of the global delegate', () => {
    const out = resolveCurrentRelationshipsForSpace(
      [
        row({ space_id: null, delegate_address: '0xglobal', block_number: '100' }),
        row({ space_id: 'lido-snapshot.eth', delegate_address: '0xspace', block_number: '90' }),
      ],
      'lido-snapshot.eth',
      NOW,
    );

    expect(out).toEqual([{ delegator_address: '0xaa', delegate_address: '0xspace' }]);
  });

  it('falls back to the global registry delegate after a space-specific clear', () => {
    const out = resolveCurrentRelationshipsForSpace(
      [
        row({ space_id: null, delegate_address: '0xglobal', block_number: '100' }),
        row({ space_id: 'lido-snapshot.eth', delegate_address: '0xspace', block_number: '110' }),
        row({
          space_id: 'lido-snapshot.eth',
          delegate_address: '0x0',
          event_type: 'clear',
          block_number: '120',
        }),
      ],
      'lido-snapshot.eth',
      NOW,
    );

    expect(out).toEqual([{ delegator_address: '0xaa', delegate_address: '0xglobal' }]);
  });

  it('adds every active split delegate and excludes expired relationships', () => {
    const out = resolveCurrentRelationshipsForSpace(
      [
        row({
          delegation_system: 'split_delegation',
          delegate_address: '0xactive',
          expires_at: new Date('2026-12-01T00:00:00Z'),
          block_number: '200',
        }),
        row({
          delegation_system: 'split_delegation',
          delegate_address: '0xexpired',
          expires_at: new Date('2026-05-01T00:00:00Z'),
          block_number: '200',
        }),
      ],
      'lido-snapshot.eth',
      NOW,
    );

    expect(out).toEqual([{ delegator_address: '0xaa', delegate_address: '0xactive' }]);
  });
});
