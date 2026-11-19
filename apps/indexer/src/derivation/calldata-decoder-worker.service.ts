import { Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { Kysely } from 'kysely';
import type { PgDatabase } from '@libs/db';
import { ProposalActionRepository } from '@libs/db';
import { readIntervalMs, readPositiveInt } from '@libs/utils';
import type {
  DecodeResult,
  ProposalActionDecodedEvent,
  ProposalActionDecodedPlugin,
} from '@sources/core';
import { CalldataDecoder } from '@sources/core';
import { calldataDecodeMetrics } from './calldata-decode-metrics';

const INTERVAL_MS = readIntervalMs('INDEXER_CALLDATA_DECODE_INTERVAL_MS', 10_000);
const BATCH_SIZE = readPositiveInt('INDEXER_CALLDATA_DECODE_BATCH_SIZE', 100);

@Injectable()
export class CalldataDecoderWorkerService implements OnApplicationBootstrap {
  private readonly logger = new Logger('CalldataDecoderWorker');
  private inFlight = false;

  constructor(
    private readonly pgDb: Kysely<PgDatabase>,
    private readonly actions: ProposalActionRepository,
    private readonly decoder: CalldataDecoder,
    private readonly decodedActionPlugins: readonly ProposalActionDecodedPlugin[] = [],
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    void this.tick();
  }

  @Interval(INTERVAL_MS)
  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    const startedAt = Date.now();
    const tally = { decoded: 0, partial: 0, miss: 0 };
    try {
      for (let i = 0; i < BATCH_SIZE; i++) {
        const outcome = await this.processOne();
        if (outcome === null) break;
        tally[outcome]++;
      }
    } catch (err) {
      this.logger.error('calldata_decode_tick_failed', { error: String(err) });
    } finally {
      calldataDecodeMetrics.tickDurationSeconds.record((Date.now() - startedAt) / 1000);
      const total = tally.decoded + tally.partial + tally.miss;
      if (total > 0) {
        calldataDecodeMetrics.abiDecodeSuccessRate.record(tally.decoded / total);
      }
      this.inFlight = false;
    }
  }

  private async processOne(): Promise<'decoded' | 'partial' | 'miss' | null> {
    const attempt = await this.pgDb.transaction().execute(async (trx) => {
      const [row] = await this.actions.findPendingDecodeForUpdate(trx, 1);
      if (!row) return null;

      let result: DecodeResult;
      try {
        result = await this.decoder.decode({
          chainId: row.target_chain_id,
          sourceType: row.source_type,
          targetAddress: row.target_address,
          calldata: row.calldata,
          functionSignature: row.function_signature,
        });
      } catch (err) {
        this.logger.error('decoder_threw', { err, actionId: row.id });
        result = { kind: 'miss' };
      }

      if (result.kind === 'decoded') {
        await this.actions.markDecoded(trx, row.id, {
          function: result.decodedFunction,
          arguments: result.decodedArguments,
        });
        calldataDecodeMetrics.outcomes.add(1, { outcome: 'decoded', source: result.source });
        return { outcome: 'decoded' as const, event: eventFor(row, 'decoded') };
      }

      const retryAt = jitteredRetryAt();

      if (result.kind === 'partial') {
        await this.actions.markUndecodable(trx, row.id, {
          retryAt,
          functionSignatureGuess: result.functionSignatureGuess,
        });
        calldataDecodeMetrics.outcomes.add(1, { outcome: 'partial', source: 'selector_index' });
        return { outcome: 'partial' as const, event: eventFor(row, 'partial') };
      }

      await this.actions.markUndecodable(trx, row.id, { retryAt });
      calldataDecodeMetrics.outcomes.add(1, { outcome: 'miss' });
      return { outcome: 'miss' as const, event: null };
    });

    if (attempt === null) return null;
    if (attempt.event !== null) await this.publishDecodedAction(attempt.event);
    return attempt.outcome;
  }

  // Each plugin gets its own transaction, after the decode has committed. Never inside the decode
  // transaction: a plugin failure would roll back `markDecoded`/`markUndecodable` without advancing
  // `decode_attempt_count`, and the queue's `created_at ASC` head would re-select the same action on
  // every tick forever, starving every other pending row.
  private async publishDecodedAction(event: ProposalActionDecodedEvent): Promise<void> {
    for (const plugin of this.decodedActionPlugins) {
      if (!plugin.sourceTypes.includes(event.sourceType)) continue;
      try {
        await this.pgDb.transaction().execute((trx) => plugin.onProposalActionDecoded(trx, event));
      } catch (err) {
        this.logger.error('decoded_action_plugin_failed', { err, actionId: event.actionId });
        calldataDecodeMetrics.decodedActionPluginFailures.add(1, {
          source: event.sourceType,
          outcome: event.outcome,
        });
      }
    }
  }
}

function eventFor(
  row: { id: string; proposal_id: string; source_type: string },
  outcome: ProposalActionDecodedEvent['outcome'],
): ProposalActionDecodedEvent {
  return {
    actionId: row.id,
    proposalId: row.proposal_id,
    sourceType: row.source_type,
    outcome,
  };
}

function jitteredRetryAt(): Date {
  const base = 24 * 60 * 60 * 1000;
  const jitter = 0.8 + Math.random() * 0.4;
  return new Date(Date.now() + base * jitter);
}
