import { describe, expect, it, vi } from 'vitest';
import { CompoundArchiveReconciler } from './compound-archive-reconciler';
import { COMPOUND_GOVERNOR_OZ_INTERFACE } from '../abi/events';
import type { ArchiveIdentity } from '../persistence/compound-archive-reconcile-repository';

const address = '0x' + 'ab'.repeat(20);
const hash = '0x' + 'cd'.repeat(32);
const tx = '0x' + 'ef'.repeat(32);
const encoded = COMPOUND_GOVERNOR_OZ_INTERFACE.encodeEventLog('VoteCast', [
  address,
  615n,
  1,
  100n,
  '',
]);
const raw = {
  address,
  blockNumber: '0x3e9',
  blockHash: hash,
  transactionHash: tx,
  transactionIndex: '0x0',
  logIndex: '0x0',
  removed: false,
  ...encoded,
};
const identity: ArchiveIdentity = {
  block_number: '1001',
  block_hash: hash,
  tx_hash: tx,
  log_index: 0,
  event_type: 'VoteCast',
};

function setup() {
  const source = {
    id: 'source',
    governor_address: address,
    active_from_block: '1',
    active_to_block: null,
    poll_cursor_block: '1602',
    last_checked_block: '1000',
  };
  const repository = {
    findSource: vi.fn().mockResolvedValue(source),
    initialize: vi.fn().mockResolvedValue(undefined),
    advance: vi.fn().mockResolvedValue(true),
    readIdentities: vi.fn().mockResolvedValue({ pg: [identity], ch: [identity] }),
  };
  const writer = { writeCore: vi.fn().mockResolvedValue(undefined) };
  const recordRepair = vi.fn();
  const metrics = { recordOutcome: vi.fn(), recordArchiveRepair: recordRepair };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const client = {
    send: vi
      .fn()
      .mockImplementation(async (method: string) => (method === 'eth_getLogs' ? [raw] : { hash })),
  };
  const audit = new CompoundArchiveReconciler(
    { repository, writer, metrics, logger },
    'compound_governor_oz',
  );
  const run = (confirmedHead = 2000n) =>
    audit.onConfirmedHead({
      reconcileSourceId: 'reconcile',
      governorAddress: address,
      chainId: '0x1',
      confirmedHead,
      client,
    });
  return { repository, writer, metrics, logger, client, run, source, recordRepair };
}

