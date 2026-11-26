const BASE_MS = Number(process.env['AAVE_STITCH_HOLD_BACKOFF_MS'] ?? '60000');
const MAX_MS = Number(process.env['AAVE_STITCH_HOLD_MAX_BACKOFF_MS'] ?? '21600000');
const SETTLED_MS = Number(process.env['AAVE_STITCH_HOLD_SETTLED_MS'] ?? '3600000');

/**
 * How long a payload awaiting its governance declaration steps aside for (KNOWN-028).
 *
 * ADR-0065 makes this hold indefinite on purpose — a cross-chain declaration can arrive at a higher
 * block than the payload, and orphaning it would be wrong — so this backs off the retry rather than
 * ending it. Without the backoff a permanently unmatched row rewrote its hold every 60 seconds for
 * four months (#686). The re-drive path ADR-0065 requires is preserved: every row is still retried,
 * just no more often than `MAX_MS` once its wait has passed bridge latency.
 */
export function decideStitchHold(receivedAt: Date, now: number = Date.now()): Date {
  const waitedMs = now - receivedAt.getTime();
  if (waitedMs < SETTLED_MS) return new Date(now + BASE_MS);

  const steps = Math.floor(waitedMs / SETTLED_MS);
  const backoffMs = Math.min(BASE_MS * 2 ** Math.min(steps, 30), MAX_MS);
  return new Date(now + backoffMs);
}
