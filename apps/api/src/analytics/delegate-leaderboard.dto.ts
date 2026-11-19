import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { DelegationModel } from '@libs/domain';
import { AnalyticsMetaDto } from './analytics-meta.dto';

export class DelegateLeaderboardQueryDto {
  @ApiPropertyOptional({ description: 'Max delegates to return (1–100, default 25).' })
  declare limit?: string;
}

export class DelegateLeaderboardRowDto {
  @ApiProperty({ description: '1-based rank under the response delegation model.' })
  declare rank: number;

  @ApiProperty()
  declare actor_id: string;

  @ApiProperty()
  declare address: string;

  @ApiPropertyOptional({ nullable: true })
  declare display_name: string | null;

  @ApiProperty({
    description: 'Current received voting power in base units; null for relationship-only data.',
    nullable: true,
    type: String,
  })
  declare voting_power: string | null;

  @ApiProperty({
    description: 'Share of DAO-wide delegated voting power; null for relationship-only data.',
    nullable: true,
    type: Number,
  })
  declare voting_power_share: number | null;

  @ApiProperty({ description: 'Number of addresses currently delegating to this delegate.' })
  declare delegator_count: number;
}

export class DelegateLeaderboardResponseDto {
  @ApiProperty({ enum: ['power-bearing', 'relationship-only'] })
  declare delegation_model: DelegationModel;

  @ApiProperty({ type: () => [DelegateLeaderboardRowDto] })
  declare data: DelegateLeaderboardRowDto[];

  @ApiProperty({ type: AnalyticsMetaDto })
  declare _meta: AnalyticsMetaDto;
}