describe('Compound archive reconciliation', () => {
  it.each([
    undefined,
    { poll_cursor_block: null },
    { active_from_block: null },
    { active_from_block: '1003' },
  ])('waits for an auditable source range: %j', async (override) => {
    const { repository, client, writer, run, source } = setup();
    repository.findSource.mockResolvedValue(override && { ...source, ...override });
    await run();
    expect(client.send).not.toHaveBeenCalled();
    expect(writer.writeCore).not.toHaveBeenCalled();
    expect(repository.advance).not.toHaveBeenCalled();
  });

  it('rejects a source whose governor differs from the configured reconciler', async () => {
    const { repository, client, run, source, metrics } = setup();
    repository.findSource.mockResolvedValue({ ...source, governor_address: tx });
    await run();
    expect(client.send).not.toHaveBeenCalled();
    expect(metrics.recordOutcome).toHaveBeenCalledWith({
      source_type: 'compound_governor_oz',
      outcome: 'archive_audit_failed',
    });
  });

  it('caps an audit at the retired source end block', async () => {
    const { repository, run, source } = setup();
    repository.findSource.mockResolvedValue({ ...source, active_to_block: '1001' });
    await run();
    expect(repository.advance).toHaveBeenCalledExactlyOnceWith('source', 1000n, 1001n);
  });

  it('waits when initialization does not yield a durable checkpoint', async () => {
    const { repository, run, source, client } = setup();
    repository.findSource.mockResolvedValue({ ...source, last_checked_block: null });
    await run();
    expect(repository.initialize).toHaveBeenCalledOnce();
    expect(client.send).not.toHaveBeenCalled();
    expect(repository.advance).not.toHaveBeenCalled();
  });

  it('does not overlap audits for the same source', async () => {
    const { repository, run } = setup();
    await Promise.all([run(), run()]);
    expect(repository.findSource).toHaveBeenCalledOnce();
    expect(repository.advance).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    [{ ...raw, removed: true }],
    [{ ...raw, address: '0x' + '12'.repeat(20) }],
    [{ ...raw, blockNumber: '0x3e8' }],
    [{ ...raw, blockNumber: '0x3eb' }],
  ])('rejects invalid or out-of-range RPC evidence: %j', async (response) => {
    const { client, repository, writer, run, recordRepair } = setup();
    client.send.mockResolvedValueOnce(response);
    await run();
    expect(repository.advance).not.toHaveBeenCalled();
    expect(writer.writeCore).not.toHaveBeenCalled();
    expect(recordRepair).not.toHaveBeenCalled();
  });

  it.each([
    { ...identity, event_type: 'ProposalExecuted' },
    { ...identity, block_number: '1002' },
  ])('rejects conflicting archive metadata: %j', async (conflict) => {
    const { repository, writer, run } = setup();
    repository.readIdentities.mockResolvedValue({ pg: [conflict], ch: [identity] });
    await run();
    expect(repository.advance).not.toHaveBeenCalled();
    expect(writer.writeCore).not.toHaveBeenCalled();
  });

  it('leaves noncanonical archive rows to the reorg pipeline', async () => {
    const { repository, client, writer, run } = setup();
    repository.readIdentities.mockResolvedValue({
      pg: [{ ...identity, block_hash: tx }],
      ch: [{ ...identity, block_hash: tx }],
    });
    client.send.mockResolvedValueOnce([]);
    await run();
    expect(writer.writeCore).not.toHaveBeenCalled();
    expect(repository.advance).toHaveBeenCalledWith('source', 1000n, 1002n);
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it('does not repair or checkpoint without a canonical block header', async () => {
    const { repository, client, writer, run } = setup();
    repository.readIdentities.mockResolvedValue({ pg: [], ch: [] });
    client.send.mockResolvedValueOnce([raw]).mockResolvedValueOnce({});
    await run();
    expect(writer.writeCore).not.toHaveBeenCalled();
    expect(repository.advance).not.toHaveBeenCalled();
  });

  it.each([
    { pg: [], ch: [] },
    { pg: [identity], ch: [] },
    { pg: [], ch: [identity] },
  ])('recovers missing vote in either archive: %j', async (existing) => {
    const { repository, writer, run, metrics, logger, recordRepair } = setup();
    repository.readIdentities.mockResolvedValueOnce(existing);
    await run();
    expect(writer.writeCore).toHaveBeenCalledWith(
      expect.objectContaining({ daoSourceId: 'source' }),
      expect.objectContaining({ type: 'VoteCast' }),
      expect.objectContaining({ blockNumber: 1001n }),
    );
    expect(repository.readIdentities).toHaveBeenCalledTimes(2);
    expect(repository.advance).toHaveBeenCalledWith('source', 1000n, 1002n);
    expect(metrics.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'archive_repaired' }),
    );
    const labels = {
      source_type: 'compound_governor_oz',
      event_type: 'VoteCast',
      missing_store: existing.pg.length ? 'clickhouse' : existing.ch.length ? 'postgres' : 'both',
    };
    expect(recordRepair).toHaveBeenCalledExactlyOnceWith(labels);
    expect(logger.info).toHaveBeenCalledWith(
      'compound_archive_event_repaired',
      expect.objectContaining({
        ...labels,
        proposal_id: '615',
        block: '1001',
        block_hash: hash,
        tx_hash: tx,
        log_index: 0,
        voter: address,
        voting_power: '100',
      }),
    );
  });
  it('leaves complete archives unchanged and advances only to the delayed live cursor', async () => {
    const { repository, writer, run, client, recordRepair } = setup();
    await run();
    expect(writer.writeCore).not.toHaveBeenCalled();
    expect(recordRepair).not.toHaveBeenCalled();
    expect(client.send).toHaveBeenCalledWith('eth_getLogs', [
      expect.objectContaining({ fromBlock: '0x3e9', toBlock: '0x3ea' }),
    ]);
    expect(repository.advance).toHaveBeenCalledWith('source', 1000n, 1002n);
  });
  it('restores a missing lifecycle event, not just votes', async () => {
    const { repository, client, writer, run } = setup();
    const execution = COMPOUND_GOVERNOR_OZ_INTERFACE.encodeEventLog('ProposalExecuted', [615n]);
    const executionIdentity = { ...identity, event_type: 'ProposalExecuted' };
    client.send.mockResolvedValueOnce([{ ...raw, ...execution }]);
    repository.readIdentities
      .mockResolvedValueOnce({ pg: [], ch: [] })
      .mockResolvedValueOnce({ pg: [executionIdentity], ch: [executionIdentity] });
    await run();
    expect(writer.writeCore).toHaveBeenCalledWith(
      expect.anything(),
      { type: 'ProposalExecuted', payload: { proposalId: '615' } },
      expect.anything(),
    );
    expect(repository.advance).toHaveBeenCalledWith('source', 1000n, 1002n);
  });
  it('does not checkpoint a repair that failed readback', async () => {
    const { repository, run, metrics, recordRepair, logger } = setup();
    repository.readIdentities.mockResolvedValue({ pg: [], ch: [] });
    await run();
    expect(repository.advance).not.toHaveBeenCalled();
    expect(recordRepair).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'compound_archive_repair_failed',
      expect.objectContaining({ tx_hash: tx, proposal_id: '615' }),
    );
    expect(metrics.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'archive_audit_failed' }),
    );
  });
  it('does not checkpoint if the provider omits a known canonical vote', async () => {
    const { repository, client, run, writer } = setup();
    client.send.mockResolvedValueOnce([]);
    await run();
    expect(repository.advance).not.toHaveBeenCalled();
    expect(writer.writeCore).not.toHaveBeenCalled();
  });
  it('does not write a log from a noncanonical block', async () => {
    const { repository, client, run, writer } = setup();
    repository.readIdentities.mockResolvedValue({ pg: [], ch: [] });
    client.send.mockResolvedValueOnce([raw]).mockResolvedValueOnce({ hash: tx });
    await run();
    expect(repository.advance).not.toHaveBeenCalled();
    expect(writer.writeCore).not.toHaveBeenCalled();
  });
  it('does not checkpoint malformed logs', async () => {
    const { repository, client, run } = setup();
    client.send.mockResolvedValueOnce([{ ...raw, blockNumber: null }]);
    await run();
    expect(repository.advance).not.toHaveBeenCalled();
  });
  it('retries a failed archive write without advancing the cursor', async () => {
    const { repository, writer, run } = setup();
    repository.readIdentities.mockResolvedValueOnce({ pg: [], ch: [] });
    writer.writeCore.mockRejectedValueOnce(new Error('archive unavailable'));
    await run();
    expect(repository.advance).not.toHaveBeenCalled();
  });
  it('counts verified repairs even when the next repair fails, and does not recount on retry', async () => {
    const { repository, client, writer, run, recordRepair } = setup();
    const second = { ...raw, logIndex: '0x1' };
    const secondIdentity = { ...identity, log_index: 1 };
    client.send.mockImplementation(async (method: string) =>
      method === 'eth_getLogs' ? [raw, second] : { hash },
    );
    repository.readIdentities.mockResolvedValueOnce({ pg: [], ch: [] });
    writer.writeCore
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('second write failed'));
    await run();
    expect(repository.advance).not.toHaveBeenCalled();
    expect(recordRepair).toHaveBeenCalledTimes(1);
    repository.readIdentities
      .mockResolvedValueOnce({ pg: [identity], ch: [identity] })
      .mockResolvedValueOnce({ pg: [identity, secondIdentity], ch: [identity, secondIdentity] });
    await run();
    expect(recordRepair).toHaveBeenCalledTimes(2);
    expect(repository.advance).toHaveBeenCalledWith('source', 1000n, 1002n);
  });
  it('counts verified repair before a failed checkpoint CAS', async () => {
    const { repository, run, recordRepair } = setup();
    repository.readIdentities.mockResolvedValueOnce({ pg: [], ch: [] });
    repository.advance.mockResolvedValue(false);
    await run();
    expect(recordRepair).toHaveBeenCalledTimes(1);
    await run();
    expect(recordRepair).toHaveBeenCalledTimes(1);
  });
  it('initializes within the source active range', async () => {
    const { repository, client, run, source } = setup();
    repository.findSource
      .mockResolvedValueOnce({ ...source, active_from_block: '100', last_checked_block: null })
      .mockResolvedValue({ ...source, active_from_block: '100', last_checked_block: '99' });
    repository.readIdentities.mockResolvedValue({ pg: [], ch: [] });
    client.send.mockResolvedValue([]);
    await run();
    expect(repository.initialize).toHaveBeenCalledWith('source', 99n);
    expect(repository.advance).toHaveBeenCalledWith('source', 99n, 1002n);
  });
  it('limits a large backlog to five chunks per tick', async () => {
    const { repository, client, run, source } = setup();
    repository.findSource.mockResolvedValue({
      ...source,
      poll_cursor_block: '100000',
      last_checked_block: '1000',
    });
    repository.readIdentities.mockResolvedValue({ pg: [], ch: [] });
    client.send.mockResolvedValue([]);
    await run(100000n);
    expect(repository.advance).toHaveBeenCalledTimes(5);
    expect(repository.advance).toHaveBeenLastCalledWith('source', 9000n, 11000n);
  });
  it('bounds the work per tick and stops on a cursor race', async () => {
    const { repository, client, run, source } = setup();
    repository.findSource.mockResolvedValue({
      ...source,
      poll_cursor_block: '100000',
      last_checked_block: '0',
    });
    repository.readIdentities.mockResolvedValue({ pg: [], ch: [] });
    client.send.mockResolvedValue([]);
    repository.advance.mockResolvedValue(false);
    await run();
    expect(repository.advance).toHaveBeenCalledTimes(1);
    expect(repository.advance).toHaveBeenCalledWith('source', 0n, 2000n);
  });
});
