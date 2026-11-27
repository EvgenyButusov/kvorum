import { Command } from 'commander';
import { DlqRepository, pgDb } from '@libs/db';
import { withAudit } from '../audit.js';
import { buildContainer } from '../bootstrap.js';
import { emit, ExitCode, fail, type OutputFormat, resolveFormat } from '../output.js';
import { DLQ_RETRY_ADAPTERS } from './dlq-retry/registry.js';
import { DlqBatchStopped, retryDlqBatch } from './dlq-retry-batch.js';
import { isDlqRetryableStage } from './dlq-retry-stage.js';

type DlqCommon = { format?: string };
type DlqListOptions = DlqCommon & { feature?: string; stage?: string; limit?: string };
type DlqRetryOptions = DlqCommon & { dryRun?: boolean };
type DlqAcceptOptions = DlqCommon & { reason: string };
type DlqRetryBatchOptions = DlqCommon & {
  stage?: string;
  source?: string;
  limit?: string;
  dryRun?: boolean;
};

export function registerDlq(program: Command): void {
  const dlq = program.command('dlq').description('Dead-letter queue management');

  dlq
    .command('list')
    .description('List DLQ entries')
    .option('--feature <name>', 'filter by feature name')
    .option('--stage <stage>', 'filter by stage')
    .option('--limit <N>', 'maximum number of entries to return')
    .option('--format <format>', 'output format: human or json')
    .action(async function action(opts: DlqListOptions) {
      await withDlqFormat(this, opts, async (format) => {
        const { dlqRepository } = buildContainer();
        const limit = parseLimit(opts.limit);
        const rows = await dlqRepository.list({ source: opts.feature, stage: opts.stage, limit });
        emit(
          format,
          () =>
            rows.length === 0
              ? 'No DLQ rows'
              : rows.map((r) => `${r.id} stage=${r.stage} source=${r.source}`).join('\n'),
          { count: rows.length, items: rows },
        );
      });
    });

  dlq
    .command('retry <dlq_id>')
    .description('Retry a DLQ entry')
    .option('--dry-run', 'show what would happen without making changes')
    .option('--format <format>', 'output format: human or json')
    .action(async function action(dlqId: string, opts: DlqRetryOptions) {
      await withDlqFormat(this, opts, async (format) => {
        const { dlqRepository } = buildContainer();
        const row = await dlqRepository.getById(dlqId);
        if (row == null) {
          fail(format, ExitCode.NotFound, `dlq row not found: ${dlqId}`);
        }

        if (!isDlqRetryableStage(row.stage)) {
          emit(
            format,
            () =>
              'derive-stage DLQ entries are re-derived by the running indexer; use derive replay then verify',
            {
              dlq_id: dlqId,
              status: 'not_retryable_via_cli',
              stage: row.stage,
            },
          );
          return;
        }

        if (opts.dryRun === true) {
          emit(format, () => `Would retry DLQ row ${dlqId}`, { dlq_id: dlqId, dry_run: true });
          return;
        }

        await withAudit('dlq retry', { dlqId }, async () => {
          const adapter = DLQ_RETRY_ADAPTERS.get(row.stage);
          if (adapter == null) {
            fail(
              format,
              ExitCode.RuntimeFailure,
              `no retry adapter registered for stage ${row.stage}`,
            );
          }

          const outcome = await adapter.retry(row);
          const resolved = await pgDb
            .transaction()
            .execute((trx) =>
              new DlqRepository(trx).markRetrySucceeded(dlqId, outcome.reason, executorFromEnv()),
            );
          emit(format, () => `DLQ retry completed for ${dlqId}`, {
            dlq_id: dlqId,
            status: resolved,
          });
        });
      });
    });

  dlq
    .command('retry-batch')
    .description('Retry every DLQ entry matching a stage and source')
    .requiredOption('--stage <stage>', 'stage to retry')
    .option('--source <source>', 'restrict to one source')
    .option('--limit <N>', 'maximum number of entries to retry')
    .option('--dry-run', 'show what would happen without making changes')
    .option('--format <format>', 'output format: human or json')
    .action(async function action(opts: DlqRetryBatchOptions) {
      await withDlqFormat(this, opts, async (format) => {
        const { dlqRepository } = buildContainer();
        const stage = opts.stage ?? '';
        if (!isDlqRetryableStage(stage)) {
          fail(format, ExitCode.ValidationFailure, `stage is not retryable via cli: ${stage}`);
        }
        const adapter = DLQ_RETRY_ADAPTERS.get(stage);
        if (adapter == null) {
          fail(format, ExitCode.RuntimeFailure, `no retry adapter registered for stage ${stage}`);
        }

        const rows = await dlqRepository.list({
          stage,
          source: opts.source,
          limit: parseLimit(opts.limit),
        });

        if (opts.dryRun === true) {
          emit(format, () => `Would retry ${rows.length} DLQ rows in stage ${stage}`, {
            stage,
            dry_run: true,
            count: rows.length,
            dlq_ids: rows.map((r) => r.id),
          });
          return;
        }

        // withAudit records the outcome, so a run that stops early must reach it as a
        // throw or the audit row would claim success for a partial re-drive.
        const result = await withAudit(
          'dlq retry-batch',
          { stage, source: opts.source ?? null, candidates: rows.length },
          async () => {
            const outcome = await retryDlqBatch(rows, {
              retry: (row) => adapter.retry(row),
              markSucceeded: async (id, reason) => {
                await pgDb
                  .transaction()
                  .execute((trx) =>
                    new DlqRepository(trx).markRetrySucceeded(id, reason, executorFromEnv()),
                  );
              },
            });
            if (outcome.stoppedAt != null) {
              throw new DlqBatchStopped(outcome);
            }
            return outcome;
          },
        ).catch((error: unknown) => {
          if (error instanceof DlqBatchStopped) {
            return error.result;
          }
          throw error;
        });

        if (result.stoppedAt != null) {
          fail(
            format,
            ExitCode.RuntimeFailure,
            `dlq retry-batch stopped at ${result.stoppedAt.id}`,
            {
              stage,
              retried: result.retried.length,
              remaining: rows.length - result.retried.length,
              dlq_id: result.stoppedAt.id,
              message: result.stoppedAt.message,
            },
          );
        }

        emit(format, () => `DLQ retry-batch completed: ${result.retried.length} rows`, {
          stage,
          retried: result.retried.length,
          dlq_ids: result.retried,
        });
      });
    });

  dlq
    .command('accept <dlq_id>')
    .description('Accept (discard) a DLQ entry with a recorded reason')
    .requiredOption('--reason <reason>', 'justification for accepting without retry')
    .option('--format <format>', 'output format: human or json')
    .action(async function action(dlqId: string, opts: DlqAcceptOptions) {
      await withDlqFormat(this, opts, async (format) => {
        if (opts.reason.trim().length === 0) {
          fail(format, ExitCode.ValidationFailure, '--reason must not be empty');
        }
        await withAudit('dlq accept', { dlqId, reason: opts.reason }, async () => {
          const result = await pgDb
            .transaction()
            .execute((trx) =>
              new DlqRepository(trx).accept(dlqId, opts.reason.trim(), executorFromEnv()),
            );
          if (result === 'not_found') {
            fail(format, ExitCode.NotFound, `dlq row not found: ${dlqId}`);
          }
          if (result === 'already_resolved') {
            fail(format, ExitCode.RuntimeFailure, `dlq row already resolved: ${dlqId}`);
          }
          emit(format, () => `DLQ row accepted: ${dlqId}`, { dlq_id: dlqId, status: result });
        });
      });
    });
}

function parseLimit(value: string | undefined): number {
  if (value == null) {
    return 50;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error('--limit must be an unsigned integer');
  }
  const n = Number(value);
  if (n <= 0 || n > 500) {
    throw new Error('--limit must be between 1 and 500');
  }
  return n;
}

function executorFromEnv(): string {
  return process.env['SUDO_USER'] ?? process.env['USER'] ?? process.env['LOGNAME'] ?? 'unknown';
}

async function withDlqFormat(
  command: Command,
  opts: DlqCommon,
  run: (format: OutputFormat) => Promise<void>,
): Promise<void> {
  let format: OutputFormat = 'human';
  try {
    const globalFormat = command.optsWithGlobals()['format'];
    format = resolveFormat(
      opts.format,
      typeof globalFormat === 'string' ? globalFormat : undefined,
    );
    await run(format);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    if (
      message.startsWith('invalid --format value:') ||
      message.includes('unsigned integer') ||
      message.includes('between 1 and 500')
    ) {
      fail(opts.format === 'json' ? 'json' : 'human', ExitCode.ValidationFailure, message);
    }
    fail(format, ExitCode.RuntimeFailure, 'dlq command failed', { message });
  }
}
