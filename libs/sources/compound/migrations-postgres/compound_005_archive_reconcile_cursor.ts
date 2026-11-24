import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE compound_archive_reconcile_cursor (
      dao_source_id uuid PRIMARY KEY REFERENCES dao_source(id) ON DELETE CASCADE,
      last_checked_block bigint NOT NULL
    )
  `.execute(db);
  // A small partial index avoids scanning unrelated protocol archives on every audit tick.
  await sql`
    CREATE INDEX idx_compound_archive_reconcile_range ON archive_event (dao_source_id, block_number)
    WHERE source_type IN ('compound_governor_alpha', 'compound_governor_bravo', 'compound_governor_oz')
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX idx_compound_archive_reconcile_range`.execute(db);
  await sql`DROP TABLE compound_archive_reconcile_cursor`.execute(db);
}
