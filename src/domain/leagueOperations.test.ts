import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditLeagueRoster,
  buildDropPlan,
  buildPickupPlan,
  buildRenamePlan,
  buildTradePlan,
  type LeagueSnapshot,
} from './leagueOperations.js';

const teams = [
  {
    teamKey: 'Vanaheim|Dream Walkers', franchise: 'Dream Walkers', division: 'Vanaheim',
    teamRoleId: 'team-a', teamRole: 'Dream Walkers VD', divisionRoleId: 'division-v', active: true,
  },
  {
    teamKey: 'Vanaheim|The Sewer', franchise: 'The Sewer', division: 'Vanaheim',
    teamRoleId: 'team-b', teamRole: 'The Sewer VD', divisionRoleId: 'division-v', active: true,
  },
] as const;

function snapshot(): LeagueSnapshot {
  return {
    teams: teams.map((team) => ({ ...team })),
    rosters: [
      { sheetRow: 6, division: 'Vanaheim', franchise: 'Dream Walkers', teamRoleId: 'team-a', team: 'Dream Walkers VD', discordId: 'one', player: 'OneLive', rosterStatus: 'Captain' },
      { sheetRow: 7, division: 'Vanaheim', franchise: 'The Sewer', teamRoleId: 'team-b', team: 'The Sewer VD', discordId: 'two', player: 'TwoLive', rosterStatus: 'Player' },
    ],
    names: [
      { sheetRow: 6, discordId: 'one', currentLeagueName: 'One', knownName: 'OneLive', nameStatus: 'Current Discord Name', division: 'Vanaheim', franchise: 'Dream Walkers', leagueStatus: 'Captain' },
      { sheetRow: 7, discordId: 'two', currentLeagueName: 'Two', knownName: 'TwoLive', nameStatus: 'Current Discord Name', division: 'Vanaheim', franchise: 'The Sewer', leagueStatus: 'Player' },
      { sheetRow: 8, discordId: 'free', currentLeagueName: 'Free', knownName: 'FreeLive', nameStatus: 'Current Discord Name', division: 'Vanaheim', franchise: '', leagueStatus: 'Free Agent' },
    ],
    discordMembers: [
      { discordId: 'one', displayName: 'OneLive', roleIds: ['team-a', 'division-v'] },
      { discordId: 'two', displayName: 'TwoLive', roleIds: ['team-b', 'division-v'] },
      { discordId: 'free', displayName: 'FreeLive', roleIds: ['free-agent', 'division-v'] },
    ],
    publicRosters: {
      Vanaheim: {
        teams: { 'Dream Walkers': ['One'], 'The Sewer': ['Two'] },
        freeAgents: ['Free'],
      },
    },
    freeAgentRoleId: 'free-agent',
  };
}

test('daily audit accepts matching Discord, admin roster, canonical names, and public roster', () => {
  assert.deepEqual(auditLeagueRoster(snapshot()), []);
});

test('daily audit reports Discord and public-sheet drift instead of normalizing it', () => {
  const current = snapshot();
  current.discordMembers[0]!.roleIds = ['team-b', 'division-v'];
  current.publicRosters.Vanaheim!.teams['Dream Walkers'] = ['Unexpected'];
  const issues = auditLeagueRoster(current);
  assert.ok(issues.some((issue) => issue.includes('one') && issue.includes('team role')));
  assert.ok(issues.some((issue) => issue.includes('Dream Walkers') && issue.includes('public roster')));
});

test('daily audit rejects contradictory free-agent and roster roles', () => {
  const current = snapshot();
  current.discordMembers[0]!.roleIds.push('free-agent');
  current.discordMembers[2]!.roleIds = ['division-v'];
  const issues = auditLeagueRoster(current);
  assert.ok(issues.some((issue) => issue.includes('one') && issue.includes('Free Agent role')));
  assert.ok(issues.some((issue) => issue.includes('free') && issue.includes('missing the Free Agent role')));
});

test('daily audit rejects stale current-name assignment metadata for a rostered player', () => {
  const current = snapshot();
  const name = current.names.find((row) => row.discordId === 'one')!;
  name.division = 'Alfheim';
  name.franchise = 'The Sewer';
  name.leagueStatus = 'Player';
  const issues = auditLeagueRoster(current);
  assert.ok(issues.some((issue) => issue.includes('one') && issue.includes('Current Rosters assignment')));
});

test('trade swaps team assignments and exact public cells while preserving captain status', () => {
  const plan = buildTradePlan(snapshot(), 'one', 'two');
  assert.equal(plan.rosters.find((row) => row.discordId === 'one')?.teamRoleId, 'team-b');
  assert.equal(plan.rosters.find((row) => row.discordId === 'one')?.rosterStatus, 'Captain');
  assert.equal(plan.rosters.find((row) => row.discordId === 'two')?.teamRoleId, 'team-a');
  assert.deepEqual(plan.publicChanges, [
    { division: 'Vanaheim', area: 'team', group: 'Dream Walkers', from: 'One', to: 'Two' },
    { division: 'Vanaheim', area: 'team', group: 'The Sewer', from: 'Two', to: 'One' },
  ]);
});

test('drop removes the roster assignment, adds the free-agent role, and preserves division', () => {
  const plan = buildDropPlan(snapshot(), 'two');
  assert.equal(plan.rosters.some((row) => row.discordId === 'two'), false);
  assert.deepEqual(plan.discordRoleChanges, [{ discordId: 'two', remove: ['team-b'], add: ['free-agent'] }]);
  assert.equal(plan.nameUpdates.find((row) => row.discordId === 'two')?.leagueStatus, 'Free Agent');
  assert.deepEqual(plan.publicChanges, [
    { division: 'Vanaheim', area: 'team', group: 'The Sewer', from: 'Two', to: '' },
    { division: 'Vanaheim', area: 'free-agent', group: 'Free Agents', from: '', to: 'Two' },
  ]);
});

test('pickup fills the configured team, removes free-agent role, and rejects an occupied player', () => {
  const plan = buildPickupPlan(snapshot(), 'free', 'team-a');
  assert.equal(plan.rosters.find((row) => row.discordId === 'free')?.teamRoleId, 'team-a');
  assert.deepEqual(plan.discordRoleChanges, [{ discordId: 'free', remove: ['free-agent'], add: ['team-a'] }]);
  assert.throws(() => buildPickupPlan(snapshot(), 'one', 'team-b'), /not a free agent/i);
});

test('rename changes the canonical name everywhere while retaining the old canonical name as history', () => {
  const plan = buildRenamePlan(snapshot(), 'one', 'One Prime');
  assert.ok(plan.nameUpdates.filter((row) => row.discordId === 'one').every((row) => row.currentLeagueName === 'One Prime'));
  assert.equal(plan.nameHistoryAppend?.knownName, 'One');
  assert.deepEqual(plan.publicChanges, [
    { division: 'Vanaheim', area: 'team', group: 'Dream Walkers', from: 'One', to: 'One Prime' },
  ]);
});

test('rename rejects a canonical name already used in the same managed roster area', () => {
  const current = snapshot();
  const secondRoster = current.rosters.find((row) => row.discordId === 'two')!;
  secondRoster.teamRoleId = 'team-a';
  secondRoster.team = 'Dream Walkers VD';
  secondRoster.franchise = 'Dream Walkers';
  assert.throws(() => buildRenamePlan(current, 'one', 'Two'), /already used by another player/i);
});
