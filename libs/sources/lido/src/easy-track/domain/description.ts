import type { ProposalActionInput } from '@libs/db';

export const EASY_TRACK_GENERATED_DESCRIPTION_PREFIX = 'This Easy Track motion';

export interface EasyTrackDescriptionAction {
  actionIndex: number;
  targetAddress: string;
  targetChainId: string;
  valueWei: string;
  functionSignature: string | null;
  decodedFunction: string | null;
  decodedArguments: unknown | null;
  calldata: string;
}

export interface EasyTrackDescriptionInput {
  factoryAddress: string;
  actions: readonly EasyTrackDescriptionAction[];
}

/**
 * Build a factual, deterministic description from the motion's execution payload. Easy Track does
 * not publish a human-authored body, so this deliberately describes only data Kvorum can prove from
 * the MotionCreated event and its decoded proposal actions.
 */
export function buildEasyTrackDescription(input: EasyTrackDescriptionInput): string {
  const factory = inlineCode(input.factoryAddress.toLowerCase());
  const actions = [...input.actions].sort((a, b) => a.actionIndex - b.actionIndex);

  if (actions.length === 0) {
    return `${EASY_TRACK_GENERATED_DESCRIPTION_PREFIX} was created through factory ${factory}. No executable calls could be decoded from its EVMScript.`;
  }

  const noun = actions.length === 1 ? 'action' : 'actions';
  const lines = [
    `${EASY_TRACK_GENERATED_DESCRIPTION_PREFIX} executes ${actions.length} on-chain ${noun} through factory ${factory}.`,
    '',
  ];

  for (const [position, action] of actions.entries()) {
    const callable =
      action.decodedFunction ?? action.functionSignature ?? selectorLabel(action.calldata);
    lines.push(
      `${position + 1}. Call ${inlineCode(callable)} on ${inlineCode(action.targetAddress.toLowerCase())} (chain ${inlineCode(action.targetChainId)}).`,
    );

    if (action.valueWei !== '0') {
      lines.push(`   - Value: ${inlineCode(`${action.valueWei} wei`)}`);
    }
    for (const [name, value] of argumentEntries(action.decodedArguments)) {
      lines.push(`   - ${inlineCode(name)}: ${inlineCode(formatArgument(value))}`);
    }
  }

  return lines.join('\n');
}

export function proposalActionInputsForDescription(
  actions: readonly ProposalActionInput[],
): EasyTrackDescriptionAction[] {
  return actions.map((action, actionIndex) => ({
    actionIndex,
    targetAddress: action.targetAddress,
    targetChainId: action.targetChainId,
    valueWei: action.valueWei,
    functionSignature: action.functionSignature,
    decodedFunction: null,
    decodedArguments: null,
    calldata: action.calldata,
  }));
}

function selectorLabel(calldata: string): string {
  return calldata.length >= 10 ? `selector ${calldata.slice(0, 10).toLowerCase()}` : 'raw call';
}

function argumentEntries(value: unknown | null): [string, unknown][] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>);
}

function formatArgument(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined) return 'undefined';
  const json = JSON.stringify(value, (_key, nested) =>
    typeof nested === 'bigint' ? nested.toString() : nested,
  );
  return json ?? String(value);
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll('`', "'").replaceAll('\n', ' ')}\``;
}
