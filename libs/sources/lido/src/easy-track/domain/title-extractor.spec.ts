import { describe, expect, it } from 'vitest';
import { easyTrackMotionTitle } from './title-extractor';

const LABELLED_FACTORY = '0xfebd8fac16de88206d4b18764e826af38546afe0';

describe('easyTrackMotionTitle', () => {
  it('names the motion type when the factory has a label', () => {
    expect(easyTrackMotionTitle('42', LABELLED_FACTORY)).toBe(
      'Increase node operator staking limit #42',
    );
  });

  it('is case-insensitive about the factory address', () => {
    expect(easyTrackMotionTitle('42', LABELLED_FACTORY.toUpperCase().replace('0X', '0x'))).toBe(
      easyTrackMotionTitle('42', LABELLED_FACTORY),
    );
  });

  it('falls back to the placeholder for an unlabelled factory', () => {
    expect(easyTrackMotionTitle('42', `0x${'ab'.repeat(20)}`)).toBe('Easy Track motion #42');
  });

  it('falls back to the placeholder when no factory is given', () => {
    expect(easyTrackMotionTitle('42')).toBe('Easy Track motion #42');
    expect(easyTrackMotionTitle('1')).toBe('Easy Track motion #1');
  });
});
