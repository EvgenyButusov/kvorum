import { describe, expect, it } from 'vitest';
import { renderMetrics } from '@libs/observability';
import { buildArchiveAuditMetrics } from './metrics';

describe('Compound archive audit metrics', () => {
  it('initializes repair series, records lag and counts each repair without resetting on reinitialization', async () => {
    const metrics = buildArchiveAuditMetrics();
    const initial = (await renderMetrics())
      .split('\n')
      .filter((line) => line.startsWith('test_compound_archive_audit_events_repaired_total{'));
    expect(initial).toHaveLength(45);
    expect(initial.every((line) => /\}\s+0(?:\s|$)/.test(line))).toBe(true);

    metrics.recordArchiveAuditLag('compound_governor_oz', 42);
    metrics.recordArchiveRepair({
      source_type: 'compound_governor_oz',
      event_type: 'VoteCast',
      missing_store: 'both',
    });
    buildArchiveAuditMetrics();
    const lines = (await renderMetrics()).split('\n');
    const repairs = lines.filter((line) =>
      line.startsWith('test_compound_archive_audit_events_repaired_total{'),
    );
    expect(repairs).toHaveLength(45);
    expect(repairs.filter((line) => /\}\s+1(?:\s|$)/.test(line))).toHaveLength(1);
    expect(repairs.find((line) => /\}\s+1(?:\s|$)/.test(line))).toContain(
      'source_type="compound_governor_oz",event_type="VoteCast",missing_store="both"',
    );
    expect(
      lines.find((line) => line.startsWith('test_compound_archive_audit_lag_blocks{')),
    ).toMatch(/source_type="compound_governor_oz".*\} 42(?:\s|$)/);
  });
});
