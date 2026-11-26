import { ClickhouseDialect } from '@founderpath/kysely-clickhouse';
import { DummyDriver, Kysely, PostgresDialect, type Dialect } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClickHouseDatabase, PgDatabase } from '@libs/db';
import { CompoundArchiveReconcileRepository } from './compound-archive-reconcile-repository';

// Compile with the real database dialects; replace only the connection so the
// join/conflict callbacks, predicates, parameters and update results are exercised.
async function database<DB>(dialect: Dialect) {
  const driver = new DummyDriver();
  const connection = await driver.acquireConnection();
  const execute = vi.spyOn(connection, 'executeQuery').mockResolvedValue({ rows: [] });
  vi.spyOn(driver, 'acquireConnection').mockResolvedValue(connection);
  const db = new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => dialect.createAdapter(),
      createQueryCompiler: () => dialect.createQueryCompiler(),
      createIntrospector: (instance) => dialect.createIntrospector(instance),
    },
  });
  return { db, execute };
}

const databases: Kysely<unknown>[] = [];
async function setup() {
  const pg = await database<PgDatabase>(new PostgresDialect({ pool: {} as never }));
  const ch = await database<ClickHouseDatabase>(new ClickhouseDialect());
  databases.push(pg.db, ch.db);
  return { pg, ch, repo: new CompoundArchiveReconcileRepository(pg.db, ch.db) };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

const sourceId = '00000000-0000-0000-0000-000000000001';
const reconcileId = '00000000-0000-0000-0000-000000000002';
const identity = {
  block_number: '9007199254740993',
  block_hash: '0x' + 'ab'.repeat(32),
  tx_hash: '0x' + 'cd'.repeat(32),
  log_index: 1,
  event_type: 'VoteCast',
};

describe('CompoundArchiveReconcileRepository', () => {
  it('selects the live governor source for the reconciler DAO and chain, including an optional audit cursor', async () => {
    const { pg, repo } = await setup();
    const source = {
      id: sourceId,
      governor_address: '0x' + '12'.repeat(20),
      active_from_block: '1',
      active_to_block: null,
      poll_cursor_block: '2000',
      last_checked_block: null,
    };
    pg.execute.mockResolvedValueOnce({ rows: [source] });
    await expect(repo.findSource(reconcileId, 'compound_governor_oz')).resolves.toEqual(source);
    const query = pg.execute.mock.calls[0]![0];
    expect(query.sql).toContain(
      'inner join "dao_source" as "source" on "source"."dao_id" = "reconcile"."dao_id" and "source"."chain_id" = "reconcile"."chain_id"',
    );
    expect(query.sql).toContain(
      'left join "archive_reconcile_cursor" as "cursor" on "cursor"."dao_source_id" = "source"."id"',
    );
    expect(query.sql).toContain("source.source_config ->> 'governor_address'");
    expect(query.sql).toContain(
      'where "reconcile"."id" = $1 and "source"."source_type" = $2 and "source"."live_polling_enabled" = $3',
    );
    expect(query.parameters).toEqual([reconcileId, 'compound_governor_oz', true]);
  });

  it('returns undefined when there is no matching live source', async () => {
    const { repo } = await setup();
    await expect(repo.findSource(reconcileId, 'compound_governor_alpha')).resolves.toBeUndefined();
  });

  it('reads both archives with inclusive source-scoped bounds without losing bigint precision', async () => {
    const { pg, ch, repo } = await setup();
    pg.execute.mockResolvedValueOnce({ rows: [identity] });
    await expect(
      repo.readIdentities(sourceId, 9007199254740993n, 9007199254740995n),
    ).resolves.toEqual({
      pg: [identity],
      ch: [],
    });
    const pgQuery = pg.execute.mock.calls[0]![0];
    const chQuery = ch.execute.mock.calls[0]![0];
    expect(pgQuery.sql).toContain('from "archive_event"');
    expect(pgQuery.sql).toContain(
      "source_type IN ('compound_governor_alpha', 'compound_governor_bravo', 'compound_governor_oz')",
    );
    expect(pgQuery.sql).toContain(
      '"dao_source_id" = $1 and "block_number" >= $2 and "block_number" <= $3',
    );
    expect(pgQuery.parameters).toEqual([sourceId, '9007199254740993', '9007199254740995']);
    expect(chQuery.sql).toContain('archive_event_compound_governor_bravo');
    expect(chQuery.sql).toContain('dao_source_id');
    expect(chQuery.sql).toContain('>=');
    expect(chQuery.sql).toContain('<=');
    expect(chQuery.parameters).toEqual(pgQuery.parameters);
  });

  it('preserves ClickHouse-only identities so partial writes remain detectable', async () => {
    const { ch, repo } = await setup();
    ch.execute.mockResolvedValueOnce({ rows: [identity] });
    await expect(repo.readIdentities(sourceId, 1n, 2n)).resolves.toEqual({
      pg: [],
      ch: [identity],
    });
  });

  it.each(['pg', 'ch'] as const)(
    'propagates %s archive read failures instead of reporting an empty archive',
    async (store) => {
      const context = await setup();
      context[store].execute.mockRejectedValueOnce(new Error('archive unavailable'));
      await expect(context.repo.readIdentities(sourceId, 1n, 2n)).rejects.toThrow(
        'archive unavailable',
      );
    },
  );

  it('initializes a cursor idempotently without overwriting existing progress', async () => {
    const { pg, repo } = await setup();
    await repo.initialize(sourceId, 9007199254740993n);
    const query = pg.execute.mock.calls[0]![0];
    expect(query.sql).toBe(
      'insert into "archive_reconcile_cursor" ("dao_source_id", "last_checked_block") values ($1, $2) on conflict ("dao_source_id") do nothing',
    );
    expect(query.parameters).toEqual([sourceId, '9007199254740993']);
  });

  it.each([
    { numAffectedRows: 1n, expected: true },
    { numAffectedRows: 0n, expected: false },
    { numAffectedRows: undefined, expected: false },
  ])(
    'reports guarded checkpoint advancement as $expected for $numAffectedRows affected rows',
    async ({ numAffectedRows, expected }) => {
      const { pg, repo } = await setup();
      pg.execute.mockResolvedValueOnce({ rows: [], numAffectedRows });
      await expect(repo.advance(sourceId, 9007199254740993n, 9007199254740995n)).resolves.toBe(
        expected,
      );
      const query = pg.execute.mock.calls[0]![0];
      expect(query.sql).toBe(
        'update "archive_reconcile_cursor" set "last_checked_block" = $1 where "dao_source_id" = $2 and "last_checked_block" = $3',
      );
      expect(query.parameters).toEqual(['9007199254740995', sourceId, '9007199254740993']);
    },
  );

  it('propagates checkpoint write failures so the audit can retry', async () => {
    const { pg, repo } = await setup();
    pg.execute.mockRejectedValueOnce(new Error('checkpoint unavailable'));
    await expect(repo.advance(sourceId, 1n, 2n)).rejects.toThrow('checkpoint unavailable');
    pg.execute.mockRejectedValueOnce(new Error('initialization unavailable'));
    await expect(repo.initialize(sourceId, 1n)).rejects.toThrow('initialization unavailable');
  });
});
