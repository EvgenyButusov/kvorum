import type { Metadata } from 'next';
import { unstable_cache } from 'next/cache';

import { ActiveProposals } from '@/components/home/active-proposals';
import { ActivityFeed } from '@/components/home/activity-feed';
import { DaoHealthCards } from '@/components/home/dao-health-cards';
// MismatchFlags (§6.4 §3) is unmounted until the homepage AI feed is built — see issue #608. The
// feed needs a proposal-keyed AI projection; the component is kept for when that lands.
import { StatsBar } from '@/components/home/stats-bar';
import { PageContainer } from '@/components/shell/page-container';
import { serverApi } from '@/lib/api/client';
import { COMING_SOON_SLUGS } from '@/lib/daos/directory';
import { normalizeListItem, type ProposalListItemView } from '@/lib/proposals/list';

export const metadata: Metadata = {
  alternates: { canonical: '/' },
  title: 'Kvorum — Governance intelligence for DeFi DAOs',
};

// The API is reachable only from the running cluster. Static prerendering runs during the image
// build, where API failures would otherwise be baked into the first production response as empty
// data. Render at runtime and cache only successful loader results below.
export const dynamic = 'force-dynamic';

async function loadDaos(): Promise<{ slug: string; name: string }[]> {
  const { data, error } = await serverApi().GET('/v1/daos', {
    params: { query: { limit: 100 } },
  });
  if (error || !data) throw new Error('DAO directory unavailable');
  return data.data.map((d) => ({ slug: d.slug, name: d.name }));
}

async function loadProposals(query: {
  state?: string;
  sort?: string;
  limit?: number;
}): Promise<ProposalListItemView[]> {
  const { data, error } = await serverApi().GET('/v1/proposals', { params: { query } });
  if (error || !data) throw new Error('Proposal feed unavailable');
  return data.data.map(normalizeListItem);
}

const loadCachedDaos = unstable_cache(loadDaos, ['dashboard-home-daos'], { revalidate: 30 });
const loadCachedActiveProposals = unstable_cache(
  () => loadProposals({ state: 'active', sort: 'voting_ends_at', limit: 12 }),
  ['dashboard-home-active-proposals'],
  { revalidate: 30 },
);
const loadCachedRecentProposals = unstable_cache(
  () => loadProposals({ sort: '-state_updated_at', limit: 15 }),
  ['dashboard-home-recent-proposals'],
  { revalidate: 30 },
);

async function availableOrNull<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch {
    // The cached function rejects, so Next does not retain a transient failure as empty data.
    return null;
  }
}

export default async function HomePage() {
  const [allDaos, active, recent] = await Promise.all([
    availableOrNull(loadCachedDaos),
    availableOrNull(loadCachedActiveProposals),
    availableOrNull(loadCachedRecentProposals),
  ]);
  const daos = allDaos?.filter((d) => !COMING_SOON_SLUGS.has(d.slug)) ?? null;

  return (
    <PageContainer className="flex flex-col gap-12">
      <StatsBar daoCount={daos?.length ?? null} />
      <ActiveProposals initialItems={active} />
      {/* <MismatchFlags /> — deferred until the homepage AI feed lands (issue #608). */}
      <DaoHealthCards daos={daos ?? []} />
      <ActivityFeed initialItems={recent} />
    </PageContainer>
  );
}
