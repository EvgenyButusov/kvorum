import {
  formatCompactNumber,
  formatDeadline,
  formatPower,
  formatProposalId,
  formatRelativeTime,
} from './format';

describe('formatDeadline', () => {
  const now = 1_000_000_000_000;
  it.each([
    [now + 3 * 86_400_000, 'ends in 3d'],
    [now + 2 * 3_600_000, 'ends in 2h'],
    [now - 14 * 86_400_000, 'ended 14d ago'],
    [now - 40 * 86_400_000, 'ended 1mo ago'],
  ] as const)('formats %s', (t, expected) => {
    expect(formatDeadline(t, now)).toBe(expected);
  });

  it('is null-safe', () => {
    expect(formatDeadline(null)).toBeNull();
    expect(formatDeadline('not-a-date')).toBeNull();
  });
});

describe('formatRelativeTime', () => {
  const now = 1_000_000_000_000;
  it.each([
    [now, 'just now'],
    [now - 30_000, '30s ago'],
    [now - 5 * 60_000, '5m ago'],
    [now - 3 * 3_600_000, '3h ago'],
    [now - 2 * 86_400_000, '2d ago'],
  ] as const)('formats a delta to %s', (t, expected) => {
    expect(formatRelativeTime(t, now)).toBe(expected);
  });
});

describe('formatCompactNumber / formatPower', () => {
  it('compacts large numbers to M/B', () => {
    expect(formatCompactNumber(1_234_567)).toBe('1.2M');
    expect(formatCompactNumber(3_400_000_000)).toBe('3.4B');
  });

  it('appends the unit', () => {
    expect(formatPower(1_234_567, 'COMP')).toBe('1.2M COMP');
    expect(formatPower(500)).toBe('500');
  });
});

describe('formatProposalId', () => {
  it('prefixes a numeric id with #', () => {
    expect(formatProposalId('1219')).toBe('#1219');
    expect(formatProposalId('1')).toBe('#1');
  });

  it('shortens a snapshot content hash', () => {
    const id = `0x${'ab'.repeat(32)}`;
    expect(id).toHaveLength(66);
    expect(formatProposalId(id)).toBe('0xabab…abab');
    expect(formatProposalId(id)).toHaveLength(11);
  });

  it('leaves a short non-numeric id alone', () => {
    expect(formatProposalId('0xabc')).toBe('0xabc');
  });
});
