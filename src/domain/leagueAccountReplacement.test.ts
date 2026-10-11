import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanLeagueSnapshot } from '../services/leagueOpsFixtures.test-support.js';
import { buildLeagueAccountReplacementPlan } from './leagueAccountReplacement.js';

export function accountReplacementFixture() {
  const snapshot = cleanLeagueSnapshot();
  snapshot.rosters[0]!.rosterStatus = 'Captain';
  snapshot.names[0]!.leagueStatus = 'Captain';
  snapshot.discordMembers = snapshot.discordMembers.filter((member) => member.discordId !== 'one');
  const member = { guildId: 'g', bot: false, discordId: 'new', displayName: 'One', roleIds: ['a', 'division', 'unmanaged-staff'] };
  snapshot.discordMembers.push(member);
  return { snapshot, oldMember: null, newMember: member, guildId: 'g', oldDiscordId: 'one', newDiscordId: 'new', newNameSheetRow: 8 };
}

test('account replacement preserves the existing captain slot and old aliases without a roster move', () => {
  const input = accountReplacementFixture();
  const before = structuredClone(input);
  const plan = buildLeagueAccountReplacementPlan(input);
  assert.deepEqual(input, before, 'preview must be read-only');
  assert.deepEqual(plan.rosterAfter, { ...input.snapshot.rosters[0], discordId: 'new' });
  assert.equal(plan.oldNameAfter.discordId, 'one');
  assert.equal(plan.oldNameAfter.nameStatus, 'Previous / Alternate');
  assert.equal(plan.oldNameAfter.knownName, 'One');
  assert.deepEqual(plan.newName, { ...input.snapshot.names[0], sheetRow: 8, discordId: 'new' });
  assert.deepEqual(plan.publicChanges, []);
  assert.deepEqual(plan.roles[0]?.remove, []);
  assert.deepEqual(plan.roles[0]?.add, []);
  assert.ok(plan.manualReview.some((item) => item.includes('captain')));
});

test('account replacement rejects unsafe identity, roster and configured-role states without changing input', () => {
  const cases: Array<[string, (input: ReturnType<typeof accountReplacementFixture>) => void]> = [
    ['same ID', (i) => { i.newDiscordId = i.oldDiscordId; }],
    ['wrong guild', (i) => { i.newMember.guildId = 'other'; }],
    ['bot target', (i) => { i.newMember.bot = true; }],
    ['duplicate current names', (i) => { i.snapshot.names.push({ ...i.snapshot.names[0]!, sheetRow: 20 }); }],
    ['duplicate old roster', (i) => { i.snapshot.rosters.push({ ...i.snapshot.rosters[0]!, sheetRow: 20 }); }],
    ['used target roster', (i) => { i.snapshot.rosters[1]!.discordId = 'new'; }],
    ['used target name', (i) => { i.snapshot.names[1]!.discordId = 'new'; }],
    ['target in another team', (i) => { i.newMember.roleIds = ['b', 'division']; }],
    ['ambiguous team role', (i) => { i.snapshot.teams[1]!.teamRoleId = 'a'; }],
    ['role ownership overlap', (i) => { i.snapshot.freeAgentRoleId = 'a'; }],
    ['wrong current name assignment', (i) => { i.snapshot.names[0]!.leagueStatus = 'Player'; }],
    ['occupied name row', (i) => { i.newNameSheetRow = 7; }],
    ['unrelated public drift', (i) => { i.snapshot.publicRosters.Vanaheim!.teams.B = []; }],
  ];
  for (const [label, change] of cases) {
    const input = accountReplacementFixture();
    change(input);
    const before = structuredClone(input);
    assert.throws(() => buildLeagueAccountReplacementPlan(input), label);
    assert.deepEqual(input, before);
  }
});

test('present old accounts lose only managed roles and changed names are explicit in the preview', () => {
  const input = accountReplacementFixture();
  const oldMember = { guildId: 'g', bot: false, discordId: 'one', displayName: 'One', roleIds: ['a', 'division', 'captain-access'] };
  input.snapshot.discordMembers.push(oldMember);
  input.newMember.displayName = 'One New';
  input.newMember.roleIds = ['fa', 'unmanaged-staff'];
  const plan = buildLeagueAccountReplacementPlan({ ...input, oldMember });
  assert.equal(plan.rosterAfter.rosterStatus, 'Captain');
  assert.equal(plan.rosterAfter.player, 'One New');
  assert.deepEqual(plan.publicChanges, [{ division: 'Vanaheim', area: 'team', group: 'A', from: 'One', to: 'One New' }]);
  assert.deepEqual(plan.roles.find((role) => role.discordId === 'one')?.remove, ['a', 'division']);
  assert.deepEqual(plan.roles.find((role) => role.discordId === 'new')?.remove, ['fa']);
  assert.deepEqual(plan.roles.find((role) => role.discordId === 'new')?.add, ['a', 'division']);
  assert.ok(plan.manualReview.some((item) => item.includes('captain-access')), 'preview must identify unmapped access for manual review');
});
