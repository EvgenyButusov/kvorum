import { vi } from 'vitest';

import { loadDelegateLeaderboard } from './delegates';

describe('loadDelegateLeaderboard', () => {
  it('preserves the power-bearing model and scales voting power', async () => {
    const api = {
      GET: vi.fn().mockResolvedValue({
        data: {
          delegation_model: 'power-bearing',
          data: [
            {
              rank: 1,
              address: '0xabc',
              display_name: 'Delegate',
              voting_power: '1500000000000000000',
              voting_power_share: 0.25,
              delegator_count: 2,
            },
          ],
        },
      }),
    };

    await expect(loadDelegateLeaderboard(api as never, 'compound', 5)).resolves.toMatchObject({
      delegationModel: 'power-bearing',
      entries: [{ votingPower: 1.5, sharePct: 25 }],
    });
  });

  it('preserves null power for relationship-only delegates', async () => {
    const api = {
      GET: vi.fn().mockResolvedValue({
        data: {
          delegation_model: 'relationship-only',
          data: [
            {
              rank: 1,
              address: '0xabc',
              display_name: null,
              voting_power: null,
              voting_power_share: null,
              delegator_count: 42,
            },
          ],
        },
      }),
    };

    await expect(loadDelegateLeaderboard(api as never, 'lido', 5)).resolves.toMatchObject({
      delegationModel: 'relationship-only',
      entries: [{ votingPower: null, sharePct: null, delegatorCount: 42 }],
    });
  });
});
