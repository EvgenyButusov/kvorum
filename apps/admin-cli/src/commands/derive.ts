import { createHash } from 'node:crypto';
import { Command } from 'commander';
import { withAudit } from '../audit.js';
import { buildContainer } from '../bootstrap.js';
import { emit, ExitCode, fail, type OutputFormat, resolveFormat } from '../output.js';

type DeriveCommon = { format?: string };
type DeriveReplayOptions = DeriveCommon & {
  fromBlock?: string;
  confirm?: boolean;
  production?: boolean;
  dryRun?: boolean;
};
type DeriveRedecodeOptions = DeriveCommon & {
  dao?: string[];
  source?: string[];
  includePending?: boolean;
  // commander sets `undecodable: false` when --no-undecodable is passed; defaults to true otherwise.
  undecodable?: boolean;
  confirm?: boolean;
  production?: boolean;
  dryRun?: boolean;
};

type DeriveAuditRewindOptions = DeriveCommon & {
  fromBlock?: string;
  source?: string[];
  confirm?: boolean;
  production?: boolean;
  dryRun?: boolean;
};
type DeriveRetitleOptions = DeriveCommon & {
  confirm?: boolean;
  production?: boolean;
  dryRun?: boolean;
};
type DeriveUnparkOptions = DeriveCommon & {
  source?: string[];
  maxAttempts?: string;
  confirm?: boolean;
  production?: boolean;
  dryRun?: boolean;
};

