import { describe, expect, it } from 'vitest';
import { decideStitchHold } from './stitch-hold-policy';

const now = new Date('2026-11-26T12:00:00Z').getTime();

function waitedFor(ms: number): Date {
  return new Date(now - ms);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('decideStitchHold', () => {
  it('retries a fresh payload at the base interval, so bridge latency costs nothing', () => {
    expect(decideStitchHold(waitedFor(MINUTE), now).getTime()).toBe(now + MINUTE);
    expect(decideStitchHold(waitedFor(59 * MINUTE), now).getTime()).toBe(now + MINUTE);
  });

  it('backs off once the wait has passed plausible bridge latency', () => {
    expect(decideStitchHold(waitedFor(HOUR), now).getTime()).toBe(now + 2 * MINUTE);
    expect(decideStitchHold(waitedFor(3 * HOUR), now).getTime()).toBe(now + 8 * MINUTE);
  });

  it('caps the interval so a permanently unmatched row is still re-driven', () => {
    const fourMonths = 120 * 24 * HOUR;
    const until = decideStitchHold(waitedFor(fourMonths), now);

    expect(until.getTime()).toBe(now + 6 * HOUR);
    expect(until.getTime()).toBeGreaterThan(now);
  });

  it('never returns a hold in the past, however long the row has waited', () => {
    for (const waited of [0, MINUTE, HOUR, 500 * 24 * HOUR]) {
      expect(decideStitchHold(waitedFor(waited), now).getTime()).toBeGreaterThan(now);
    }
  });
});
