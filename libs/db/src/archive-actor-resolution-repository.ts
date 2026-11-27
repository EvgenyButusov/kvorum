import { sql, type ExpressionBuilder, type Kysely } from 'kysely';
import type { ArchiveEventType } from '@libs/domain';
import type { ArchiveDerivationRow, OffchainArchiveRow } from './archive-derivation-repository';
import type { PgDatabase } from './schema/pg';

/**
 * A row is derivable unless it is explicitly held into the future (KNOWN-028). Rows that predate the
 * hold column — and every row an applier never defers — have a null `derivation_hold_until` and stay
 * derivable, so this filter is a no-op for everything except an active deferral.
 */
function notHeld(now: Date) {
  return (eb: ExpressionBuilder<PgDatabase, 'archive_event'>) =>
    eb.or([eb('derivation_hold_until', 'is', null), eb('derivation_hold_until', '<=', now)]);
}

/**
 * A row stops being derivable once it has failed `maxAttempts` times. The projection stage had no
 * such ceiling, so a row whose failure never clears — a permanently absent parent, an undecodable
 * payload — was reselected every tick forever, until `derivation_attempt_count` overflowed its
 * column and the overflow itself became the failure. The actor-resolution stage has always bounded
 * itself this way (`actor_resolution_attempt_count < attemptThreshold`); this is that bound for the
 * projection stage. Parked rows return to the queue through `derive unpark`, which resets the count
 * for parked rows only — `derive replay` also clears `derived_at` for a whole source.
 *
 * It arrives in an options object rather than a positional parameter: inserting one ahead of `now`
 * silently rebound every existing `(eventTypes, limit, now)` call site, and the integration and e2e
 * suites that caught it are outside the typecheck projects.
 */
export const DEFAULT_MAX_DERIVATION_ATTEMPTS = 50;

function notExhausted(maxAttempts: number) {
  return (eb: ExpressionBuilder<PgDatabase, 'archive_event'>) =>
    eb('derivation_attempt_count', '<', maxAttempts);
}

/**
 * Projection DLQ rows are quarantined until an operator retries them. The retry adapter removes the
 * active DLQ row after resetting the archive watermark, which makes the event eligible again. An
 * accepted DLQ row remains quarantined through ingestion_dlq_resolved, matching ADR-032's permanent
 * acknowledgement semantics without modifying the archive event.
 *
 * Match on the indexed EVM archive tuple rather than payload JSON. The partial unique DLQ index
 * starts with these five columns, so the correlated NOT EXISTS lookup is bounded to the event.
 */
function notInProjectionDlq() {
  return (eb: ExpressionBuilder<PgDatabase, 'archive_event'>) =>
    eb.and([
      eb.not(
        eb.exists(
          eb
            .selectFrom('ingestion_dlq as dlq')
            .select('dlq.id')
            .whereRef('dlq.archive_source_type', '=', 'archive_event.source_type')
            .whereRef('dlq.archive_chain_id', '=', 'archive_event.chain_id')
            .whereRef('dlq.archive_tx_hash', '=', 'archive_event.tx_hash')
            .whereRef('dlq.archive_log_index', '=', 'archive_event.log_index')
            .whereRef('dlq.archive_block_hash', '=', 'archive_event.block_hash')
            .where('dlq.stage', 'like', '%projection_stage'),
        ),
      ),
      eb.not(
        eb.exists(
          eb
            .selectFrom('ingestion_dlq_resolved as resolved_dlq')
            .select('resolved_dlq.id')
            .whereRef('resolved_dlq.archive_source_type', '=', 'archive_event.source_type')
            .whereRef('resolved_dlq.archive_chain_id', '=', 'archive_event.chain_id')
            .whereRef('resolved_dlq.archive_tx_hash', '=', 'archive_event.tx_hash')
            .whereRef('resolved_dlq.archive_log_index', '=', 'archive_event.log_index')
            .whereRef('resolved_dlq.archive_block_hash', '=', 'archive_event.block_hash')
            .where('resolved_dlq.stage', 'like', '%projection_stage')
            .where('resolved_dlq.resolution_kind', '=', 'accepted'),
        ),
      ),
    ]);
}

