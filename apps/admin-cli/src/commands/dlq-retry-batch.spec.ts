import { describe, expect, it, vi } from 'vitest';
import type { IngestionDlq } from '@libs/db';
import { DlqBatchStopped, retryDlqBatch } from './dlq-retry-batch.js';

function row(id: string): IngestionDlq {
  return { id } as IngestionDlq;
}

describe('retryDlqBatch', () => {
  it('retries every row and resolves each one it retried', async () => {
    const retrier = {
      retry: vi.fn().mockResolvedValue({ reason: 'ok' }),
      markSucceeded: vi.fn().mockResolvedValue(undefined),
    };

    const result = await retryDlqBatch([row('a'), row('b'), row('c')], retrier);

    expect(result.retried).toEqual(['a', 'b', 'c']);
    expect(result.stoppedAt).toBeUndefined();
    expect(retrier.markSucceeded).toHaveBeenCalledTimes(3);
  });

  it('stops at the first failure instead of re-dead-lettering the remainder', async () => {
    const retrier = {
      retry: vi
        .fn()
        .mockResolvedValueOnce({ reason: 'ok' })
        .mockRejectedValueOnce(new Error('clickhouse refused the insert')),
      markSucceeded: vi.fn().mockResolvedValue(undefined),
    };

    const result = await retryDlqBatch([row('a'), row('b'), row('c')], retrier);

    expect(result.retried).toEqual(['a']);
    expect(result.stoppedAt).toEqual({ id: 'b', message: 'clickhouse refused the insert' });
    expect(retrier.retry).toHaveBeenCalledTimes(2);
  });

  it('does not count a row whose resolution failed after a successful retry', async () => {
    const retrier = {
      retry: vi.fn().mockResolvedValue({ reason: 'ok' }),
      markSucceeded: vi.fn().mockRejectedValue(new Error('pg unavailable')),
    };

    const result = await retryDlqBatch([row('a')], retrier);

    expect(result.retried).toEqual([]);
    expect(result.stoppedAt?.id).toBe('a');
  });

  it('carries the partial result through the error the audit wrapper sees', async () => {
    const stopped = new DlqBatchStopped({
      retried: ['a'],
      stoppedAt: { id: 'b', message: 'boom' },
    });

    expect(stopped.result.retried).toEqual(['a']);
    expect(stopped.message).toContain('b');
  });
});
