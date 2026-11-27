import { DummyDriver, Kysely, PostgresDialect } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArchiveDerivationAdminRepository } from './archive-derivation-admin-repository';
import type { PgDatabase } from './schema/pg';

function makeCountSelectChain(returnValue: unknown) {
  const executeTakeFirstOrThrow = vi.fn().mockResolvedValue(returnValue);
  const chain = {
    select: vi.fn(),
    where: vi.fn(),
    executeTakeFirstOrThrow,
  };
  chain.select.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return { selectFrom: vi.fn().mockReturnValue(chain), chain };
}

function makeUpdateChain(returnValue: unknown) {
  const executeTakeFirst = vi.fn().mockResolvedValue(returnValue);
  const chain = {
    set: vi.fn(),
    where: vi.fn(),
    executeTakeFirst,
  };
  chain.set.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return { updateTable: vi.fn().mockReturnValue(chain), chain };
}

describe('ArchiveDerivationAdminRepository', () => {
  it('counts underived rows without a starting block', async () => {
    const select = makeCountSelectChain({ count: '7' });
    const repo = new ArchiveDerivationAdminRepository({ selectFrom: select.selectFrom } as never);

    await expect(repo.countUnderived('source-1')).resolves.toBe(7);

    expect(select.selectFrom).toHaveBeenCalledWith('archive_event');
    expect(select.chain.where).toHaveBeenCalledWith('dao_source_id', '=', 'source-1');
    expect(select.chain.where).not.toHaveBeenCalledWith('block_number', '>=', expect.anything());
  });

  it('counts underived rows from a starting block', async () => {
    const select = makeCountSelectChain({ count: '3' });
    const repo = new ArchiveDerivationAdminRepository({ selectFrom: select.selectFrom } as never);

    await expect(repo.countUnderived('source-1', 123n)).resolves.toBe(3);

    expect(select.chain.where).toHaveBeenCalledWith('block_number', '>=', '123');
  });

  it('resets derivation watermark by archive event id', async () => {
    const update = makeUpdateChain({ numUpdatedRows: 1n });
    const repo = new ArchiveDerivationAdminRepository({ updateTable: update.updateTable } as never);

    await expect(repo.resetWatermarkByConfirmationId('ac-1')).resolves.toBe(1);

    expect(update.updateTable).toHaveBeenCalledWith('archive_event');
    expect(update.chain.set).toHaveBeenCalledWith({
      derived_at: null,
      derivation_attempt_count: 0,
    });
    expect(update.chain.where).toHaveBeenCalledWith('id', '=', 'ac-1');
  });
});

// The rewind's safety property is a SQL predicate, so these compile against the real Postgres
// dialect and assert the statement rather than a mock chain.
const compiled: Kysely<PgDatabase>[] = [];
async function realDialect() {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const execute = vi.spyOn(connection, 'executeQuery').mockResolvedValue({ rows: [] });
  vi.spyOn(driver, 'acquireConnection').mockResolvedValue(connection);
  const dialect = new PostgresDialect({ pool: {} as never });
  const db = new Kysely<PgDatabase>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => dialect.createAdapter(),
      createQueryCompiler: () => dialect.createQueryCompiler(),
      createIntrospector: (instance) => dialect.createIntrospector(instance),
    },
  });
  compiled.push(db);
  return { db, execute, repo: new ArchiveDerivationAdminRepository(db) };
}

afterEach(async () => {
  await Promise.all(compiled.splice(0).map((db) => db.destroy()));
});

describe('archive reconcile cursor rewind', () => {
  it('only moves cursors already past the target, never forward', async () => {
    const { execute, repo } = await realDialect();

    await repo.rewindArchiveReconcileCursor(1_000n);

    const query = execute.mock.calls[0]![0];
    expect(query.sql).toBe(
      'update "archive_reconcile_cursor" set "last_checked_block" = $1 where "last_checked_block" > $2',
    );
    expect(query.parameters).toEqual(['1000', '1000']);
  });

  it('scopes to the given source types through dao_source', async () => {
    const { execute, repo } = await realDialect();

    await repo.rewindArchiveReconcileCursor(500n, ['compound_governor_oz']);

    const query = execute.mock.calls[0]![0];
    expect(query.sql).toContain('"dao_source_id" in (select "dao_source"."id" from "dao_source"');
    expect(query.sql).toContain('"dao_source"."source_type" in ($3)');
    expect(query.parameters).toEqual(['500', '500', 'compound_governor_oz']);
  });

  it('counts the same scope it would rewind', async () => {
    const { execute, repo } = await realDialect();
    execute.mockResolvedValue({ rows: [{ count: '3' }] });

    await expect(repo.countArchiveReconcileRewind(750n)).resolves.toBe(3);

    const query = execute.mock.calls[0]![0];
    expect(query.sql).toContain('from "archive_reconcile_cursor"');
    expect(query.sql).toContain('"last_checked_block" > $1');
  });

  it('unparks only un-derived rows at or past the ceiling, leaving derived_at alone', async () => {
    const { execute, repo } = await realDialect();
    execute.mockResolvedValue({ rows: [], numAffectedRows: 12n });

    await expect(repo.unparkExhausted(50)).resolves.toBe(12);

    const query = execute.mock.calls[0]![0];
    expect(query.sql).toContain('update "archive_event" set "derivation_attempt_count" = $1');
    expect(query.sql).toContain('"derived_at" is null');
    expect(query.sql).toContain('"derivation_attempt_count" >= $2');
    // Clearing derived_at here would un-derive rows an operator never asked to replay.
    expect(query.sql).not.toContain('"derived_at" = ');
    expect(query.parameters).toEqual([0, 50]);
  });

  it('scopes an unpark to the requested source types', async () => {
    const { execute, repo } = await realDialect();
    execute.mockResolvedValue({ rows: [], numAffectedRows: 2n });

    await repo.unparkExhausted(50, ['aave_governance_v3']);

    const query = execute.mock.calls[0]![0];
    expect(query.sql).toContain('"source_type" in ($3)');
    expect(query.parameters).toEqual([0, 50, 'aave_governance_v3']);
  });

  it('counts parked rows grouped by source type', async () => {
    const { execute, repo } = await realDialect();
    execute.mockResolvedValue({
      rows: [
        { source_type: 'aave_governance_v3', count: '12' },
        { source_type: 'aave_payloads_controller', count: '50' },
      ],
    });

    await expect(repo.countParkedBySourceType(50)).resolves.toEqual([
      { source_type: 'aave_governance_v3', count: 12 },
      { source_type: 'aave_payloads_controller', count: 50 },
    ]);

    const query = execute.mock.calls[0]![0];
    expect(query.sql).toContain('"derived_at" is null');
    expect(query.sql).toContain('group by "source_type"');
  });
});
