import type { Kysely } from 'kysely';
import type { PgDatabase } from './schema/pg';
export type { ArchiveDerivationRow } from './archive-derivation-repository';

export class ArchiveDerivationAdminRepository {
  constructor(private readonly pgDb: Kysely<PgDatabase>) {}

  async countUnderived(daoSourceId: string, fromBlock?: bigint): Promise<number> {
    let query = this.pgDb
      .selectFrom('archive_event')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('dao_source_id', '=', daoSourceId);

    if (fromBlock != null) {
      query = query.where('block_number', '>=', fromBlock.toString());
    }

    const row = await query.executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async resetWatermarkForSource(daoSourceId: string, fromBlock?: bigint): Promise<number> {
    let query = this.pgDb
      .updateTable('archive_event')
      .set({ derived_at: null, derivation_attempt_count: 0 })
      .where('dao_source_id', '=', daoSourceId);

    if (fromBlock != null) {
      query = query.where('block_number', '>=', fromBlock.toString());
    }

    const result = await query.executeTakeFirst();
    return Number(result?.numUpdatedRows ?? 0n);
  }

  /** Cursor rows a rewind to `toBlock` would move: only those already past it. */
  async countArchiveReconcileRewind(
    toBlock: bigint,
    sourceTypes?: readonly string[],
  ): Promise<number> {
    let query = this.pgDb
      .selectFrom('archive_reconcile_cursor')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('last_checked_block', '>', toBlock.toString());

    if (sourceTypes != null && sourceTypes.length > 0) {
      query = query.where('dao_source_id', 'in', (eb) =>
        eb
          .selectFrom('dao_source')
          .select('dao_source.id')
          .where('dao_source.source_type', 'in', sourceTypes as never[]),
      );
    }

    const row = await query.executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /**
   * Rewinds the archive-completeness audit cursor so a block range is audited again. Rewind only:
   * a cursor at or behind `toBlock` is left alone, because moving one forward would mark blocks the
   * audit has never read as checked. Re-running with the same bound is a no-op.
   */
  async rewindArchiveReconcileCursor(
    toBlock: bigint,
    sourceTypes?: readonly string[],
  ): Promise<number> {
    let query = this.pgDb
      .updateTable('archive_reconcile_cursor')
      .set({ last_checked_block: toBlock.toString() })
      .where('last_checked_block', '>', toBlock.toString());

    if (sourceTypes != null && sourceTypes.length > 0) {
      query = query.where('dao_source_id', 'in', (eb) =>
        eb
          .selectFrom('dao_source')
          .select('dao_source.id')
          .where('dao_source.source_type', 'in', sourceTypes as never[]),
      );
    }

    const result = await query.executeTakeFirst();
    return Number(result?.numUpdatedRows ?? 0n);
  }

  /** Un-derived rows the projection attempt ceiling has parked, per source type. */
  async countParkedBySourceType(
    maxAttempts: number,
    sourceTypes?: readonly string[],
  ): Promise<{ source_type: string; count: number }[]> {
    let query = this.pgDb
      .selectFrom('archive_event')
      .select(['source_type', (eb) => eb.fn.countAll<string>().as('count')])
      .where('derived_at', 'is', null)
      .where('derivation_attempt_count', '>=', maxAttempts);

    if (sourceTypes != null && sourceTypes.length > 0) {
      query = query.where('source_type', 'in', sourceTypes as never[]);
    }

    const rows = await query.groupBy('source_type').orderBy('source_type', 'asc').execute();
    return rows.map((row) => ({ source_type: row.source_type, count: Number(row.count) }));
  }

  /**
   * Returns parked rows to the derivable queue by clearing only the attempt counter. `derived_at`
   * is both filtered on and left alone, so this can never un-derive an already-applied row the way
   * a whole-source `derive replay` does. Re-running it is a no-op once the rows have derived.
   */
  async unparkExhausted(maxAttempts: number, sourceTypes?: readonly string[]): Promise<number> {
    let query = this.pgDb
      .updateTable('archive_event')
      .set({ derivation_attempt_count: 0 })
      .where('derived_at', 'is', null)
      .where('derivation_attempt_count', '>=', maxAttempts);

    if (sourceTypes != null && sourceTypes.length > 0) {
      query = query.where('source_type', 'in', sourceTypes as never[]);
    }

    const result = await query.executeTakeFirst();
    return Number(result?.numUpdatedRows ?? 0n);
  }

  async resetWatermarkByConfirmationId(archiveConfirmationId: string): Promise<number> {
    const result = await this.pgDb
      .updateTable('archive_event')
      .set({ derived_at: null, derivation_attempt_count: 0 })
      .where('id', '=', archiveConfirmationId)
      .executeTakeFirst();

    return Number(result?.numUpdatedRows ?? 0n);
  }
}
