import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE archive_event ALTER COLUMN derivation_attempt_count TYPE integer`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Clamp first: a row that overflowed smallint is why this column was widened, and
  // ALTER TYPE would abort on it.
  await sql`UPDATE archive_event SET derivation_attempt_count = 32767 WHERE derivation_attempt_count > 32767`.execute(
    db,
  );
  await sql`ALTER TABLE archive_event ALTER COLUMN derivation_attempt_count TYPE smallint`.execute(
    db,
  );
}
