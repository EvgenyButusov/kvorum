# Easy Track — vendored ABI verification record

Terse, committed evidence that the ABI + addresses in this directory match the deployed mainnet
EasyTrack contract.

- **Canonical source:** the deployed, Etherscan-verified `EasyTrack` contract (no GitHub-tag pinning
  needed — see "immutable" below). Event ABI cross-checked against `lidofinance/easy-track`.
- **Live verification:** mainnet, 2026-06-28, via `eth.blockscout.com` (verified-contract ABI +
  `creation_transaction_hash`) and a public-RPC `eth_call` (`getEVMScriptFactories()`).

## Addresses (mainnet, chainId 0x1)

| Contract          | Address                                      | Deployed (block / date) | Notes                               |
| ----------------- | -------------------------------------------- | ----------------------- | ----------------------------------- |
| EasyTrack         | `0xF0211b7660680B49De1A7E9f25C65660F0a13Fea` | 13676729 / 2021-11-24   | emits every motion + settings event |
| EVMScriptExecutor | `0xFE5986E06210aC1eCC1aDCafc0cc7f8D63B3F977` | —                       | executes enacted scripts; no events |

- **Creation tx:** `0x55c4c7e33eb92da16871944879d52180c1a2e59c2701404abef864c5196ab7f1` (block 13676729).
  This block is the seed's `active_from_block` (lido_009_easy_track_seed).

## Verified facts

