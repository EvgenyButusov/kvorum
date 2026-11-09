import { describe, expect, it } from 'vitest';
import { buildEasyTrackDescription, proposalActionInputsForDescription } from './description';

const FACTORY = '0x' + 'AA'.repeat(20);
const TARGET = '0x' + 'BB'.repeat(20);

describe('buildEasyTrackDescription', () => {
  it('renders decoded calls and arguments in execution order', () => {
    const description = buildEasyTrackDescription({
      factoryAddress: FACTORY,
      actions: [
        {
          actionIndex: 1,
          targetAddress: TARGET,
          targetChainId: '0x1',
          valueWei: '0',
          functionSignature: null,
          decodedFunction: 'newImmediatePayment(address,address,uint256,string)',
          decodedArguments: {
            _amount: '1700000000000',
            _reference: 'Easy Track: top up recipient',
          },
          calldata: '0x12345678',
        },
        {
          actionIndex: 0,
          targetAddress: '0x' + 'CC'.repeat(20),
          targetChainId: '0x1',
          valueWei: '10',
          functionSignature: 'updateSpentAmount(uint256)',
          decodedFunction: null,
          decodedArguments: null,
          calldata: '0xabcdef01',
        },
      ],
    });

    expect(description).toContain('executes 2 on-chain actions');
    expect(description).toContain(FACTORY.toLowerCase());
    expect(description.indexOf('updateSpentAmount(uint256)')).toBeLessThan(
      description.indexOf('newImmediatePayment(address,address,uint256,string)'),
    );
    expect(description).toContain('`10 wei`');
    expect(description).toContain('`_reference`: `Easy Track: top up recipient`');
  });

  it('uses a selector fallback for an action that has not been ABI-decoded yet', () => {
    const [action] = proposalActionInputsForDescription([
      {
        targetAddress: TARGET,
        targetChainId: '0x1',
        valueWei: '0',
        functionSignature: null,
        calldata: '0xA9059CBB' + '00'.repeat(32),
      },
    ]);

    const description = buildEasyTrackDescription({ factoryAddress: FACTORY, actions: [action!] });
    expect(description).toContain('`selector 0xa9059cbb`');
  });

  it('explains when the EVMScript has no decodable calls', () => {
    expect(buildEasyTrackDescription({ factoryAddress: FACTORY, actions: [] })).toBe(
      `This Easy Track motion was created through factory \`${FACTORY.toLowerCase()}\`. No executable calls could be decoded from its EVMScript.`,
    );
  });

  it('formats JSON-safe argument values and sanitizes inline code', () => {
    const description = buildEasyTrackDescription({
      factoryAddress: FACTORY,
      actions: [
        {
          actionIndex: 0,
          targetAddress: TARGET,
          targetChainId: '0x1',
          valueWei: '0',
          functionSignature: null,
          decodedFunction: 'describe(string)',
          decodedArguments: {
            bigint: 42n,
            missing: undefined,
            nested: { amount: 7n },
            reference: 'line one`\nline two',
            symbol: Symbol('reference'),
          },
          calldata: '0x12345678',
        },
        {
          actionIndex: 1,
          targetAddress: TARGET,
          targetChainId: '0x1',
          valueWei: '0',
          functionSignature: null,
          decodedFunction: 'arrayArguments()',
          decodedArguments: ['ignored'],
          calldata: '0x12345678',
        },
        {
          actionIndex: 2,
          targetAddress: TARGET,
          targetChainId: '0x1',
          valueWei: '0',
          functionSignature: null,
          decodedFunction: 'scalarArguments()',
          decodedArguments: 7,
          calldata: '0x12345678',
        },
      ],
    });

    expect(description).toContain('`bigint`: `42`');
    expect(description).toContain('`missing`: `undefined`');
    expect(description).toContain('`nested`: `{"amount":"7"}`');
    expect(description).toContain("`reference`: `line one' line two`");
    expect(description).toContain('`symbol`: `Symbol(reference)`');
    expect(description).not.toContain('`0`: `ignored`');
  });
});
