import { sql, type Kysely } from 'kysely';
import type { ClickHouseDatabase, PgDatabase } from '@libs/db';
import './schema';

export interface ArchiveReconcileSource {
  id: string;
  governor_address: string;
  active_from_block: string | null;
  active_to_block: string | null;
  poll_cursor_block: string | null;
  last_checked_block: string | null;
}

export interface ArchiveIdentity {
  block_number: string;
  block_hash: string;
  tx_hash: string;
  log_index: number;
  event_type: string;
}

export class CompoundArchiveReconcileRepository {
  constructor(
    private readonly pg: Kysely<PgDatabase>,
    private readonly ch: Kysely<ClickHouseDatabase>,
  ) {}

  async findSource(
    reconcileSourceId: string,
    sourceType: string,
  ): Promise<ArchiveReconcileSource | undefined> {
    return this.pg
      .selectFrom('dao_source as reconcile')
      .innerJoin('dao_source as source', (join) =>
        join
          .onRef('source.dao_id', '=', 'reconcile.dao_id')
          .onRef('source.chain_id', '=', 'reconcile.chain_id'),
      )
      .leftJoin('compound_archive_reconcile_cursor as cursor', 'cursor.dao_source_id', 'source.id')
      .select([
        'source.id',
        sql<string>`source.source_config ->> 'governor_address'`.as('governor_address'),
        'source.active_from_block',
        'source.active_to_block',
        'source.poll_cursor_block',
        'cursor.last_checked_block',
      ])
      .where('reconcile.id', '=', reconcileSourceId)
      .where('source.source_type', '=', sourceType)
      .where('source.live_polling_enabled', '=', true)
      .executeTakeFirst();
  }

  async readIdentities(
    daoSourceId: string,
    from: bigint,
    to: bigint,
  ): Promise<{
    pg: ArchiveIdentity[];
    ch: ArchiveIdentity[];
  }> {
    const columns = ['block_number', 'block_hash', 'tx_hash', 'log_index', 'event_type'] as const;
    const [pg, ch] = await Promise.all([
      this.pg
        .selectFrom('archive_event')
        .select(columns)
        .where(
          sql<boolean>`source_type IN ('compound_governor_alpha', 'compound_governor_bravo', 'compound_governor_oz')`,
        )
        .where('dao_source_id', '=', daoSourceId)
        .where('block_number', '>=', from.toString())
        .where('block_number', '<=', to.toString())
        .execute(),
      this.ch
        .selectFrom('archive_event_compound_governor_bravo')
        .select(columns)
        .where('dao_source_id', '=', daoSourceId)
        .where('block_number', '>=', from.toString())
        .where('block_number', '<=', to.toString())
        .execute(),
    ]);
    return { pg: pg as ArchiveIdentity[], ch };
  }

  async initialize(daoSourceId: string, block: bigint): Promise<void> {
    await this.pg
      .insertInto('compound_archive_reconcile_cursor')
      .values({ dao_source_id: daoSourceId, last_checked_block: block.toString() })
      .onConflict((oc) => oc.column('dao_source_id').doNothing())
      .execute();
  }

  async advance(daoSourceId: string, previous: bigint, next: bigint): Promise<boolean> {
    const result = await this.pg
      .updateTable('compound_archive_reconcile_cursor')
      .set({ last_checked_block: next.toString() })
      .where('dao_source_id', '=', daoSourceId)
      .where('last_checked_block', '=', previous.toString())
      .executeTakeFirst();
    return Number(result?.numUpdatedRows ?? 0n) === 1;
  }
}
