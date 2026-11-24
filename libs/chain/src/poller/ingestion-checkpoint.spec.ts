import { describe, expect, it, vi } from 'vitest';
import { EventPoller } from './event-poller.js';
import { BackfillRangeFetcher } from '../backfill/range-fetcher.js';
import type { RpcClient } from '../client/rpc-client.js';
import { silentLogger } from '../logger.js';

const address = '0x' + 'ab'.repeat(20);
const valid = {
  address,
  blockNumber: '0x3e9',
  blockHash: '0x' + 'cd'.repeat(32),
  transactionHash: '0x' + 'ef'.repeat(32),
  transactionIndex: '0x0',
  logIndex: '0x0',
  topics: [],
  data: '0x',
  removed: false,
};
const malformed = { ...valid, blockNumber: null };
const base = {
  filter: { address },
  sourceType: 'compound_governor_oz',
  chainId: '0x1',
  logger: silentLogger,
};
function rpc(logs: unknown[]): RpcClient {
  return {
    send: vi
      .fn()
      .mockImplementation(async (method: string) =>
        method === 'eth_blockNumber' ? '0x400' : logs,
      ),
    getHealth: () => ({ chainId: '0x1', providers: [] }),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

describe('ingestion checkpoints without a network server', () => {
  it('does not advance live ingestion on malformed logs; retries the range on restart', async () => {
    let cursor = 1000n;
    const store = {
      read: async () => cursor,
      write: async (block: bigint) => {
        cursor = block;
      },
    };
    const listener = vi.fn();
    const first = new EventPoller({
      ...base,
      daoSourceLabel: 'test',
      chainName: 'test',
      headLag: 12,
      pollIntervalMs: 10000,
      cursor: store,
      rpcClient: rpc([valid, malformed]),
    });
    first.onEvents(listener);
    await first.start();
    await first.stop();
    expect(cursor).toBe(1000n);
    expect(listener).not.toHaveBeenCalled();
    const second = new EventPoller({
      ...base,
      daoSourceLabel: 'test',
      chainName: 'test',
      headLag: 12,
      pollIntervalMs: 10000,
      cursor: store,
      rpcClient: rpc([valid]),
    });
    second.onEvents(listener);
    await second.start();
    await second.stop();
    expect(cursor).toBe(1012n);
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it('does not checkpoint a malformed backfill range', async () => {
    const onChunkComplete = vi.fn();
    const listener = vi.fn();
    const fetcher = new BackfillRangeFetcher({
      ...base,
      sourceLabel: 'test',
      fromBlock: 1001n,
      toBlock: 1012n,
      rpcClient: rpc([valid, malformed]),
      onChunkComplete,
      listener,
    });
    await expect(fetcher.run()).rejects.toThrow();
    expect(listener).not.toHaveBeenCalled();
    expect(onChunkComplete).not.toHaveBeenCalled();
  });
});
