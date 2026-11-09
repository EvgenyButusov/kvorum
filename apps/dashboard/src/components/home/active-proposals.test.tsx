import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { ActiveProposals } from './active-proposals';
import type { ProposalListItemView } from '@/lib/proposals/list';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock('../../lib/api/client', () => ({
  browserApi: {
    GET: apiGet.mockResolvedValue({
      data: { data: null },
      response: { status: 304, headers: new Headers() },
    }),
  },
}));

function item(id: string, title: string): ProposalListItemView {
  return {
    daoSlug: 'lido',
    sourceType: 'snapshot',
    sourceId: id,
    title,
    state: 'active',
    binding: true,
    votingStartsAt: null,
    votingEndsAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    proposer: { address: '0xabc', displayName: null },
    href: `/daos/lido/proposals/snapshot/${id}`,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('ActiveProposals', () => {
  it('renders the SSR-seeded cards with a live freshness indicator', () => {
    render(<ActiveProposals initialItems={[item('1', 'First'), item('2', 'Second')]} />, {
      wrapper,
    });
    expect(screen.getByRole('heading', { name: /Active proposals/ })).toBeInTheDocument();
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/Updated/);
  });

  it('shows an empty state when nothing is active', () => {
    render(<ActiveProposals initialItems={[]} />, { wrapper });
    expect(screen.getByText(/No proposals are currently active/)).toBeInTheDocument();
  });

  it('fetches immediately when the server-side seed was unavailable', async () => {
    apiGet.mockClear();
    apiGet.mockRejectedValueOnce(new Error('temporary failure'));

    render(<ActiveProposals initialItems={null} />, { wrapper });

    expect(await screen.findByText(/temporarily unavailable/)).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/No proposals are currently active/)).not.toBeInTheDocument();
  });
});
