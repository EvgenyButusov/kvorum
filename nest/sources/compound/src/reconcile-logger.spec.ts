import { describe, it, expect, vi } from 'vitest';
import { createReconcileLogger } from './reconcile-logger';

describe('createReconcileLogger', () => {
  it('emits repair details as a single JSON log record', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let output: string;
    try {
      createReconcileLogger().info('compound_archive_event_repaired', {
        proposal_id: '615',
        missing_store: 'both',
        log_index: 0,
      });
      expect(write).toHaveBeenCalledTimes(1);
      output = String(write.mock.calls[0]?.[0]);
    } finally {
      write.mockRestore();
    }
    expect(JSON.parse(output)).toMatchObject({
      context: 'CompoundReconcile',
      message: {
        event: 'compound_archive_event_repaired',
        proposal_id: '615',
        missing_store: 'both',
        log_index: 0,
      },
    });
  });
});