export function registerDerive(program: Command): void {
  const derive = program.command('derive').description('Derived data management');

  derive
    .command('replay <dao_source_id>')
    .description('Replay derivation for a DAO source (destructive)')
    .option('--from-block <N>', 'starting block number')
    .option('--confirm', 'confirm destructive operation')
    .option('--production', 'acknowledge production environment')
    .option('--dry-run', 'show what would happen without making changes')
    .option('--format <format>', 'output format: human or json')
    .action(async function action(daoSourceId: string, opts: DeriveReplayOptions) {
      await withDeriveFormat(this, opts, async (format) => {
        const { archiveDerivationRepository } = buildContainer();
        const fromBlock = parseOptionalBlock(opts.fromBlock, '--from-block');

        if (opts.dryRun === true) {
          const rows = await archiveDerivationRepository.countUnderived(daoSourceId, fromBlock);
          emit(format, () => `Would reset derivation watermark for ${rows} rows`, {
            dao_source_id: daoSourceId,
            dry_run: true,
            affected_rows: rows,
          });
          return;
        }

        if (opts.confirm !== true || opts.production !== true) {
          fail(
            format,
            ExitCode.ValidationFailure,
            'derive replay requires both --confirm and --production',
          );
        }

        await withAudit('derive replay', { daoSourceId, ...opts }, async () => {
          const count = await archiveDerivationRepository.resetWatermarkForSource(
            daoSourceId,
            fromBlock,
          );
          emit(
            format,
            () =>
              `Watermarks reset (${count} rows); re-derivation occurs as the indexer processes them`,
            {
              dao_source_id: daoSourceId,
              reset_rows: count,
              note: 'Resets watermarks only; running indexer performs re-derivation',
            },
          );
        });
      });
    });

  derive
    .command('unpark')
    .description('Return rows parked by the derivation attempt ceiling to the derivable queue')
    .option('--source <type...>', 'archive source type(s) to scope to (repeatable)')
    .option('--max-attempts <N>', 'attempt ceiling to compare against')
    .option('--confirm', 'confirm the operation')
    .option('--production', 'acknowledge production environment')
    .option('--dry-run', 'report what would be unparked without making changes')
    .option('--format <format>', 'output format: human or json')
    .action(async function action(opts: DeriveUnparkOptions) {
      await withDeriveFormat(this, opts, async (format) => {
        const { archiveDerivationRepository } = buildContainer();
        const { resolveMaxDerivationAttempts } = await import('@libs/db');
        const maxAttempts =
          opts.maxAttempts === undefined
            ? resolveMaxDerivationAttempts()
            : parseMaxAttempts(opts.maxAttempts);
        const dryRun = opts.dryRun === true;

        if (!dryRun && (opts.confirm !== true || opts.production !== true)) {
          fail(
            format,
            ExitCode.ValidationFailure,
            'derive unpark requires both --confirm and --production, or --dry-run',
          );
        }

        const parked = await archiveDerivationRepository.countParkedBySourceType(
          maxAttempts,
          opts.source,
        );
        const total = parked.reduce((sum, row) => sum + row.count, 0);

        const describe = (verb: string, count: number): string =>
          [
            `${verb} ${count} parked row(s) at or past ${maxAttempts} attempts`,
            ...parked.map((row) => `  ${row.source_type}: ${row.count}`),
            'Rows also quarantined in a projection DLQ stay quarantined; clear those with dlq retry.',
          ].join('\n');

        if (dryRun) {
          emit(format, () => describe('Would unpark', total), {
            dry_run: true,
            max_attempts: maxAttempts,
            parked_total: total,
            by_source_type: parked,
          });
          return;
        }

        await withAudit('derive unpark', { ...opts, maxAttempts }, async () => {
          const unparked = await archiveDerivationRepository.unparkExhausted(
            maxAttempts,
            opts.source,
          );
          emit(format, () => describe('Unparked', unparked), {
            max_attempts: maxAttempts,
            unparked_rows: unparked,
            by_source_type: parked,
            note: 'Resets attempt counts only; the running indexer performs derivation',
          });
        });
      });
    });

  derive
    .command('verify <proposal_external_id>')
    .description('Verify derived data for a proposal')
    .option('--format <format>', 'output format: human or json')
    .action(async function action(proposalExternalId: string, opts: DeriveCommon) {
      await withDeriveFormat(this, opts, async (format) => {
        const [daoSlug, sourceType, sourceId] = proposalExternalId.split(':');
        if (!daoSlug || !sourceType || !sourceId) {
          fail(
            format,
            ExitCode.ValidationFailure,
            'proposal_external_id must be dao_slug:source_type:source_id',
          );
        }

        const { daoReadRepository, proposalReadRepository } = buildContainer();
        const proposal = await proposalReadRepository.findOne(daoSlug, sourceType, sourceId);
        if (proposal == null) {
          fail(format, ExitCode.NotFound, `proposal not found: ${proposalExternalId}`);
        }

        const daoSource = await daoReadRepository.findSourceByDaoSlugAndType(daoSlug, sourceType);
        if (daoSource == null) {
          fail(format, ExitCode.NotFound, `dao source not found for ${daoSlug}:${sourceType}`);
        }

        const { compoundGovernorArchivePayloadRepository } = buildContainer();
        const archived = await compoundGovernorArchivePayloadRepository.findByProposalId(
          daoSource.id,
          sourceId,
        );

        const created = archived.find((row) => row.event_type === 'ProposalCreated');
        if (created == null) {
          fail(
            format,
            ExitCode.RuntimeFailure,
            `no ProposalCreated archive event found for ${proposalExternalId}`,
          );
        }

        const createdPayload = JSON.parse(created.payload) as {
          description: string;
          startBlock: string;
          endBlock: string;
        };

        const { extractCompoundTitle } = await import('@sources/compound');
        const expectedTitle = extractCompoundTitle(createdPayload.description);
        const expectedDescriptionHash = createHash('sha256')
          .update(createdPayload.description)
          .digest('hex');
        const transition = archived
          .filter((row) =>
            ['ProposalQueued', 'ProposalExecuted', 'ProposalCanceled'].includes(row.event_type),
          )
          .at(-1);
        const expectedState =
          transition?.event_type === 'ProposalExecuted'
            ? 'executed'
            : transition?.event_type === 'ProposalQueued'
              ? 'queued'
              : transition?.event_type === 'ProposalCanceled'
                ? 'canceled'
                : 'pending';

        const diffs: string[] = [];
        if (proposal.title !== expectedTitle) diffs.push('title');
        if (proposal.description_hash !== expectedDescriptionHash) diffs.push('description_hash');
        if (proposal.voting_starts_block !== createdPayload.startBlock)
          diffs.push('voting_starts_block');
        if (proposal.voting_ends_block !== createdPayload.endBlock) diffs.push('voting_ends_block');
        if (proposal.state !== expectedState) diffs.push('state');

        const payload = {
          proposal_external_id: proposalExternalId,
          ok: diffs.length === 0,
          diff_fields: diffs,
          scope: 'verifies proposal-row fields only; does not re-decode actions',
        };

        emit(
          format,
          () =>
            diffs.length === 0
              ? `Verification passed (${payload.scope})`
              : `Verification failed; differing fields: ${diffs.join(', ')} (${payload.scope})`,
          payload,
        );
      });
    });

  derive
    .command('audit-rewind')
    .description('Rewind the archive-completeness audit cursor so a block range is audited again')
    .requiredOption('--from-block <N>', 'first block to audit again')
    .option('--source <type...>', 'proposal source type(s) to scope to; omit for all')
    .option('--confirm', 'confirm the operation')
    .option('--production', 'acknowledge production environment')
    .option('--dry-run', 'report how many cursors would move without writing')
    .option('--format <format>', 'output format: human or json')
    .action(async function action(opts: DeriveAuditRewindOptions) {
      await withDeriveFormat(this, opts, async (format) => {
        const fromBlock = parseOptionalBlock(opts.fromBlock, '--from-block');
        if (fromBlock === undefined) {
          fail(format, ExitCode.ValidationFailure, '--from-block is required');
        }
        // The audit resumes at last_checked_block + 1, so land the cursor one short of the target.
        const toBlock = fromBlock > 0n ? fromBlock - 1n : 0n;
        const dryRun = opts.dryRun === true;
        if (!dryRun && (opts.confirm !== true || opts.production !== true)) {
          fail(
            format,
            ExitCode.ValidationFailure,
            'derive audit-rewind requires both --confirm and --production, or --dry-run',
          );
        }

        const { archiveDerivationRepository } = buildContainer();
        if (dryRun) {
          const rows = await archiveDerivationRepository.countArchiveReconcileRewind(
            toBlock,
            opts.source,
          );
          emit(format, () => `Would rewind ${rows} audit cursor(s) to block ${toBlock}`, {
            dry_run: true,
            affected_rows: rows,
            from_block: fromBlock.toString(),
            cursor_block: toBlock.toString(),
            source_types: opts.source ?? null,
          });
          return;
        }

        await withAudit('derive audit-rewind', { ...opts }, async () => {
          const count = await archiveDerivationRepository.rewindArchiveReconcileCursor(
            toBlock,
            opts.source,
          );
          emit(
            format,
            () =>
              `Rewound ${count} audit cursor(s) to block ${toBlock}; the audit re-reads from ${fromBlock} on its next tick`,
            {
              rewound_rows: count,
              from_block: fromBlock.toString(),
              cursor_block: toBlock.toString(),
              source_types: opts.source ?? null,
              note: 'Cursors already at or behind the target are left alone',
            },
          );
        });
      });
    });

  derive
    .command('retitle')
    .description('Recompute Easy Track motion titles from their factory type label')
    .option('--confirm', 'confirm the operation')
    .option('--production', 'acknowledge production environment')
    .option('--dry-run', 'report what would change without writing')
    .option('--format <format>', 'output format: human or json')
    .action(async function action(opts: DeriveRetitleOptions) {
      await withDeriveFormat(this, opts, async (format) => {
        const dryRun = opts.dryRun === true;
        if (!dryRun && (opts.confirm !== true || opts.production !== true)) {
          fail(
            format,
            ExitCode.ValidationFailure,
            'derive retitle requires both --confirm and --production, or --dry-run',
          );
        }

        const [{ retitleEasyTrackMotions }, { pgDb }] = await Promise.all([
          import('@sources/lido'),
          import('@libs/db'),
        ]);
        const run = async () => {
          const result = await retitleEasyTrackMotions(pgDb, { dryRun });
          emit(
            format,
            () =>
              [
                `${dryRun ? 'Would retitle' : 'Retitled'} ${result.updated} of ${result.scanned} motion(s)`,
                `unchanged ${result.unchanged}, unlabelled factory ${result.unlabelled}`,
                ...result.samples.map((s) => `  #${s.sourceId}: ${s.from} -> ${s.to}`),
              ].join('\n'),
            { ...result, dry_run: dryRun },
          );
        };

        if (dryRun) {
          await run();
          return;
        }
        await withAudit('derive retitle', { ...opts }, run);
      });
    });

  derive
    .command('redecode')
    .description('Re-queue already-attempted proposal_action rows for calldata decoding')
    .option('--dao <slug...>', 'DAO slug(s) to scope to (repeatable); omit for all DAOs')
    .option('--source <type...>', 'proposal source type(s) to scope to (repeatable)')
    .option('--include-pending', 'also clear the retry timer on pending (backed-off) rows')
    .option('--no-undecodable', 'do not include terminal undecodable rows')
    .option('--confirm', 'confirm the operation')
    .option('--production', 'acknowledge production environment')
    .option('--dry-run', 'show how many rows would be re-queued without making changes')
    .option('--format <format>', 'output format: human or json')
    .action(async function action(opts: DeriveRedecodeOptions) {
      await withDeriveFormat(this, opts, async (format) => {
        const includeUndecodable = opts.undecodable ?? true;
        const includePending = opts.includePending ?? false;
        if (!includeUndecodable && !includePending) {
          fail(
            format,
            ExitCode.ValidationFailure,
            'nothing to re-queue: pass --include-pending or drop --no-undecodable',
          );
        }

        const filter = {
          daoSlugs: opts.dao,
          sourceTypes: opts.source,
          includeUndecodable,
          includePending,
        };
        const { proposalActionRepository } = buildContainer();

        if (opts.dryRun === true) {
          const rows = await proposalActionRepository.countForRedecode(filter);
          emit(format, () => `Would re-queue ${rows} proposal_action row(s) for decoding`, {
            dry_run: true,
            affected_rows: rows,
            filter,
          });
          return;
        }

        if (opts.confirm !== true || opts.production !== true) {
          fail(
            format,
            ExitCode.ValidationFailure,
            'derive redecode requires both --confirm and --production',
          );
        }

        await withAudit('derive redecode', { ...opts }, async () => {
          const count = await proposalActionRepository.resetForRedecode(filter);
          emit(
            format,
            () =>
              `Re-queued ${count} proposal_action row(s); the running indexer sweep will re-decode them`,
            {
              requeued_rows: count,
              filter,
              note: 'Resets rows to pending only; the CalldataDecoderWorkerService performs decoding',
            },
          );
        });
      });
    });
}

function parseOptionalBlock(value: string | undefined, optionName: string): bigint | undefined {
  if (value == null) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${optionName} must be an unsigned integer`);
  }
  return BigInt(value);
}

function parseMaxAttempts(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error('--max-attempts must be an unsigned integer');
  }
  const parsed = Number(value);
  if (parsed < 1) {
    throw new Error('--max-attempts must be at least 1');
  }
  return parsed;
}

async function withDeriveFormat(
  command: Command,
  opts: DeriveCommon,
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
      message.includes('must be an unsigned integer') ||
      message.includes('must be at least 1')
    ) {
      fail(opts.format === 'json' ? 'json' : 'human', ExitCode.ValidationFailure, message);
    }
    fail(format, ExitCode.RuntimeFailure, 'derive command failed', { message });
  }
}
