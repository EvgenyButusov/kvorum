import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE archive_reconcile_cursor (
      dao_source_id uuid PRIMARY KEY REFERENCES dao_source(id) ON DELETE CASCADE,
      last_checked_block bigint NOT NULL
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE archive_reconcile_cursor`.execute(db);
}
