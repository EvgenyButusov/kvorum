// Presentation-only motion-type labels for Easy Track factories, keyed by lowercase address.
// Never a factory allowlist: the registered set is data the ingester reads from each
// `MotionCreated`, and an unlabelled factory degrades to its address.
// Each label is the deployed contract's verified name in prose (evidence in VERIFICATION.md);
// repeats are separate deployments of one motion type, told apart only by a registry with no name.
const EASY_TRACK_FACTORY_LABELS = new Map<string, string>([
  ['0xcbb418f6f9bfd3525ce6aade8f74ecfefe2db5c8', 'Activate node operators'],
  ['0x00a3d6260f70b1660c8646ef25d0820effd7be60', 'Add MEV-Boost relays'],
  ['0x1f809d2cb72a5ab13778811742050eda876129b6', 'Add allowed recipient'],
  ['0x48c135ff690c2aa7f5b11c539104b5855a4f9252', 'Add allowed recipient'],
  ['0x935cb3366faf2cfc415b2099d1f974fd27202b77', 'Add allowed recipient'],
  ['0xcaa3af7460e83e665eefec73a7a542e5005c9639', 'Add node operators'],
  ['0x37d9b09eda477a84e3913fcb4d032efb0bf9b62e', 'Alter tiers in the operator grid'],
  ['0xe31a0599a6772bcf9b2bfc9e25cf941e793c9a7d', 'Change node operator managers'],
  ['0x8b82c1546d47330335a48406cc3a50da732672e7', 'Deactivate node operators'],
  ['0x6b7863f2c7dee99d3b744fdaedbeb1aecc025535', 'Edit MEV-Boost relays'],
  ['0x6f5c0a5a824773e8f8285bc5aa59ea0aab2a6400', 'Force validator exits in the vault hub'],
  ['0xfebd8fac16de88206d4b18764e826af38546afe0', 'Increase node operator staking limit'],
  ['0x17305db55c908e84c58bbdca57258a7d1f7eea7c', 'Register groups in the operator grid'],
  ['0x6b535f441f95046562406f4e2518d9ad7db2dc0d', 'Register tiers in the operator grid'],
  ['0x9721c0f77e3ea40ed592b9dcf3032daf269c0306', 'Remove MEV-Boost relays'],
  ['0x22010d1747cafc370b1f1fbba61022a313c5693b', 'Remove allowed recipient'],
  ['0x7e8effab3083fb26ace6832bfca4c377905f97d7', 'Remove allowed recipient'],
  ['0xd30dc38edefc21875257e8a3123503075226e14b', 'Remove allowed recipient'],
  ['0x6a4f33f05e7412a11100353724bb6a152cf0d305', 'Set jail status in the operator grid'],
  ['0x7d509bff310d9460b1f613e4e40d342201a83ae4', 'Set node operator names'],
  ['0x589e298964b9181d9938b84bb034c3bb9024e2c0', 'Set node operator reward addresses'],
  ['0xbc5642bdd6f2a54b01a75605aae9143525d97308', 'Set the CSM vetted gate tree'],
  ['0xd75778b855886fc5e1ea7d6bfada9eb68b35c19d', 'Set vetted validators limits'],
  ['0xf6b6e7997338c48ea3a8bcfa4bb64a315fda76f4', 'Settle CSM EL stealing penalty'],
  ['0xaf35a63a4114b7481589fdd9fdb3e35fd65faed7', 'Socialise bad debt in the vault hub'],
  ['0x58a59ddc6aea9b1d5743d024e15dfa4badb56e37', 'Submit exit request hashes (SDVT)'],
  ['0x4f716ad3cc7a3a5cda2359e5b2c84335c171dcde', 'Submit exit request hashes (curated)'],
  ['0x00caaef11ec545b192f16313f53912e453c91458', 'Top up allowed recipients'],
  ['0x0d2aefa542afa8d9d1ec35376068b88042fef5f6', 'Top up allowed recipients'],
  ['0x1f2b79fe297b7098875930bba6dd17068103897e', 'Top up allowed recipients'],
  ['0x200da0b6a9905a377cf8d469664c65db267009d1', 'Top up allowed recipients'],
  ['0x6ab39a8be67d9305799c3f8fdfc95caf3150d17c', 'Top up allowed recipients'],
  ['0x6e04aed774b7c89bb43721acdd7d03c872a51b69', 'Top up allowed recipients'],
  ['0xbd08f9d6bf1d25cc7407e4855df1d46c2043b3ea', 'Top up allowed recipients'],
  ['0xbd2b6dc189eefd51b273f5cb2d99ba1ce565fb8c', 'Top up allowed recipients'],
  ['0xe1f6babb445f809b97e3505ea91749461050f780', 'Top up allowed recipients'],
  ['0xe5656eee7eed02bde009d77c88247bc8271e26eb', 'Top up allowed recipients'],
  ['0xf2476f967c826722f5505edfc4b2561a34033477', 'Top up allowed recipients'],
  ['0xf23559de8ab37ff7a154384b0822da867cfa7eac', 'Update group share limits in the operator grid'],
  ['0x161a4552a625844c822954c5acbac928ee0f399b', 'Update target validator limits'],
  ['0xdfa0bc38113b6d53c2881573fd764ceeff468610', 'Update vault fees in the operator grid'],
]);

export function easyTrackFactoryLabel(factoryAddress: string): string | null {
  return EASY_TRACK_FACTORY_LABELS.get(factoryAddress.toLowerCase()) ?? null;
}
