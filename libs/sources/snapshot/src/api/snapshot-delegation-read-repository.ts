import type { Kysely } from 'kysely';
import { ActorRoutingReadRepository, isoSeconds, type PgDatabase } from '@libs/db';
import { asSourceConfigObject } from '@libs/domain';
import type { OffchainDelegationView, RelationshipDelegationView } from '@libs/domain';
import { DELEGATION_EVENT_TYPE, DELEGATION_SYSTEM } from '../delegation/constants';
import {
  type CurrentDelegate,
  resolveCurrentDelegateRegistry,
  resolveCurrentSplit,
} from '../delegation/snapshot-delegation-repository';
import type { SnapshotDelegation } from '../persistence/schema';
import '../persistence/schema';

// Reads an actor's current Snapshot delegations (Delegate Registry single + Split Delegation
// weighted) into the medium-neutral OffchainDelegationView, for the per-actor delegation surface.
// Groups by (delegator, space, system) and resolves the active set per group; Split reuses the
// projection resolver. Global (dao_id null) Delegate Registry delegations apply to every space.
export class SnapshotDelegationReadRepository {
  private readonly identity: ActorRoutingReadRepository;

  constructor(
    private readonly db: Kysely<PgDatabase>,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.identity = new ActorRoutingReadRepository(db);
  }

  async findCurrentForActor(
    daoId: string,
    delegatorAddresses: readonly string[],
  ): Promise<OffchainDelegationView[]> {
    if (delegatorAddresses.length === 0) return [];
    const lowered = delegatorAddresses.map((a) => a.toLowerCase());
    const rows = await this.db
      .selectFrom('snapshot_delegation')
      .selectAll()
      .where('delegator_address', 'in', lowered)
      .where((eb) =>
        eb.or([
          eb('dao_id', '=', daoId),
          eb.and([
            eb('dao_id', 'is', null),
            eb('delegation_system', '=', DELEGATION_SYSTEM.DELEGATE_REGISTRY),
          ]),
        ]),
      )
      .execute();

    return resolveActorCurrentDelegations(rows, this.now());
  }

  /** Current effective Snapshot relationships for one DAO's space, resolved to delegate actors. */
  async findCurrentRelationships(daoId: string): Promise<RelationshipDelegationView[]> {
    const source = await this.db
      .selectFrom('dao_source')
      .select('source_config')
      .where('dao_id', '=', daoId)
      .where('source_type', '=', 'snapshot')
      .executeTakeFirst();
    const space = asSourceConfigObject(source?.source_config)['space'];
    if (typeof space !== 'string' || space.length === 0) return [];

    const rows = await this.db
      .selectFrom('snapshot_delegation')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb('dao_id', '=', daoId),
          eb.and([
            eb('dao_id', 'is', null),
            eb('delegation_system', '=', DELEGATION_SYSTEM.DELEGATE_REGISTRY),
          ]),
        ]),
      )
      .execute();

    const current = resolveCurrentRelationshipsForSpace(rows, space, this.now());
    const actorIdByAddress = await this.identity.findCurrentActorIdsByAddresses(
      current.map((edge) => edge.delegate_address),
    );

    return current.flatMap((edge) => {
      const delegateActorId = actorIdByAddress.get(edge.delegate_address) ?? null;
      return delegateActorId === null
        ? []
        : [
            {
              delegator_address: edge.delegator_address,
              delegate_actor_id: delegateActorId,
            },
          ];
    });
  }
}

export interface CurrentSnapshotRelationship {
  delegator_address: string;
  delegate_address: string;
}

/** Resolve the relationships that apply to a specific Snapshot space. */
export function resolveCurrentRelationshipsForSpace(
  rows: readonly SnapshotDelegation[],
  space: string,
  asOf: Date,
): CurrentSnapshotRelationship[] {
  const groups = new Map<string, SnapshotDelegation[]>();
  for (const row of rows) {
    const key = `${row.delegator_address}|${row.network}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }

  const out: CurrentSnapshotRelationship[] = [];
  for (const group of groups.values()) {
    const sample = group[0];
    if (sample === undefined) continue;

    const registry = resolveCurrentDelegateRegistry(
      group.filter((row) => row.delegation_system === DELEGATION_SYSTEM.DELEGATE_REGISTRY),
      space,
    );
    if (registry !== null) {
      out.push({
        delegator_address: sample.delegator_address,
        delegate_address: registry.delegate_address.toLowerCase(),
      });
    }

    const split = resolveCurrentSplit(
      group.filter(
        (row) =>
          row.delegation_system === DELEGATION_SYSTEM.SPLIT_DELEGATION && row.space_id === space,
      ),
      asOf,
    );
    for (const delegate of split) {
      out.push({
        delegator_address: sample.delegator_address,
        delegate_address: delegate.delegate_address.toLowerCase(),
      });
    }
  }
  return out;
}

// Pure: group by (delegator, space, system) and resolve the current active delegate set per group.
export function resolveActorCurrentDelegations(
  rows: readonly SnapshotDelegation[],
  asOf: Date,
): OffchainDelegationView[] {
  const groups = new Map<string, SnapshotDelegation[]>();
  for (const r of rows) {
    const key = `${r.delegator_address}|${r.space_id ?? ''}|${r.delegation_system}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [r]);
    else group.push(r);
  }

  const out: OffchainDelegationView[] = [];
  for (const group of groups.values()) {
    const sample = group[0];
    if (sample === undefined) continue;
    if (sample.delegation_system === DELEGATION_SYSTEM.SPLIT_DELEGATION) {
      for (const cur of resolveCurrentSplit(group, asOf)) out.push(toView(sample, cur));
    } else {
      const latest = latestByCoordinate(group);
      if (latest !== undefined && latest.event_type === DELEGATION_EVENT_TYPE.SET) {
        out.push(
          toView(latest, {
            delegate_address: latest.delegate_address,
            weight: latest.weight,
            expires_at: latest.expires_at,
          }),
        );
      }
    }
  }
  return out;
}

function latestByCoordinate(rows: readonly SnapshotDelegation[]): SnapshotDelegation | undefined {
  return rows.reduce<SnapshotDelegation | undefined>(
    (best, r) => (best === undefined || coordKey(r) > coordKey(best) ? r : best),
    undefined,
  );
}

function coordKey(row: SnapshotDelegation): string {
  return `${row.block_number.padStart(20, '0')}:${String(row.log_index).padStart(10, '0')}`;
}

function toView(row: SnapshotDelegation, cur: CurrentDelegate): OffchainDelegationView {
  return {
    platform: 'snapshot',
    system: row.delegation_system,
    scope: row.space_id,
    network: row.network,
    delegate_address: cur.delegate_address,
    weight: cur.weight,
    expires_at: isoSeconds(cur.expires_at),
  };
}
