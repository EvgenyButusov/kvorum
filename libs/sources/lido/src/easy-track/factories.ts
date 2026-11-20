// Presentation-only motion-type labels for Easy Track motion factories, keyed by lowercase address.
// Never used to filter, validate or attribute a motion: the registered factory set is data the
// ingester reads from each `MotionCreated` (VERIFICATION.md records a 2026-06-28 snapshot of
// `getEVMScriptFactories()` and notes the set drifts), so an unlabelled factory must degrade to its
// address, the way an ERC-7730 consumer degrades without a descriptor.
//
// KNOWN-033: the 41 registered factories have no labels yet. Each entry needs the same on-chain
// evidence VERIFICATION.md requires of a pinned address, so they are added as they are verified
// rather than copied from a docs page.
const EASY_TRACK_FACTORY_LABELS = new Map<string, string>();

export function easyTrackFactoryLabel(factoryAddress: string): string | null {
  return EASY_TRACK_FACTORY_LABELS.get(factoryAddress.toLowerCase()) ?? null;
}
