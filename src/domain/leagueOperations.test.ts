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
      { sheetRow: 6, division: 'Vanaheim', franchise: 'Dream Walkers', teamRoleId: 'team-a', team: 'Dream Walkers VD', discordId: 'one', player: 'One', rosterStatus: 'Captain' },
      { sheetRow: 7, division: 'Vanaheim', franchise: 'The Sewer', teamRoleId: 'team-b', team: 'The Sewer VD', discordId: 'two', player: 'Two', rosterStatus: 'Player' },
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

test('daily audit rejects additional configured division roles', () => {
  const current = snapshot();
  current.teams.push({
    teamKey: 'Alfheim|Elsewhere', franchise: 'Elsewhere', division: 'Alfheim',
    teamRoleId: 'team-c', teamRole: 'Elsewhere AD', divisionRoleId: 'division-a', active: true,
  });
  current.discordMembers[0]!.roleIds.push('division-a');
  current.discordMembers[2]!.roleIds.push('division-a');
  const issues = auditLeagueRoster(current);
  assert.ok(issues.some((issue) => issue.includes('one') && issue.includes('division roles')));
  assert.ok(issues.some((issue) => issue.includes('free') && issue.includes('division roles')));
});

test('daily audit rejects duplicate active team mappings to one public roster block', () => {
  const current = snapshot();
  current.teams.push({
    teamKey: 'Vanaheim|Dream Walkers duplicate', franchise: 'Dream Walkers', division: 'Vanaheim',
    teamRoleId: 'team-c', teamRole: 'Dream Walkers Alternate VD', divisionRoleId: 'division-v', active: true,
  });
  const issues = auditLeagueRoster(current);
  assert.ok(issues.some((issue) => issue.includes('Vanaheim Dream Walkers') && issue.includes('more than one active team')));
});

test('daily audit rejects ambiguous division-role mappings', () => {
  const reusedRole = snapshot();
  reusedRole.teams.push({
    teamKey: 'Alfheim|Elsewhere', franchise: 'Elsewhere', division: 'Alfheim',
    teamRoleId: 'team-c', teamRole: 'Elsewhere AD', divisionRoleId: 'division-v', active: true,
  });
  assert.ok(auditLeagueRoster(reusedRole)
    .some((issue) => issue.includes('division-v') && issue.includes('Vanaheim') && issue.includes('Alfheim')));

  const splitDivision = snapshot();
  splitDivision.teams.push({
    teamKey: 'Vanaheim|Elsewhere', franchise: 'Elsewhere', division: 'Vanaheim',
    teamRoleId: 'team-c', teamRole: 'Elsewhere VD', divisionRoleId: 'division-other', active: true,
  });
  assert.ok(auditLeagueRoster(splitDivision)
    .some((issue) => issue.includes('Vanaheim') && issue.includes('more than one division role')));
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

test('daily audit rejects a current player without exactly one roster assignment', () => {
  const current = snapshot();
  current.rosters = current.rosters.filter((row) => row.discordId !== 'two');
  current.discordMembers.find((member) => member.discordId === 'two')!.roleIds = ['division-v'];
  current.publicRosters.Vanaheim!.teams['The Sewer'] = [];
  const issues = auditLeagueRoster(current);
  assert.ok(issues.some((issue) => issue.includes('two') && issue.includes('exactly one Current Rosters assignment')));
});

test('daily audit rejects a roster display name that differs from the canonical league name', () => {
  const current = snapshot();
  current.rosters[0]!.player = 'Stale Name';
  const issues = auditLeagueRoster(current);
  assert.ok(issues.some((issue) => issue.includes('one') && issue.includes('Current League Name')));
});

test('daily audit rejects duplicate canonical names within managed team and free-agent areas', () => {
  const rostered = snapshot();
  rostered.rosters.push({
    sheetRow: 9, division: 'Vanaheim', franchise: 'Dream Walkers', teamRoleId: 'team-a',
    team: 'Dream Walkers VD', discordId: 'three', player: 'One', rosterStatus: 'Player',
  });
  rostered.names.push({
    sheetRow: 9, discordId: 'three', currentLeagueName: 'One', knownName: 'ThreeLive',
    nameStatus: 'Current Discord Name', division: 'Vanaheim', franchise: 'Dream Walkers', leagueStatus: 'Player',
  });
  rostered.discordMembers.push({ discordId: 'three', displayName: 'ThreeLive', roleIds: ['team-a', 'division-v'] });
  rostered.publicRosters.Vanaheim!.teams['Dream Walkers'] = ['One', 'One'];
  assert.ok(auditLeagueRoster(rostered)
    .some((issue) => issue.includes('Dream Walkers') && issue.includes('duplicate current player names')));

  const freeAgents = snapshot();
  freeAgents.names.push({
    sheetRow: 9, discordId: 'another-free', currentLeagueName: 'Free', knownName: 'AnotherFreeLive',
    nameStatus: 'Current Discord Name', division: 'Vanaheim', franchise: '', leagueStatus: 'Free Agent',
  });
  freeAgents.discordMembers.push({ discordId: 'another-free', displayName: 'AnotherFreeLive', roleIds: ['free-agent', 'division-v'] });
  freeAgents.publicRosters.Vanaheim!.freeAgents = ['Free', 'Free'];
  assert.ok(auditLeagueRoster(freeAgents)
    .some((issue) => issue.includes('Vanaheim free agents') && issue.includes('duplicate current player names')));
});

test('daily audit rejects stale franchise metadata for a free agent', () => {
  const current = snapshot();
  current.names.find((row) => row.discordId === 'free')!.franchise = 'Dream Walkers';
  const issues = auditLeagueRoster(current);
  assert.ok(issues.some((issue) => issue.includes('free') && issue.includes('franchise assignment')));
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

test('moves reject canonical names already used in their destination roster area', () => {
  const pickup = snapshot();
  pickup.names.find((row) => row.discordId === 'free')!.currentLeagueName = 'One';
  assert.throws(() => buildPickupPlan(pickup, 'free', 'team-a'), /already used in the destination roster area/i);

  const drop = snapshot();
  drop.names.find((row) => row.discordId === 'free')!.currentLeagueName = 'Two';
  assert.throws(() => buildDropPlan(drop, 'two'), /already used in the destination free-agent area/i);
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
