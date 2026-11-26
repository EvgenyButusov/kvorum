import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // A partial index keeps the audit's range read off unrelated protocols' archive rows. The
  // predicate must stay in step with the source types the governor audit covers.
  await sql`
    CREATE INDEX idx_compound_archive_reconcile_range ON archive_event (dao_source_id, block_number)
    WHERE source_type IN ('compound_governor_alpha', 'compound_governor_bravo', 'compound_governor_oz')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX idx_compound_archive_reconcile_range`.execute(db);
}
