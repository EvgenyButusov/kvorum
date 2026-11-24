import { decodeLogEvent, type LogEvent, type Logger } from '@libs/chain';
import type { ReconcileDriverMetrics, ReconcileRpcClient } from '@sources/core';
import { decodeCompoundLog } from '../abi/decoder';
import { interfaceForSource } from '../abi/events';
import type { CompoundEventType } from '../abi/events';
import type { GovernorArchiveWriter } from '../ingestion/archive-writer';
import type {
  ArchiveIdentity,
  CompoundArchiveReconcileRepository,
} from '../persistence/compound-archive-reconcile-repository';

// The normal poller is hourly in production. Leave two hours of headroom for
// queued archive consumers, then audit independently of their live cursor.
const AUDIT_DELAY_BLOCKS = 600n;
const INITIAL_LOOKBACK_BLOCKS = 50_000n;
const CHUNK_BLOCKS = 2_000n;
const MAX_BLOCKS_PER_TICK = 10_000n;

interface ArchiveReconcilerDeps {
  repository: Pick<
    CompoundArchiveReconcileRepository,
    'findSource' | 'initialize' | 'advance' | 'readIdentities'
  >;
  writer: Pick<GovernorArchiveWriter, 'writeCore'>;
  metrics: Pick<ReconcileDriverMetrics, 'recordOutcome'>;
  logger: Logger;
  recordLag?: (sourceType: string, blocks: number) => void;
  recordRepair?: (labels: ArchiveRepairLabels) => void;
}

export interface ArchiveRepairLabels {
  source_type: string;
  event_type: CompoundEventType;
  missing_store: 'postgres' | 'clickhouse' | 'both';
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
function hex(block: bigint): string {
  return '0x' + block.toString(16);
}
function logKey(log: LogEvent): string {
  return [log.blockHash.toLowerCase(), log.txHash.toLowerCase(), log.logIndex].join(':');
}
function archiveKey(row: ArchiveIdentity): string {
  return [row.block_hash.toLowerCase(), row.tx_hash.toLowerCase(), Number(row.log_index)].join(':');
}

/** Independently re-reads confirmed governor logs, including votes. The audit
 * never advances the ingestion/backfill cursor, and never guesses a state. */
export class CompoundArchiveReconciler {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly deps: ArchiveReconcilerDeps,
    private readonly sourceType: string,
  ) {}

  async onConfirmedHead(input: {
    reconcileSourceId: string;
    governorAddress: string;
    chainId: string;
    confirmedHead: bigint;
    client: ReconcileRpcClient;
  }): Promise<void> {
    if (this.inFlight.has(input.reconcileSourceId)) return;
    this.inFlight.add(input.reconcileSourceId);
    try {
      const { repository } = this.deps;
      let source = await repository.findSource(input.reconcileSourceId, this.sourceType);
      if (!source || source.poll_cursor_block === null || source.active_from_block === null) return;
      if (source.governor_address.toLowerCase() !== input.governorAddress.toLowerCase()) {
        throw new Error('Compound audit source governor mismatch');
      }
      const floor = BigInt(source.active_from_block);
      const liveBound = BigInt(source.poll_cursor_block) - AUDIT_DELAY_BLOCKS;
      let target = min(input.confirmedHead, liveBound);
      if (source.active_to_block !== null) target = min(target, BigInt(source.active_to_block));
      if (target < floor) return;
      if (source.last_checked_block === null) {
        // A bounded initial historical audit. Subsequent ticks resume durably,
        // including following prolonged downtime or interrupted repairs.
        await repository.initialize(source.id, max(floor - 1n, target - INITIAL_LOOKBACK_BLOCKS));
        source = await repository.findSource(input.reconcileSourceId, this.sourceType);
        if (!source || source.last_checked_block === null) return;
      }
      let cursor = BigInt(source.last_checked_block);
      this.deps.recordLag?.(this.sourceType, Number(max(0n, target - cursor)));
      const end = min(target, max(cursor, floor - 1n) + MAX_BLOCKS_PER_TICK);
      while (cursor < end) {
        const from = max(cursor + 1n, floor);
        const to = min(end, from + CHUNK_BLOCKS - 1n);
        if (from > to) return;
        const repaired = await this.auditChunk({
          sourceId: source.id,
          governorAddress: source.governor_address,
          chainId: input.chainId,
          from,
          to,
          client: input.client,
        });
        if (!(await repository.advance(source.id, cursor, to))) return;
        cursor = to;
        this.deps.recordLag?.(this.sourceType, Number(max(0n, target - cursor)));
        this.deps.metrics.recordOutcome({
          source_type: this.sourceType,
          outcome: repaired > 0 ? 'archive_repaired' : 'archive_verified',
        });
        if (repaired > 0)
          this.deps.logger.info('compound_archive_repaired', {
            source_type: this.sourceType,
            from_block: from.toString(),
            to_block: to.toString(),
            repaired,
          });
      }
    } catch (error) {
      this.deps.metrics.recordOutcome({
        source_type: this.sourceType,
        outcome: 'archive_audit_failed',
      });
      this.deps.logger.error('compound_archive_audit_failed', {
        source_type: this.sourceType,
        error: String(error),
      });
    } finally {
      this.inFlight.delete(input.reconcileSourceId);
    }
  }

