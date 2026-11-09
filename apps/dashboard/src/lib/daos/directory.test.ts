import { loadDaoDirectory } from './directory';

describe('loadDaoDirectory', () => {
  it('loads Lido as a publicly available DAO with its governance tracks and metrics', async () => {
    const GET = vi.fn(async (path: string) => {
      switch (path) {
        case '/v1/daos':
          return {
            data: {
              data: [
                {
                  slug: 'lido',
                  name: 'Lido',
                  description: 'Lido governance',
                  website_url: 'https://lido.fi',
                  forum_url: 'https://research.lido.fi',
                },
              ],
            },
          };
        case '/v1/daos/{slug}/sources':
          return {
            data: {
              data: [
                { source_type: 'aragon_voting' },
                { source_type: 'dual_governance' },
                { source_type: 'easy_track' },
                { source_type: 'snapshot' },
              ],
            },
          };
        case '/v1/daos/{slug}/analytics/proposal-pass-rate':
        case '/v1/daos/{slug}/analytics/concentration':
          return { data: { data: [] } };
        default:
          throw new Error(`Unexpected API path: ${path}`);
      }
    });

    const result = await loadDaoDirectory({ GET } as never, Date.UTC(2026, 10, 9));

    expect(result).toEqual([
      {
        slug: 'lido',
        name: 'Lido',
        description: 'Lido governance',
        websiteUrl: 'https://lido.fi',
        forumUrl: 'https://research.lido.fi',
        governors: ['Aragon voting', 'Dual governance', 'Easy Track', 'Snapshot'],
        passRatePct: null,
        top10Pct: null,
        top10Delta: null,
        comingSoon: false,
      },
    ]);
    expect(GET).toHaveBeenCalledWith('/v1/daos/{slug}/sources', {
      params: { path: { slug: 'lido' } },
    });
  });
});
