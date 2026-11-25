const HOLD_MS = Number(process.env['COMPOUND_MISSING_PROPOSAL_HOLD_MS'] ?? '60000');
const HOLD_MAX_MS = Number(process.env['COMPOUND_MISSING_PROPOSAL_HOLD_MAX_MS'] ?? '7200000');

export type MissingProposalDecision =
  | { action: 'hold'; until: Date; waitedMs: number }
  | { action: 'escalate'; waitedMs: number };

/**
 * How long a vote or lifecycle event waits for a parent proposal that is not derived yet. Bounded
 * on purpose: `markHeld` does not increment the attempt count, so an unbounded hold retries forever
 * without ever reaching the DLQ or a failure metric. `ProposalCreated` precedes both in block order
 * on one chain, so a parent still missing after the bound is an ingestion gap rather than ordering.
 * The default leaves the archive audit a couple of hourly ticks to restore it first.
 */
export function decideMissingProposalHold(
  receivedAt: Date,
  now: number = Date.now(),
): MissingProposalDecision {
  const waitedMs = now - receivedAt.getTime();
  if (waitedMs >= HOLD_MAX_MS) return { action: 'escalate', waitedMs };
  return { action: 'hold', until: new Date(now + HOLD_MS), waitedMs };
}
