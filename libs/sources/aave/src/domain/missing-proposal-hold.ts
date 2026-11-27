const HOLD_MS = Number(process.env['AAVE_MISSING_PROPOSAL_HOLD_MS'] ?? '60000');
const HOLD_MAX_MS = Number(process.env['AAVE_MISSING_PROPOSAL_HOLD_MAX_MS'] ?? '7200000');

export type MissingProposalDecision =
  | { action: 'hold'; until: Date; waitedMs: number }
  | { action: 'escalate'; waitedMs: number };

/**
 * How long a lifecycle event waits for a parent proposal that is not derived yet. A hold rather
 * than a counted failure because the projection ceiling parks a row permanently, and `markHeld`
 * leaves the count alone. Bounded: a parent still absent past the bound escalates and parks, so
 * this absorbs ordering within the bound, not an ingestion gap that outlasts it.
 */
export function decideMissingProposalHold(
  receivedAt: Date,
  now: number = Date.now(),
): MissingProposalDecision {
  const waitedMs = now - receivedAt.getTime();
  if (waitedMs >= HOLD_MAX_MS) return { action: 'escalate', waitedMs };
  return { action: 'hold', until: new Date(now + HOLD_MS), waitedMs };
}
