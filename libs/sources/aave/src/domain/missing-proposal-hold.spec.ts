import { describe, expect, it } from 'vitest';
import { decideMissingProposalHold } from './missing-proposal-hold';

const NOW = Date.parse('2026-11-27T12:00:00Z');
const TWO_HOURS = 2 * 60 * 60 * 1000;

describe('decideMissingProposalHold', () => {
  it('holds a freshly ingested row, scheduling the next attempt', () => {
    expect(decideMissingProposalHold(new Date(NOW - 1_000), NOW)).toEqual({
      action: 'hold',
      until: new Date(NOW + 60_000),
      waitedMs: 1_000,
    });
  });

  it('escalates once the row has waited past the bound', () => {
    expect(decideMissingProposalHold(new Date(NOW - TWO_HOURS), NOW)).toEqual({
      action: 'escalate',
      waitedMs: TWO_HOURS,
    });
  });

  it('still holds one millisecond short of the bound', () => {
    expect(decideMissingProposalHold(new Date(NOW - TWO_HOURS + 1), NOW).action).toBe('hold');
  });

  it('treats a row ingested in the future as freshly ingested rather than escalating', () => {
    expect(decideMissingProposalHold(new Date(NOW + 5_000), NOW).action).toBe('hold');
  });
});