- **EasyTrack is a standalone, non-proxy / immutable contract** (verified-contract ABI is direct
  logic, not a proxy). So event signatures are stable across the whole `active_from_block`→now
  history — no multi-variant decode is needed (contrast Dual Governance's two `ProposalSubmitted`).
- **Inheritance:** `Pausable, AccessControl, MotionSettings, EVMScriptFactoriesRegistry` — so the
  settings events (`MotionDurationChanged` / `ObjectionsThresholdChanged` / `MotionsCountLimitChanged`)
  and `EVMScriptExecutorChanged` are emitted by the same address as the motion lifecycle. All nine are
  ingested.
- **`MotionObjected` arity confirmed** against the deployed ABI: five inputs
  `(_motionId indexed, _objector indexed, _weight, _newObjectionsAmount, _newObjectionsAmountPct)` —
  the `_newObjectionsAmountPct` field is present in the deployed contract, matching the vendored
  signature.
- **Event topic0 hashes** are locked in `abi/events.spec.ts` (CI-enforced). `MotionCreated` and
  `MotionEnacted` were additionally confirmed against real emitted logs (`abi/__fixtures__/real-logs.json`,
  decoded in `abi/decoder.real-fixtures.spec.ts`).

## Registered motion-factory set

The factory set is **data, not a constant**: the ingester archives each motion's
`_evmScriptFactory` from `MotionCreated`, and never hard-codes or filters by a factory list.
This record exists so the EVMScript-action decoder and the label registry below know which
factory targets to cover.

**Live pull:** `EasyTrack.getEVMScriptFactories()` via public RPC at block 26456731
(2026-11-20) returned **56 registered factories**. The previous pull (2026-06-28) returned 41;
17 have been registered since and 2 deregistered, confirming that the set drifts and must be
re-pulled rather than trusted from this file. `0xfebd8fac16de88206d4b18764e826af38546afe0` is
the factory carried by the real `MotionCreated` fixture (motion 1049).

Deregistered since the earlier pull, and deliberately still labelled below because the motions
they created remain:

- `0xbc5642bdd6f2a54b01a75605aae9143525d97308` (`CSMSetVettedGateTree`)
- `0xf6b6e7997338c48ea3a8bcfa4bb64a315fda76f4` (`CSMSettleElStealingPenalty`)

## Motion-factory labels

`factories.ts` maps each factory to a presentation-only motion-type label. Each label is the
deployed contract's own name, taken from its Blockscout-verified source on 2026-11-20
(`api/v2/smart-contracts/<address>`), together with the `decodeEVMScriptCallData` return
signature that says what the motion carries. The registry is keyed by address over the union of
both pulls — 58 addresses, of which 57 are labelled. Labels are not unique: several addresses
are separate deployments of one motion type.

| Verified contract name                  | `decodeEVMScriptCallData` returns           | Label                                          | Addresses                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ActivateNodeOperators`                 | `(tuple[])`                                 | Activate node operators                        | `0xcbb418f6f9bfd3525ce6aade8f74ecfefe2db5c8`                                                                                                                                                                                                                                                                                                 |
| `AddAllowedRecipient`                   | `(address,string)`                          | Add allowed recipient                          | `0x1f809d2cb72a5ab13778811742050eda876129b6`<br>`0x48c135ff690c2aa7f5b11c539104b5855a4f9252`<br>`0x935cb3366faf2cfc415b2099d1f974fd27202b77`<br>`0xe24230619e9218c1eed3de3489a22f6bc3ce18ff`                                                                                                                                                 |
| `AddMEVBoostRelays`                     | `(tuple[])`                                 | Add MEV-Boost relays                           | `0x00a3d6260f70b1660c8646ef25d0820effd7be60`                                                                                                                                                                                                                                                                                                 |
| `AddNodeOperators`                      | `(uint256,tuple[])`                         | Add node operators                             | `0xcaa3af7460e83e665eefec73a7a542e5005c9639`                                                                                                                                                                                                                                                                                                 |
| `AllowConsolidationPair`                | `(tuple)`                                   | Allow consolidation pair                       | `0x29e23b1ef0c9fffac8330f9abacebddd827e4b5c`                                                                                                                                                                                                                                                                                                 |
| `AlterTiersInOperatorGrid`              | `(uint256[],tuple[])`                       | Alter tiers in the operator grid               | `0x37d9b09eda477a84e3913fcb4d032efb0bf9b62e`                                                                                                                                                                                                                                                                                                 |
| `CSMSetVettedGateTree`                  | `(bytes32,string)`                          | Set the CSM vetted gate tree                   | `0xbc5642bdd6f2a54b01a75605aae9143525d97308` (deregistered)                                                                                                                                                                                                                                                                                  |
| `CSMSettleElStealingPenalty`            | `(uint256[])`                               | Settle CSM EL stealing penalty                 | `0xf6b6e7997338c48ea3a8bcfa4bb64a315fda76f4` (deregistered)                                                                                                                                                                                                                                                                                  |
| `ChangeNodeOperatorManagers`            | `(tuple[])`                                 | Change node operator managers                  | `0xe31a0599a6772bcf9b2bfc9e25cf941e793c9a7d`                                                                                                                                                                                                                                                                                                 |
| `CreateOrUpdateOperatorGroup`           | `(uint256,tuple,tuple)`                     | Create or update operator group                | `0x2fc78638b77381e9d040163bd6eb1cac967bdbdf`                                                                                                                                                                                                                                                                                                 |
| `CuratedSubmitExitRequestHashes`        | `(tuple[])`                                 | Submit exit request hashes (curated)           | `0x4f716ad3cc7a3a5cda2359e5b2c84335c171dcde`                                                                                                                                                                                                                                                                                                 |
| `DeactivateNodeOperators`               | `(tuple[])`                                 | Deactivate node operators                      | `0x8b82c1546d47330335a48406cc3a50da732672e7`                                                                                                                                                                                                                                                                                                 |
| `EditMEVBoostRelays`                    | `(tuple[])`                                 | Edit MEV-Boost relays                          | `0x6b7863f2c7dee99d3b744fdaedbeb1aecc025535`                                                                                                                                                                                                                                                                                                 |
| `ForceValidatorExitsInVaultHub`         | `(address[],bytes[])`                       | Force validator exits in the vault hub         | `0x6f5c0a5a824773e8f8285bc5aa59ea0aab2a6400`                                                                                                                                                                                                                                                                                                 |
| `IncreaseNodeOperatorStakingLimit`      | `(uint256,uint256)`                         | Increase node operator staking limit           | `0xfebd8fac16de88206d4b18764e826af38546afe0`                                                                                                                                                                                                                                                                                                 |
| `RegisterGroupsInOperatorGrid`          | `(address[],uint256[],tuple[][])`           | Register groups in the operator grid           | `0x17305db55c908e84c58bbdca57258a7d1f7eea7c`                                                                                                                                                                                                                                                                                                 |
| `RegisterTiersInOperatorGrid`           | `(address[],tuple[][])`                     | Register tiers in the operator grid            | `0x6b535f441f95046562406f4e2518d9ad7db2dc0d`                                                                                                                                                                                                                                                                                                 |
| `RemoveAllowedRecipient`                | `(address)`                                 | Remove allowed recipient                       | `0x22010d1747cafc370b1f1fbba61022a313c5693b`<br>`0x7e8effab3083fb26ace6832bfca4c377905f97d7`<br>`0xd30dc38edefc21875257e8a3123503075226e14b`<br>`0xf4d5d97c85ed18f77f99b57f55e9e11d52992632`                                                                                                                                                 |
| `RemoveMEVBoostRelays`                  | `(string[])`                                | Remove MEV-Boost relays                        | `0x9721c0f77e3ea40ed592b9dcf3032daf269c0306`                                                                                                                                                                                                                                                                                                 |
| `ReportWithdrawalsForSlashedValidators` | `(tuple[])`                                 | Report withdrawals for slashed validators      | `0x71862abd99819597670007bb992a7a7562fe50f2`<br>`0x8d74020d8eaccdff0366daaffb96e6c98cdfc112`<br>`0xe330516a03bddeba4209b5591112f1aa3dd90f0a`                                                                                                                                                                                                 |
| `SDVTSubmitExitRequestHashes`           | `(tuple[])`                                 | Submit exit request hashes (SDVT)              | `0x58a59ddc6aea9b1d5743d024e15dfa4badb56e37`                                                                                                                                                                                                                                                                                                 |
| `SetDepositsReserveTarget`              | `(uint256)`                                 | Set deposits reserve target                    | `0x62e9dc68bdcbc46362f40e0bb9c154c9a42e62b0`                                                                                                                                                                                                                                                                                                 |
| `SetJailStatusInOperatorGrid`           | `(address[],bool[])`                        | Set jail status in the operator grid           | `0x6a4f33f05e7412a11100353724bb6a152cf0d305`                                                                                                                                                                                                                                                                                                 |
| `SetMerkleGateTree`                     | `(address,bytes32,string,bytes32,string)`   | Set the Merkle gate tree                       | `0xa121667d1780a1d54eaed67ae17ee13d0f872d60`<br>`0xf3ec30b86c3dc1b8a1c754d885f9be3160e15b4c`                                                                                                                                                                                                                                                 |
| `SetNodeOperatorNames`                  | `(tuple[])`                                 | Set node operator names                        | `0x7d509bff310d9460b1f613e4e40d342201a83ae4`                                                                                                                                                                                                                                                                                                 |
| `SetNodeOperatorRewardAddresses`        | `(tuple[])`                                 | Set node operator reward addresses             | `0x589e298964b9181d9938b84bb034c3bb9024e2c0`                                                                                                                                                                                                                                                                                                 |
| `SetVettedValidatorsLimits`             | `(tuple[])`                                 | Set vetted validators limits                   | `0xd75778b855886fc5e1ea7d6bfada9eb68b35c19d`                                                                                                                                                                                                                                                                                                 |
| `SettleGeneralDelayedPenalty`           | `(tuple[])`                                 | Settle general delayed penalty                 | `0x0b676adeabcf4a696187cfab90290aa3ac51afa2`<br>`0xfffefc16231edc6dc9c93e364ff4d4e3f787f416`                                                                                                                                                                                                                                                 |
| `SocializeBadDebtInVaultHub`            | `(address[],address[],uint256[])`           | Socialise bad debt in the vault hub            | `0xaf35a63a4114b7481589fdd9fdb3e35fd65faed7`                                                                                                                                                                                                                                                                                                 |
| `TopUpAllowedRecipients`                | `(address,address[],uint256[])`             | Top up allowed recipients                      | `0x0d2aefa542afa8d9d1ec35376068b88042fef5f6`<br>`0x6ab39a8be67d9305799c3f8fdfc95caf3150d17c`<br>`0xc72d4c3e86b681d7c9ee306d41193c64d709c303`<br>`0xe1f6babb445f809b97e3505ea91749461050f780`<br>`0xe5656eee7eed02bde009d77c88247bc8271e26eb`<br>`0xf2476f967c826722f5505edfc4b2561a34033477`                                                 |
| `TopUpAllowedRecipients`                | `(address[],uint256[])`                     | Top up allowed recipients                      | `0x00caaef11ec545b192f16313f53912e453c91458`<br>`0x1f2b79fe297b7098875930bba6dd17068103897e`<br>`0x200da0b6a9905a377cf8d469664c65db267009d1`<br>`0x6e04aed774b7c89bb43721acdd7d03c872a51b69`<br>`0xa3e98cb26f1277b623edb95cee3bd33269b305f7`<br>`0xbd08f9d6bf1d25cc7407e4855df1d46c2043b3ea`<br>`0xbd2b6dc189eefd51b273f5cb2d99ba1ce565fb8c` |
| `UpdateGroupsShareLimitInOperatorGrid`  | `(address[],uint256[])`                     | Update group share limits in the operator grid | `0xf23559de8ab37ff7a154384b0822da867cfa7eac`                                                                                                                                                                                                                                                                                                 |
| `UpdateStakingModuleShareLimits`        | `(tuple)`                                   | Update staking module share limits             | `0x5b0de22e65c068430f6e769754d51133775408cc`<br>`0xde3e46e3129fa4e4e3f66c9024b0a3ad509b27a1`                                                                                                                                                                                                                                                 |
| `UpdateTargetValidatorLimits`           | `(tuple[])`                                 | Update target validator limits                 | `0x161a4552a625844c822954c5acbac928ee0f399b`                                                                                                                                                                                                                                                                                                 |
| `UpdateVaultsFeesInOperatorGrid`        | `(address[],uint256[],uint256[],uint256[])` | Update vault fees in the operator grid         | `0xdfa0bc38113b6d53c2881573fd764ceeff468610`                                                                                                                                                                                                                                                                                                 |

### Unlabelled

`0xb71755be764abb4ce26cb4dadf056be57fb8880f` is registered but has no label. Blockscout returns HTTP 500 for it, Sourcify has no
match, and its deployed bytecode is unique among the registered set, so there is no verified
contract name to take one from. It renders as its address until a source appears.

The recipient-family factories (`TopUpAllowedRecipients`, `AddAllowedRecipient`,
`RemoveAllowedRecipient`) differ only in the `allowedRecipientsRegistry()` they serve — one per
budget programme. Those registries carry no name on-chain, so the budget is deliberately absent
from the label rather than sourced from a docs page; the motion's decoded actions carry the
recipients and amounts.
