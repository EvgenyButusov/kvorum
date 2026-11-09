import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { PgDatabase } from '@libs/db';
import { EASY_TRACK_GENERATED_DESCRIPTION_PREFIX } from '../src/easy-track/domain/description';
import { refreshAllEasyTrackDescriptions } from '../src/easy-track/domain/description-enricher';

/** Backfill factual descriptions for every Easy Track motion already projected. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await refreshAllEasyTrackDescriptions(db as Kysely<PgDatabase>);
}

/** Remove only descriptions owned by this formatter; never erase later human-authored content. */
export async function down(db: Kysely<unknown>): Promise<void> {
  const emptyHash = createHash('sha256').update('').digest('hex');
  await (db as Kysely<PgDatabase>)
    .updateTable('proposal')
    .set({ description: '', description_hash: emptyHash, updated_at: sql<Date>`now()` })
    .where('source_type', '=', 'easy_track')
    .where('description', 'like', `${EASY_TRACK_GENERATED_DESCRIPTION_PREFIX}%`)
    .execute();
}
