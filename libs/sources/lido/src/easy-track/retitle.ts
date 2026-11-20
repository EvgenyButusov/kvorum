import type { Kysely } from 'kysely';
import type { PgDatabase } from '@libs/db';
import { easyTrackMotionTitle } from './domain/title-extractor';

export interface EasyTrackRetitleResult {
  scanned: number;
  updated: number;
  /** Motions left alone because their factory has no label; they keep the bare placeholder. */
  unlabelled: number;
  /** Motions whose stored title already matched. */
  unchanged: number;
  samples: { sourceId: string; from: string | null; to: string }[];
}

const SAMPLE_LIMIT = 5;

/**
 * Recompute `proposal.title` for Easy Track motions from their factory's type label. Needed because
 * `MotionCreated` derivation is insert-or-skip, so re-deriving never revisits an existing row, and
 * because the title feeds `proposal.search_vector` (a stored generated column, refreshed by the
 * UPDATE itself). Writes nothing when `dryRun`.
 */
export async function retitleEasyTrackMotions(
  db: Kysely<PgDatabase>,
  opts: { sourceType: string; dryRun: boolean },
): Promise<EasyTrackRetitleResult> {
  const rows = await db
    .selectFrom('proposal')
    .innerJoin('easy_track_motion_meta as m', 'm.proposal_id', 'proposal.id')
    .select(['proposal.id', 'proposal.source_id', 'proposal.title', 'm.factory_address'])
    .where('proposal.source_type', '=', opts.sourceType)
    .orderBy('proposal.source_id')
    .execute();

  const result: EasyTrackRetitleResult = {
    scanned: rows.length,
    updated: 0,
    unlabelled: 0,
    unchanged: 0,
    samples: [],
  };

  for (const row of rows) {
    const next = easyTrackMotionTitle(row.source_id, row.factory_address);
    if (next === easyTrackMotionTitle(row.source_id)) {
      result.unlabelled += 1;
      continue;
    }
    if (next === row.title) {
      result.unchanged += 1;
      continue;
    }
    if (result.samples.length < SAMPLE_LIMIT) {
      result.samples.push({ sourceId: row.source_id, from: row.title, to: next });
    }
    if (!opts.dryRun) {
      await db.updateTable('proposal').set({ title: next }).where('id', '=', row.id).execute();
    }
    result.updated += 1;
  }

  return result;
}
