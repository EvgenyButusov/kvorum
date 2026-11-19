import { Module } from '@nestjs/common';
import { PROPOSAL_ACTION_DECODED_PLUGINS, type ProposalActionDecodedPlugin } from '@sources/core';
import { LIDO_PROPOSAL_ACTION_DECODED_PLUGIN, LidoSourceModule } from '@nest/lido';

/** Narrow composition root for source-owned reactions to decoded proposal actions. */
@Module({
  imports: [LidoSourceModule],
  providers: [
    {
      provide: PROPOSAL_ACTION_DECODED_PLUGINS,
      useFactory: (lido: ProposalActionDecodedPlugin): readonly ProposalActionDecodedPlugin[] => [
        lido,
      ],
      inject: [LIDO_PROPOSAL_ACTION_DECODED_PLUGIN],
    },
  ],
  exports: [PROPOSAL_ACTION_DECODED_PLUGINS],
})
export class ProposalActionDecodedPluginsModule {}
