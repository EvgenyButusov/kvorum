import { describe, expect, it } from 'vitest';
import { buildEasyTrackMotionSummary, type EasyTrackMotionSummaryAction } from './motion-summary';

const FACTORY = '0x' + '11'.repeat(20);
const TARGET = '0x' + '22'.repeat(20);

function action(
  overrides: Partial<EasyTrackMotionSummaryAction> = {},
): EasyTrackMotionSummaryAction {
  return {
    payloadIndex: 0,
    actionIndex: 0,
    targetAddress: TARGET,
    targetChainId: '0x1',
    valueWei: '0',
    functionSignature: null,
    decodedFunction: null,
    decodedArguments: null,
    calldata: '0xa9059cbb' + '0'.repeat(128),
    ...overrides,
  };
}

describe('buildEasyTrackMotionSummary', () => {
  it('names the factory label when the registry has one', () => {
    const summary = buildEasyTrackMotionSummary({
      factoryAddress: FACTORY,
      factoryLabel: 'Top up reWARDS recipients',
      actions: [action()],
    });

    expect(summary).toContain('Top up reWARDS recipients — executes 1 on-chain action.');
    expect(summary).not.toContain(FACTORY.toLowerCase());
  });

  it('falls back to the factory address when no label is registered', () => {
    const summary = buildEasyTrackMotionSummary({
      factoryAddress: FACTORY,
      factoryLabel: null,
      actions: [action(), action({ actionIndex: 1 })],
    });

    expect(summary).toContain(`\`${FACTORY.toLowerCase()}\` — executes 2 on-chain actions.`);
  });

  it('states plainly when nothing could be decoded', () => {
    const summary = buildEasyTrackMotionSummary({
      factoryAddress: FACTORY,
      factoryLabel: null,
      actions: [],
    });

    expect(summary).toBe(
      `Created through \`${FACTORY.toLowerCase()}\`. No executable calls could be decoded from its EVMScript.`,
    );
  });

  it('prefers the decoded function, then the signature, then the selector', () => {
    const summary = buildEasyTrackMotionSummary({
      factoryAddress: FACTORY,
      factoryLabel: null,
      actions: [
        action({ actionIndex: 0, decodedFunction: 'topUp(uint256)' }),
        action({ actionIndex: 1, functionSignature: 'transfer(address,uint256)' }),
        action({ actionIndex: 2 }),
      ],
    });

    expect(summary).toContain('1. Call `topUp(uint256)`');
    expect(summary).toContain('2. Call `transfer(address,uint256)`');
    expect(summary).toContain('3. Call `selector 0xa9059cbb`');
  });

  it('labels a calldata too short to carry a selector as a raw call', () => {
    const summary = buildEasyTrackMotionSummary({
      factoryAddress: FACTORY,
      factoryLabel: null,
      actions: [action({ calldata: '0xabcdef' })],
    });

    expect(summary).toContain('Call `raw call`');
  });

  it('renders a non-zero value and skips a zero one', () => {
    const withValue = buildEasyTrackMotionSummary({
      factoryAddress: FACTORY,
      factoryLabel: null,
      actions: [action({ valueWei: '1000000000000000000' })],
    });
    const withoutValue = buildEasyTrackMotionSummary({
      factoryAddress: FACTORY,
      factoryLabel: null,
      actions: [action()],
    });

    expect(withValue).toContain('- Value: `1000000000000000000 wei`');
    expect(withoutValue).not.toContain('Value:');
  });

  it('orders by payload before action index, so two payloads never interleave', () => {
    const summary = buildEasyTrackMotionSummary({
      factoryAddress: FACTORY,
      factoryLabel: null,
      actions: [
        action({ payloadIndex: 1, actionIndex: 0, decodedFunction: 'third()' }),
        action({ payloadIndex: 0, actionIndex: 1, decodedFunction: 'second()' }),
        action({ payloadIndex: 0, actionIndex: 0, decodedFunction: 'first()' }),
      ],
    });

    expect(summary).toContain('1. Call `first()`');
    expect(summary).toContain('2. Call `second()`');
    expect(summary).toContain('3. Call `third()`');
  });

  it('elides arguments past the cap instead of growing without bound', () => {
    const decodedArguments = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`arg${i}`, String(i)]),
    );
    const summary = buildEasyTrackMotionSummary({
      factoryAddress: FACTORY,
      factoryLabel: null,
      actions: [action({ decodedFunction: 'many()', decodedArguments })],
    });

    expect(summary).toContain('- `arg7`: `7`');
    expect(summary).not.toContain('`arg8`');
    expect(summary).toContain('- … 3 further arguments');
  });

  it('truncates an oversized argument value', () => {
    const summary = buildEasyTrackMotionSummary({
      factoryAddress: FACTORY,
      factoryLabel: null,
      actions: [action({ decodedArguments: { blob: 'x'.repeat(500) } })],
    });

    expect(summary).toContain(`\`${'x'.repeat(200)}…\``);
  });

  it('serialises structured and bigint arguments', () => {
    const summary = buildEasyTrackMotionSummary({
      factoryAddress: FACTORY,
      factoryLabel: null,
      actions: [
        action({
          decodedArguments: { recipients: [TARGET], amount: 10n, nested: { ok: true } },
        }),
      ],
    });

    expect(summary).toContain(`- \`recipients\`: \`["${TARGET}"]\``);
    expect(summary).toContain('- `amount`: `10`');
    expect(summary).toContain('- `nested`: `{"ok":true}`');
  });

  it('ignores a non-object decoded-arguments payload', () => {
    const summary = buildEasyTrackMotionSummary({
      factoryAddress: FACTORY,
      factoryLabel: null,
      actions: [action({ decodedArguments: ['positional'] })],
    });

    expect(summary).not.toContain('positional');
  });

  it('neutralises backticks and newlines so one argument cannot break out of the code span', () => {
    const summary = buildEasyTrackMotionSummary({
      factoryAddress: FACTORY,
      factoryLabel: null,
      actions: [action({ decodedArguments: { note: 'a`b\nc' } })],
    });

    expect(summary).toContain("- `note`: `a'b c`");
  });
});