  private async auditChunk(args: {
    sourceId: string;
    governorAddress: string;
    chainId: string;
    from: bigint;
    to: bigint;
    client: ReconcileRpcClient;
  }): Promise<number> {
    const address = args.governorAddress.toLowerCase();
    const raw = await args.client.send<Record<string, unknown>[]>('eth_getLogs', [
      {
        address,
        topics: [Object.values(interfaceForSource(this.sourceType).topics)],
        fromBlock: hex(args.from),
        toBlock: hex(args.to),
      },
    ]);
    if (!Array.isArray(raw)) throw new Error('Invalid governor log response');
    const expected = new Map<
      string,
      { log: LogEvent; decoded: ReturnType<typeof decodeCompoundLog> }
    >();
    for (const entry of raw) {
      const log = decodeLogEvent(entry, this.sourceType, args.chainId);
      if (
        entry['removed'] === true ||
        log.address !== address ||
        log.blockNumber < args.from ||
        log.blockNumber > args.to
      ) {
        throw new Error('Unexpected governor log in confirmed audit range');
      }
      expected.set(logKey(log), { log, decoded: decodeCompoundLog(log, this.sourceType) });
    }
    const existing = await this.deps.repository.readIdentities(args.sourceId, args.from, args.to);
    // If a provider omits a known canonical event, an empty response is not
    // proof of coverage. Old noncanonical archive rows are left to reorg handling.
    const headers = new Map<string, string>();
    const canonicalHash = async (block: string): Promise<string> => {
      let hash = headers.get(block);
      if (hash === undefined) {
        const header = await args.client.send<{ hash?: string }>('eth_getBlockByNumber', [
          hex(BigInt(block)),
          false,
        ]);
        if (!header?.hash) throw new Error('Unavailable canonical block for archive audit');
        hash = header.hash.toLowerCase();
        headers.set(block, hash);
      }
      return hash;
    };
    for (const row of [...existing.pg, ...existing.ch]) {
      const match = expected.get(archiveKey(row));
      if (match) {
        if (
          match.decoded.type !== row.event_type ||
          match.log.blockNumber !== BigInt(row.block_number)
        ) {
          throw new Error('Archived governor identity has conflicting metadata');
        }
        continue;
      }
      const hash = await canonicalHash(row.block_number);
      if (hash === row.block_hash.toLowerCase()) {
        throw new Error('Provider omitted a previously archived canonical governor event');
      }
    }

    const pg = new Set(existing.pg.map(archiveKey));
    const ch = new Set(existing.ch.map(archiveKey));
    let repaired = 0;
    for (const [key, entry] of expected) {
      if (pg.has(key) && ch.has(key)) continue;
      const labels: ArchiveRepairLabels = {
        source_type: this.sourceType,
        event_type: entry.decoded.type,
        missing_store: pg.has(key) ? 'clickhouse' : ch.has(key) ? 'postgres' : 'both',
      };
      const { log, decoded } = entry;
      const details = {
        ...labels,
        dao_source_id: args.sourceId,
        chain_id: args.chainId,
        governor_address: address,
        proposal_id: decoded.payload.proposalId,
        block: log.blockNumber.toString(),
        block_hash: log.blockHash,
        tx_hash: log.txHash,
        log_index: log.logIndex,
        ...(decoded.type === 'VoteCast'
          ? {
              voter: decoded.payload.voter,
              choice: decoded.payload.primaryChoice,
              voting_power: decoded.payload.votingPowerReported,
            }
          : decoded.type === 'ProposalCreated'
            ? {
                proposer: decoded.payload.proposer,
                start_block: decoded.payload.startBlock,
                end_block: decoded.payload.endBlock,
              }
            : decoded.type === 'ProposalQueued'
              ? { eta: decoded.payload.eta }
              : {}),
      };
      this.deps.logger.info('compound_archive_repair_started', details);
      try {
        if ((await canonicalHash(log.blockNumber.toString())) !== log.blockHash.toLowerCase()) {
          throw new Error('Governor audit log is not canonical');
        }
        await this.deps.writer.writeCore(
          {
            daoSourceId: args.sourceId,
            sourceType: this.sourceType,
            chainId: args.chainId,
            sourceLabel: this.sourceType,
          },
          decoded,
          log,
        );
        // Verify and account for each repair immediately. If a subsequent event
        // or cursor update fails, already recovered events must not disappear
        // from the KPI on the next scan.
        const after = await this.deps.repository.readIdentities(
          args.sourceId,
          log.blockNumber,
          log.blockNumber,
        );
        const matches = (row: ArchiveIdentity) =>
          archiveKey(row) === key &&
          row.event_type === decoded.type &&
          BigInt(row.block_number) === log.blockNumber;
        if (!after.pg.some(matches) || !after.ch.some(matches)) {
          throw new Error('Governor archive repair did not persist');
        }
      } catch (error) {
        this.deps.logger.error('compound_archive_repair_failed', {
          ...details,
          error: String(error),
        });
        throw error;
      }
      repaired++;
      this.deps.recordRepair?.(labels);
      this.deps.logger.info('compound_archive_event_repaired', details);
    }
    return repaired;
  }
}
