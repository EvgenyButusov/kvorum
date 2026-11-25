import { describe, expect, it } from 'vitest';
import { maxBigInt, minBigInt } from './bigint.js';

describe('bigint bounds', () => {
  it.each([
    [1n, 2n, 1n, 2n],
    [2n, 1n, 1n, 2n],
    [-2n, -1n, -2n, -1n],
    [0n, 0n, 0n, 0n],
    [9007199254740993n, 9007199254740992n, 9007199254740992n, 9007199254740993n],
  ])('preserves exact bounds for %s and %s', (a, b, minimum, maximum) => {
    expect(minBigInt(a, b)).toBe(minimum);
    expect(maxBigInt(a, b)).toBe(maximum);
  });
});
