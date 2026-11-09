import { Logger, Module } from '@nestjs/common';
import { ChainContextRegistry } from '@libs/chain';
import {
  AbiCacheRepository,
  ProposalActionRepository,
  SelectorIndexRepository,
  pgDb,
} from '@libs/db';
import {
  CalldataDecoder,
  ChainNotReadyError,
  EtherscanClient,
  readCalldataDecoderConfig,
} from '@sources/core';
import { SOURCE_PLUGINS, type SourcePlugin } from '@sources/core';
import { ChainContextModule } from '@nest/chain';
import { toChainLogger } from '@nest/chain';
import { SourcesModule } from '@nest/sources';
import { CalldataDecoderWorkerService } from './calldata-decoder-worker.service';
import { bundledAbisFor, decodeByHeuristic } from './calldata-decoder.helpers';

@Module({
  imports: [ChainContextModule, SourcesModule],
  providers: [
    {
      provide: AbiCacheRepository,
      useFactory: () => new AbiCacheRepository(pgDb),
    },
    {
      provide: SelectorIndexRepository,
      useFactory: () => new SelectorIndexRepository(pgDb),
    },
    {
      provide: ProposalActionRepository,
      useFactory: () => new ProposalActionRepository(pgDb),
    },
    {
      provide: CalldataDecoder,
      useFactory: (
        abiCache: AbiCacheRepository,
        selectorIndex: SelectorIndexRepository,
        chains: ChainContextRegistry,
      ) =>
        new CalldataDecoder({
          abiCache,
          selectorIndex,
          bundledAbisFor,
          decodeByHeuristic,
          proxyResolverFor: (chainId) => {
            const ctx = chains.peek(chainId);
            if (!ctx) throw new ChainNotReadyError(chainId);
            return ctx.proxyResolver;
          },
          etherscanClient: (() => {
            const cfg = readCalldataDecoderConfig();
            return cfg.etherscan.enabled
              ? new EtherscanClient({
                  ...cfg.etherscan,
                  logger: toChainLogger(new Logger('EtherscanClient')),
                })
              : null;
          })(),
          logger: toChainLogger(new Logger('CalldataDecoder')),
        }),
      inject: [AbiCacheRepository, SelectorIndexRepository, ChainContextRegistry],
    },
    {
      provide: CalldataDecoderWorkerService,
      useFactory: (
        actions: ProposalActionRepository,
        decoder: CalldataDecoder,
        plugins: readonly SourcePlugin[],
      ) =>
        new CalldataDecoderWorkerService(
          pgDb,
          actions,
          decoder,
          plugins.flatMap((plugin) => plugin.proposalActionEnrichers ?? []),
        ),
      inject: [ProposalActionRepository, CalldataDecoder, SOURCE_PLUGINS],
    },
  ],
})
export class CalldataDecoderModule {}
