import { easyTrackFactoryLabel } from '../factories';

// Easy Track title rule (ADR-030, ADR-076). Motion events carry no human title, so the title is
// composed from the motion factory's type label plus the motion id. The label is also the highest-
// weighted term in `proposal.search_vector`, which is why it is stored rather than derived on read.
// An unlabelled factory keeps the bare placeholder, mirroring the Aragon `Lido Vote #{id}` fallback.
export function easyTrackMotionTitle(motionId: string, factoryAddress?: string): string {
  const label = factoryAddress == null ? null : easyTrackFactoryLabel(factoryAddress);
  return label == null ? `Easy Track motion #${motionId}` : `${label} #${motionId}`;
}
