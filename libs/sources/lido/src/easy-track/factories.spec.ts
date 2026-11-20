import { describe, expect, it } from 'vitest';
import { easyTrackFactoryLabel } from './factories';

describe('easyTrackFactoryLabel', () => {
  it('returns null for a factory with no registered label', () => {
    expect(easyTrackFactoryLabel('0xfebd8fac16de88206d4b18764e826af38546afe0')).toBeNull();
  });

  it('is case-insensitive about the address', () => {
    const checksummed = '0xFEBD8FAC16DE88206D4B18764E826AF38546AFE0';
    expect(easyTrackFactoryLabel(checksummed)).toBe(
      easyTrackFactoryLabel(checksummed.toLowerCase()),
    );
  });

  it('never inherits a label from Object.prototype', () => {
    expect(easyTrackFactoryLabel('toString')).toBeNull();
    expect(easyTrackFactoryLabel('constructor')).toBeNull();
  });
});
