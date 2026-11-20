// Rendered at read time from the motion's `proposal_action` rows. Easy Track publishes no
// human-authored body, so `proposal.description` stays empty (SPEC §5.6 reserves it for proposer
// prose, which the mismatch detector audits against the calldata) and this derived summary is
// surfaced as its own labelled field.

/** Cap on rendered arguments per action; the rest are elided rather than inflating every API read. */
const MAX_RENDERED_ARGUMENTS = 8;
const MAX_ARGUMENT_LENGTH = 200;

export interface EasyTrackMotionSummaryAction {
  payloadIndex: number;
  actionIndex: number;
  targetAddress: string;
  targetChainId: string;
  valueWei: string;
  functionSignature: string | null;
  decodedFunction: string | null;
  decodedArguments: unknown | null;
  calldata: string;
}

export interface EasyTrackMotionSummaryInput {
  factoryAddress: string;
  /** Curated motion-type label for the factory; null when the factory is not in the registry. */
  factoryLabel: string | null;
  actions: readonly EasyTrackMotionSummaryAction[];
}

/**
 * Build a factual, deterministic summary of the motion's execution payload: only what is provable
 * from the `MotionCreated` event and the decoded proposal actions. An unlabelled factory degrades to
 * its address rather than guessing the motion's intent.
 */
export function buildEasyTrackMotionSummary(input: EasyTrackMotionSummaryInput): string {
  const factory = input.factoryLabel ?? inlineCode(input.factoryAddress.toLowerCase());
  const actions = [...input.actions].sort(byExecutionOrder);

  if (actions.length === 0) {
    return `Created through ${factory}. No executable calls could be decoded from its EVMScript.`;
  }

  const noun = actions.length === 1 ? 'action' : 'actions';
  const lines = [`${factory} — executes ${actions.length} on-chain ${noun}.`, ''];

  for (const [position, action] of actions.entries()) {
    const callable =
      action.decodedFunction ?? action.functionSignature ?? selectorLabel(action.calldata);
    lines.push(
      `${position + 1}. Call ${inlineCode(callable)} on ${inlineCode(action.targetAddress.toLowerCase())} (chain ${inlineCode(action.targetChainId)}).`,
    );

    if (action.valueWei !== '0') {
      lines.push(`   - Value: ${inlineCode(`${action.valueWei} wei`)}`);
    }
    const args = argumentEntries(action.decodedArguments);
    for (const [name, value] of args.slice(0, MAX_RENDERED_ARGUMENTS)) {
      lines.push(`   - ${inlineCode(name)}: ${inlineCode(formatArgument(value))}`);
    }
    if (args.length > MAX_RENDERED_ARGUMENTS) {
      lines.push(`   - … ${args.length - MAX_RENDERED_ARGUMENTS} further arguments`);
    }
  }

  return lines.join('\n');
}

// action_index restarts per payload, so payload order has to come first or two payloads interleave.
function byExecutionOrder(
  a: EasyTrackMotionSummaryAction,
  b: EasyTrackMotionSummaryAction,
): number {
  return a.payloadIndex - b.payloadIndex || a.actionIndex - b.actionIndex;
}

function selectorLabel(calldata: string): string {
  return calldata.length >= 10 ? `selector ${calldata.slice(0, 10).toLowerCase()}` : 'raw call';
}

function argumentEntries(value: unknown | null): [string, unknown][] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>);
}

function formatArgument(value: unknown): string {
  const rendered = renderArgument(value);
  return rendered.length > MAX_ARGUMENT_LENGTH
    ? `${rendered.slice(0, MAX_ARGUMENT_LENGTH)}…`
    : rendered;
}

function renderArgument(value: unknown): string {
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
