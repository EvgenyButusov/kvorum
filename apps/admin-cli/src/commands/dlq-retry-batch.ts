import type { IngestionDlq } from '@libs/db';

export interface DlqBatchRetrier {
  retry(row: IngestionDlq): Promise<{ reason: string }>;
  markSucceeded(id: string, reason: string): Promise<void>;
}

export interface DlqBatchResult {
  retried: string[];
  stoppedAt?: { id: string; message: string };
}

/**
 * Re-drives DLQ rows oldest first, stopping at the first failure.
 *
 * A stage fails in bulk when its dependency is still down, so continuing would
 * re-dead-letter the remainder and bury the one error worth reading.
 */
export async function retryDlqBatch(
  rows: readonly IngestionDlq[],
  retrier: DlqBatchRetrier,
): Promise<DlqBatchResult> {
  const retried: string[] = [];

  for (const row of rows) {
    try {
      const outcome = await retrier.retry(row);
      await retrier.markSucceeded(row.id, outcome.reason);
      retried.push(row.id);
    } catch (error) {
      return {
        retried,
        stoppedAt: {
          id: row.id,
          message: error instanceof Error ? error.message : 'unknown error',
        },
      };
    }
  }

  return { retried };
}

export class DlqBatchStopped extends Error {
  constructor(readonly result: DlqBatchResult) {
    super(`dlq retry-batch stopped at ${result.stoppedAt?.id ?? 'unknown'}`);
    this.name = 'DlqBatchStopped';
  }
}