const OFFCHAIN_COLUMNS = [
  'id',
  'source_type',
  'dao_source_id',
  'chain_id',
  'external_id',
  'derivation_ordinal',
  'event_type',
  'received_at',
  'derivation_attempt_count',
] as const;

export class ArchiveActorResolutionRepository {
  constructor(private readonly pgDb: Kysely<PgDatabase>) {}

  async findDerivableBy(
    eventTypes: readonly ArchiveEventType[],
    limit: number,
    now: Date = new Date(),
    options: { maxAttempts?: number } = {},
  ): Promise<ArchiveDerivationRow[]> {
    if (eventTypes.length === 0) return [];

    // external_id IS NULL restricts to EVM rows (non-null coords by the
    // archive_event_identity_shape CHECK), narrowing the nullable table type to
    // ArchiveDerivationRow. Off-chain rows are served by the *Offchain methods.
    const rows = await this.pgDb
      .selectFrom('archive_event')
      .select([
        'id',
        'source_type',
        'dao_source_id',
        'chain_id',
        'block_number',
        'block_hash',
        'tx_hash',
        'log_index',
        'event_type',
        'received_at',
        'derivation_attempt_count',
      ])
      .where('external_id', 'is', null)
      .where('derived_at', 'is', null)
      .where('derivation_actor_resolved_at', 'is not', null)
      .where('event_type', 'in', eventTypes)
      .where(notHeld(now))
      .where(notExhausted(options.maxAttempts ?? DEFAULT_MAX_DERIVATION_ATTEMPTS))
      .where(notInProjectionDlq())
      .orderBy('chain_id', 'asc')
      .orderBy('block_number', 'asc')
      .orderBy('log_index', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();
    return rows as ArchiveDerivationRow[];
  }

  async findUnresolvedActors(
    eventTypes: readonly ArchiveEventType[],
    attemptThreshold: number,
    limit: number,
  ): Promise<ArchiveDerivationRow[]> {
    if (eventTypes.length === 0) return [];

    // external_id IS NULL restricts to EVM rows (non-null coords by the
    // archive_event_identity_shape CHECK), narrowing the nullable table type to
    // ArchiveDerivationRow. Off-chain rows are served by the *Offchain methods.
    const rows = await this.pgDb
      .selectFrom('archive_event')
      .select([
        'id',
        'source_type',
        'dao_source_id',
        'chain_id',
        'block_number',
        'block_hash',
        'tx_hash',
        'log_index',
        'event_type',
        'received_at',
        'derivation_attempt_count',
      ])
      .where('external_id', 'is', null)
      .where('derivation_actor_resolved_at', 'is', null)
      .where('event_type', 'in', eventTypes)
      .where('actor_resolution_attempt_count', '<', attemptThreshold)
      .orderBy('chain_id', 'asc')
      .orderBy('block_number', 'asc')
      .orderBy('log_index', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();
    return rows as ArchiveDerivationRow[];
  }

  /** Off-chain counterpart of findDerivableBy: external_id rows whose actors are
   *  resolved, ordered by derivation_ordinal (then external_id, id) for determinism. */
  async findDerivableByOffchain(
    eventTypes: readonly ArchiveEventType[],
    limit: number,
    now: Date = new Date(),
    options: { maxAttempts?: number } = {},
  ): Promise<OffchainArchiveRow[]> {
    if (eventTypes.length === 0) return [];

    const rows = await this.pgDb
      .selectFrom('archive_event')
      .select(OFFCHAIN_COLUMNS)
      .where('external_id', 'is not', null)
      .where('derived_at', 'is', null)
      .where('derivation_actor_resolved_at', 'is not', null)
      .where('event_type', 'in', eventTypes)
      .where(notHeld(now))
      .where(notExhausted(options.maxAttempts ?? DEFAULT_MAX_DERIVATION_ATTEMPTS))
      .orderBy('chain_id', 'asc')
      .orderBy('derivation_ordinal', 'asc')
      .orderBy('external_id', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();
    return rows as OffchainArchiveRow[];
  }

  /** Rows parked by the attempt ceiling, per source type, for the parked-rows gauge. */
  async countExhausted(
    eventTypes: readonly ArchiveEventType[],
    maxAttempts: number = DEFAULT_MAX_DERIVATION_ATTEMPTS,
  ): Promise<{ source_type: string; count: number }[]> {
    if (eventTypes.length === 0) return [];

    const rows = await this.pgDb
      .selectFrom('archive_event')
      .select(['source_type', (eb) => eb.fn.countAll<string>().as('count')])
      .where('derived_at', 'is', null)
      .where('event_type', 'in', eventTypes)
      .where('derivation_attempt_count', '>=', maxAttempts)
      .groupBy('source_type')
      .execute();
    return rows.map((row) => ({ source_type: row.source_type, count: Number(row.count) }));
  }

  /**
   * Age of the oldest row currently held, per source type, for the held-backlog gauge.
   *
   * Appliers can only report the rows in the batch they were handed, and a held row is excluded
   * from selection until its hold expires — so a batch-derived age reads zero between retries and
   * spikes when one lands (#686). This reads the table instead, so the gauge is stable.
   */
  async oldestHeldAgeSeconds(
    eventTypes: readonly ArchiveEventType[],
    now: Date = new Date(),
  ): Promise<{ source_type: string; age_seconds: number }[]> {
    if (eventTypes.length === 0) return [];

    const rows = await this.pgDb
      .selectFrom('archive_event')
      .select(['source_type', (eb) => eb.fn.min<Date>('received_at').as('oldest_received_at')])
      .where('derived_at', 'is', null)
      .where('derivation_hold_until', 'is not', null)
      .where('event_type', 'in', eventTypes)
      .groupBy('source_type')
      .execute();
    return rows.map((row) => ({
      source_type: row.source_type,
      age_seconds: Math.max(0, (now.getTime() - row.oldest_received_at.getTime()) / 1000),
    }));
  }

  /** Off-chain counterpart of findUnresolvedActors. */
  async findUnresolvedActorsOffchain(
    eventTypes: readonly ArchiveEventType[],
    attemptThreshold: number,
    limit: number,
  ): Promise<OffchainArchiveRow[]> {
    if (eventTypes.length === 0) return [];

    const rows = await this.pgDb
      .selectFrom('archive_event')
      .select(OFFCHAIN_COLUMNS)
      .where('external_id', 'is not', null)
      .where('derivation_actor_resolved_at', 'is', null)
      .where('event_type', 'in', eventTypes)
      .where('actor_resolution_attempt_count', '<', attemptThreshold)
      .orderBy('chain_id', 'asc')
      .orderBy('derivation_ordinal', 'asc')
      .orderBy('external_id', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();
    return rows as OffchainArchiveRow[];
  }

  async markActorResolved(id: string): Promise<void> {
    await this.pgDb
      .updateTable('archive_event')
      .set({ derivation_actor_resolved_at: sql`now()` })
      .where('id', '=', id)
      .execute();
  }

  async incrementActorResolutionAttemptCount(id: string): Promise<number> {
    const row = await this.pgDb
      .updateTable('archive_event')
      .set({
        actor_resolution_attempt_count: sql`actor_resolution_attempt_count + 1`,
      })
      .where('id', '=', id)
      .returning('actor_resolution_attempt_count')
      .executeTakeFirstOrThrow();

    return Number(row.actor_resolution_attempt_count);
  }
}
