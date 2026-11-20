import { describe, expect, it, vi } from 'vitest';
import { retitleEasyTrackMotions } from './retitle';

const LABELLED = '0xfebd8fac16de88206d4b18764e826af38546afe0';
const UNLABELLED = `0x${'ab'.repeat(20)}`;

function mockDb(rows: Record<string, unknown>[]) {
  const select: Record<string, unknown> = {};
  for (const m of ['innerJoin', 'select', 'where', 'orderBy']) select[m] = vi.fn(() => select);
  select['execute'] = vi.fn().mockResolvedValue(rows);

  const update: Record<string, unknown> = {};
  const set = vi.fn(() => update);
  update['set'] = set;
  update['where'] = vi.fn(() => update);
  update['execute'] = vi.fn().mockResolvedValue(undefined);

  return {
    db: {
      selectFrom: vi.fn(() => select),
      updateTable: vi.fn(() => update),
    } as never,
    set,
  };
}

describe('retitleEasyTrackMotions', () => {
  it('retitles a motion whose factory has a label', async () => {
    const { db, set } = mockDb([
      { id: 'p1', source_id: '7', title: 'Easy Track motion #7', factory_address: LABELLED },
    ]);

    const result = await retitleEasyTrackMotions(db, {
      sourceType: 'lido_easy_track',
      dryRun: false,
    });

    expect(set).toHaveBeenCalledWith({ title: 'Increase node operator staking limit #7' });
    expect(result).toMatchObject({ scanned: 1, updated: 1, unchanged: 0, unlabelled: 0 });
    expect(result.samples[0]).toEqual({
      sourceId: '7',
      from: 'Easy Track motion #7',
      to: 'Increase node operator staking limit #7',
    });
  });

  it('leaves an unlabelled factory on the placeholder', async () => {
    const { db, set } = mockDb([
      { id: 'p1', source_id: '7', title: 'Easy Track motion #7', factory_address: UNLABELLED },
    ]);

    const result = await retitleEasyTrackMotions(db, {
      sourceType: 'lido_easy_track',
      dryRun: false,
    });

    expect(set).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 0, unlabelled: 1 });
  });

  it('counts an already-correct title as unchanged and writes nothing', async () => {
    const { db, set } = mockDb([
      {
        id: 'p1',
        source_id: '7',
        title: 'Increase node operator staking limit #7',
        factory_address: LABELLED,
      },
    ]);

    const result = await retitleEasyTrackMotions(db, {
      sourceType: 'lido_easy_track',
      dryRun: false,
    });

    expect(set).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 0, unchanged: 1 });
  });

  it('reports what would change without writing on a dry run', async () => {
    const { db, set } = mockDb([
      { id: 'p1', source_id: '7', title: 'Easy Track motion #7', factory_address: LABELLED },
    ]);

    const result = await retitleEasyTrackMotions(db, {
      sourceType: 'lido_easy_track',
      dryRun: true,
    });

    expect(set).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 1 });
  });

  it('caps the reported samples', async () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({
      id: `p${i}`,
      source_id: String(i),
      title: null,
      factory_address: LABELLED,
    }));
    const { db } = mockDb(rows);

    const result = await retitleEasyTrackMotions(db, {
      sourceType: 'lido_easy_track',
      dryRun: true,
    });

    expect(result.updated).toBe(9);
    expect(result.samples).toHaveLength(5);
  });
});
