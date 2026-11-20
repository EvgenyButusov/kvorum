import { describe, expect, it } from 'vitest';
import { easyTrackFactoryLabel } from './factories';

// The factory carried by the real MotionCreated fixture (motion 1049).
const FIXTURE_FACTORY = '0xfebd8fac16de88206d4b18764e826af38546afe0';

describe('easyTrackFactoryLabel', () => {
  it('labels a registered factory with its motion type', () => {
    expect(easyTrackFactoryLabel(FIXTURE_FACTORY)).toBe('Increase node operator staking limit');
  });

  it('is case-insensitive about the address', () => {
    expect(easyTrackFactoryLabel(FIXTURE_FACTORY.toUpperCase().replace('0X', '0x'))).toBe(
      easyTrackFactoryLabel(FIXTURE_FACTORY),
    );
  });

  it('labels a factory registered after the first snapshot', () => {
    expect(easyTrackFactoryLabel('0x2fc78638b77381e9d040163bd6eb1cac967bdbdf')).toBe(
      'Create or update operator group',
    );
  });

  it('keeps labelling a deregistered factory, whose motions remain', () => {
    expect(easyTrackFactoryLabel('0xf6b6e7997338c48ea3a8bcfa4bb64a315fda76f4')).toBe(
      'Settle CSM EL stealing penalty',
    );
  });

  it('returns null for a factory outside the snapshot', () => {
    expect(easyTrackFactoryLabel(`0x${'ab'.repeat(20)}`)).toBeNull();
  });

  it('never inherits a label from Object.prototype', () => {
    expect(easyTrackFactoryLabel('toString')).toBeNull();
    expect(easyTrackFactoryLabel('constructor')).toBeNull();
  });
});
