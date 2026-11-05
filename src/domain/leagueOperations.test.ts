import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditLeagueRoster,
  buildDeparturePlan,
  buildDiscordRenamePlan,
  buildDropPlan,
  buildOneWayTradePlan,
  buildPickupPlan,
  buildRenamePlan,
  buildSelfDropPlan,
  buildTradePlan,
  SELF_DROP_LEAGUE_STATUS,
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
      { discordId: 'one', displayName: 'One', roleIds: ['team-a', 'division-v'] },
      { discordId: 'two', displayName: 'Two', roleIds: ['team-b', 'division-v'] },
      { discordId: 'free', displayName: 'Free', roleIds: ['free-agent', 'division-v'] },
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

// #198 / ADR 0002: Niflheim memberships are layered on the player's Svartalfheim record.
function layeredSnapshot(): LeagueSnapshot {
  const current = snapshot();
  current.teams.push(
    { teamKey: 'Svartalfheim|Little Monsters', franchise: 'Little Monsters', division: 'Svartalfheim', teamRoleId: 'team-s-lm', teamRole: 'Little Monsters SD', divisionRoleId: 'division-s', active: true },
    { teamKey: 'Niflheim|Something Spicy', franchise: 'Something Spicy', division: 'Niflheim', teamRoleId: 'team-n-ss', teamRole: 'Something Spicy ND', divisionRoleId: 'division-n', active: true },
    { teamKey: 'Niflheim|Little Monsters', franchise: 'Little Monsters', division: 'Niflheim', teamRoleId: 'team-n-lm', teamRole: 'Little Monsters ND', divisionRoleId: 'division-n', active: true },
  );
  current.rosters.push(
    { sheetRow: 8, division: 'Svartalfheim', franchise: 'Little Monsters', teamRoleId: 'team-s-lm', team: 'Little Monsters SD', discordId: 'qronch', player: 'Qronch', rosterStatus: 'Player' },
    { sheetRow: 9, division: 'Niflheim', franchise: 'Something Spicy', teamRoleId: 'team-n-ss', team: 'Something Spicy ND', discordId: 'qronch', player: 'Qronch', rosterStatus: 'Captain' },
    { sheetRow: 10, division: 'Niflheim', franchise: 'Something Spicy', teamRoleId: 'team-n-ss', team: 'Something Spicy ND', discordId: 'faye', player: 'Faye', rosterStatus: 'Player' },
  );
  current.names.push(
    { sheetRow: 9, discordId: 'qronch', currentLeagueName: 'Qronch', knownName: 'Qronch', nameStatus: 'Current Discord Name', division: 'Svartalfheim', franchise: 'Little Monsters', leagueStatus: 'Player' },
    { sheetRow: 10, discordId: 'faye', currentLeagueName: 'Faye', knownName: 'Faye', nameStatus: 'Current Discord Name', division: 'Svartalfheim', franchise: '', leagueStatus: 'Free Agent' },
  );
  current.discordMembers.push(
    { discordId: 'qronch', displayName: 'Qronch', roleIds: ['team-s-lm', 'division-s', 'team-n-ss', 'division-n'] },
    { discordId: 'faye', displayName: 'Faye', roleIds: ['free-agent', 'division-s', 'team-n-ss', 'division-n'] },
  );
  current.publicRosters.Svartalfheim = { teams: { 'Little Monsters': ['Qronch'] }, freeAgents: ['Faye'] };
  current.publicRosters.Niflheim = { teams: { 'Something Spicy': ['Qronch', 'Faye'], 'Little Monsters': [] }, freeAgents: [] };
  return current;
}

const member = (current: LeagueSnapshot, id: string) => current.discordMembers.find((entry) => entry.discordId === id)!;

test('layered Niflheim memberships pass a clean audit on the free-agent and rostered paths', () => {
  assert.deepEqual(auditLeagueRoster(layeredSnapshot()), []);
});

test('layered Niflheim rule violations are reported', () => {
  const cases: Array<[string, (current: LeagueSnapshot) => void, string]> = [
    ['two Niflheim rows', (c) => c.rosters.push({ ...c.rosters.at(-1)!, sheetRow: 11, franchise: 'Little Monsters', teamRoleId: 'team-n-lm', team: 'Little Monsters ND' }),
      'Discord member faye has more than one Niflheim roster assignment.'],
    ['Vanaheim primary', (c) => { c.rosters.push({ ...c.rosters.at(-1)!, sheetRow: 12, discordId: 'one', player: 'One' }); member(c, 'one').roleIds.push('team-n-ss', 'division-n'); c.publicRosters.Niflheim!.teams['Something Spicy']!.push('One'); },
      'Niflheim roster member one is not a current Svartalfheim player or free agent.'],
    ['Inactive primary', (c) => { c.names.at(-1)!.leagueStatus = 'Inactive'; },
      'Niflheim roster member faye is not a current Svartalfheim player or free agent.'],
    ['team role without row', (c) => { member(c, 'free').roleIds.push('team-n-lm'); },
      'Discord member free Niflheim team role does not match Current Rosters.'],
    ['row without team role', (c) => { member(c, 'faye').roleIds = ['free-agent', 'division-s', 'division-n']; },
      'Discord member faye is on a Niflheim roster without its team role.'],
    ['division role without row', (c) => { member(c, 'free').roleIds.push('division-n'); },
      'Discord member free Niflheim division role does not match Current Rosters.'],
    ['two Niflheim team roles', (c) => { member(c, 'faye').roleIds.push('team-n-lm'); },
      'Discord member faye has multiple Niflheim team roles.'],
    ['Free Agent on a rostered player', (c) => { member(c, 'qronch').roleIds.push('free-agent'); },
      'Discord member qronch is rostered but still has the Free Agent role.'],
    ['Niflheim public block', (c) => { c.publicRosters.Niflheim!.teams['Something Spicy'] = ['Qronch']; },
      'Niflheim Something Spicy public roster does not match Current Rosters.'],
    ['Svartalfheim free-agent list', (c) => { c.publicRosters.Svartalfheim!.freeAgents = []; },
      'Svartalfheim public free-agent list does not match Player Name History.'],
  ];
  for (const [name, mutate, expected] of cases) {
    const current = layeredSnapshot();
    mutate(current);
    assert.ok(auditLeagueRoster(current).includes(expected), `${name}: ${auditLeagueRoster(current).join(' | ')}`);
  }
});

test('Svartalfheim moves for a layered player leave the Niflheim row untouched', () => {
  const current = layeredSnapshot();
  const niflheim = (plan: { rosters: LeagueSnapshot['rosters'] }) => plan.rosters.filter((row) => row.division === 'Niflheim');
  // Qronch is on both rosters, so a drop must say which (#200).
  assert.throws(() => buildDropPlan(current, 'qronch'), /plays in Svartalfheim and Niflheim\. Choose the division option/);
  const drop = buildDropPlan(current, 'qronch', undefined, 'Svartalfheim');
  assert.deepEqual(niflheim(drop), niflheim(current));
  assert.deepEqual(drop.discordRoleChanges, [{ discordId: 'qronch', remove: ['team-s-lm'], add: ['free-agent'] }]);
  const pickup = buildPickupPlan(current, 'faye', 'team-s-lm');
  assert.deepEqual(niflheim(pickup), niflheim(current));
  assert.throws(() => buildPickupPlan(current, 'faye', 'team-n-lm'), /already on a Niflheim team/);
  const rename = buildRenamePlan(current, 'faye', 'Faye Prime');
  assert.deepEqual(rename.rosters.filter((row) => row.discordId === 'faye').map((row) => row.player), ['Faye Prime']);
  assert.deepEqual(rename.publicChanges.map((change) => [change.division, change.area, change.group]),
    [['Svartalfheim', 'free-agent', 'Free Agents'], ['Niflheim', 'team', 'Something Spicy']]);
});

test('daily audit reports one name issue when managed sheets do not use the current Discord name', () => {
  const current = snapshot();
  current.discordMembers[0]!.displayName = 'OneLive';

  const issues = auditLeagueRoster(current);

  assert.deepEqual(
    issues.filter((issue) => issue.includes('one') && /name/i.test(issue)),
    ['Managed player names for one do not match the current Discord display name.'],
  );
});

test('daily audit reports Discord and public-sheet drift instead of normalizing it', () => {
  const current = snapshot();
  current.discordMembers[0]!.roleIds = ['team-b', 'division-v'];
  current.publicRosters.Vanaheim!.teams['Dream Walkers'] = ['Unexpected'];
  const issues = auditLeagueRoster(current);
  assert.ok(issues.some((issue) => issue.includes('one') && issue.includes('team role')));
  assert.ok(issues.some((issue) => issue.includes('Dream Walkers') && issue.includes('public roster')));
});

test('daily audit can exempt only the departed roster member being resolved', () => {
  const current = snapshot();
  current.discordMembers = current.discordMembers.filter((member) => member.discordId !== 'two' && member.discordId !== 'one');
  const issues = auditLeagueRoster(current, { allowAbsentRosterMemberId: 'two' });
  assert.equal(issues.some((issue) => issue.includes('two') && issue.includes('not in the Discord member snapshot')), false);
  assert.equal(issues.some((issue) => issue.includes('one') && issue.includes('not in the Discord member snapshot')), true);
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

test('daily audit rejects role IDs reused across team, division, and free-agent categories', () => {
  const teamAndDivision = snapshot();
  teamAndDivision.teams[0]!.teamRoleId = 'division-v';
  assert.ok(auditLeagueRoster(teamAndDivision)
    .some((issue) => issue.includes('division-v') && issue.includes('both a team role and a division role')));

  const freeAgentAndTeam = snapshot();
  freeAgentAndTeam.freeAgentRoleId = 'team-a';
  assert.ok(auditLeagueRoster(freeAgentAndTeam)
    .some((issue) => issue.includes('team-a') && issue.includes('also configured as a team role')));

  const freeAgentAndDivision = snapshot();
  freeAgentAndDivision.freeAgentRoleId = 'division-v';
  assert.ok(auditLeagueRoster(freeAgentAndDivision)
    .some((issue) => issue.includes('division-v') && issue.includes('also configured as a division role')));
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

test('daily audit rejects duplicate current-name rows for an unrostered member', () => {
  const current = snapshot();
  current.names.push({
    ...current.names.find((row) => row.discordId === 'free')!,
    sheetRow: 9,
    leagueStatus: 'Former Player',
  });
  current.discordMembers.find((member) => member.discordId === 'free')!.roleIds = ['division-v'];
  const issues = auditLeagueRoster(current);
  assert.ok(issues.some((issue) => issue.includes('free') && issue.includes('exactly one current name record')));
});

test('daily audit rejects a rostered member without a current-name row', () => {
  const current = snapshot();
  current.names.find((row) => row.discordId === 'one')!.nameStatus = 'Former Discord Name';
  const issues = auditLeagueRoster(current);
  assert.ok(issues.some((issue) => issue.includes('one') && issue.includes('exactly one current name record')));
});

test('daily audit rejects a roster name that differs from the current Discord name', () => {
  const current = snapshot();
  current.rosters[0]!.player = 'Stale Name';
  const issues = auditLeagueRoster(current);
  assert.ok(issues.some((issue) => issue === 'Managed player names for one do not match the current Discord display name.'));
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

test('daily audit rejects an active team without a managed public roster block', () => {
  const current = snapshot();
  current.teams.push({
    teamKey: 'Vanaheim|Misspelled Team', franchise: 'Misspelled Team', division: 'Vanaheim',
    teamRoleId: 'team-c', teamRole: 'Misspelled Team VD', divisionRoleId: 'division-v', active: true,
  });
  const issues = auditLeagueRoster(current);
  assert.ok(issues.some((issue) => issue.includes('Misspelled Team') && issue.includes('no managed public roster block')));
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

test('drop with replacement atomically reuses the roster and free-agent slots', () => {
  const plan = buildDropPlan(snapshot(), 'two', 'free');
  assert.equal(plan.rosters.some((row) => row.discordId === 'two'), false);
  assert.deepEqual(plan.rosters.find((row) => row.discordId === 'free'), {
    sheetRow: 7, division: 'Vanaheim', franchise: 'The Sewer', teamRoleId: 'team-b',
    team: 'The Sewer VD', discordId: 'free', player: 'Free', rosterStatus: 'Player',
  });
  assert.deepEqual(plan.publicChanges, [
    { division: 'Vanaheim', area: 'team', group: 'The Sewer', from: 'Two', to: 'Free' },
    { division: 'Vanaheim', area: 'free-agent', group: 'Free Agents', from: 'Free', to: 'Two' },
  ]);
  assert.deepEqual(plan.discordRoleChanges, [
    { discordId: 'two', remove: ['team-b'], add: ['free-agent'] },
    { discordId: 'free', remove: ['free-agent'], add: ['team-b'] },
  ]);
});

test('self-drop records the suspension without free agency and can fill the vacated slot', () => {
  const plan = buildSelfDropPlan(snapshot(), 'two', 'free');
  assert.equal(plan.kind, 'self-drop');
  assert.equal(plan.nameUpdates.find((row) => row.discordId === 'two')?.leagueStatus, SELF_DROP_LEAGUE_STATUS);
  assert.equal(plan.nameUpdates.find((row) => row.discordId === 'free')?.leagueStatus, 'Player');
  assert.deepEqual(plan.discordRoleChanges, [
    { discordId: 'two', remove: ['team-b'], add: [] },
    { discordId: 'free', remove: ['free-agent'], add: ['team-b'] },
  ]);
  assert.deepEqual(plan.publicChanges, [
    { division: 'Vanaheim', area: 'team', group: 'The Sewer', from: 'Two', to: 'Free' },
    { division: 'Vanaheim', area: 'free-agent', group: 'Free Agents', from: 'Free', to: '' },
  ]);
});

test('self-drop records an absent player suspension without attempting a Discord role change', () => {
  const current = snapshot();
  current.discordMembers = current.discordMembers.filter((member) => member.discordId !== 'two');
  const plan = buildSelfDropPlan(current, 'two');
  assert.equal(plan.kind, 'self-drop');
  assert.equal(plan.rosters.some((row) => row.discordId === 'two'), false);
  assert.equal(plan.nameUpdates.find((row) => row.discordId === 'two')?.leagueStatus, SELF_DROP_LEAGUE_STATUS);
  assert.deepEqual(plan.discordRoleChanges, []);
  assert.deepEqual(plan.publicChanges, [
    { division: 'Vanaheim', area: 'team', group: 'The Sewer', from: 'Two', to: '' },
  ]);
});

test('departure removes an absent player without creating a free agent or Discord role mutation', () => {
  const current = snapshot();
  current.discordMembers = current.discordMembers.filter((member) => member.discordId !== 'two');
  const plan = buildDeparturePlan(current, 'two');
  assert.equal(plan.kind, 'departure');
  assert.equal(plan.rosters.some((row) => row.discordId === 'two'), false);
  assert.deepEqual(plan.discordRoleChanges, []);
  const name = plan.nameUpdates.find((row) => row.discordId === 'two');
  assert.equal(name?.leagueStatus, 'Inactive');
  assert.equal(name?.franchise, '');
  assert.deepEqual(plan.publicChanges, [
    { division: 'Vanaheim', area: 'team', group: 'The Sewer', from: 'Two', to: '' },
  ]);
});

test('departure with replacement mutates only the present replacement roles', () => {
  const current = snapshot();
  current.discordMembers = current.discordMembers.filter((member) => member.discordId !== 'two');
  const plan = buildDeparturePlan(current, 'two', 'free');
  assert.deepEqual(plan.discordRoleChanges, [
    { discordId: 'free', remove: ['free-agent'], add: ['team-b'] },
  ]);
  assert.equal(plan.nameUpdates.find((row) => row.discordId === 'two')?.leagueStatus, 'Inactive');
  assert.equal(plan.rosters.find((row) => row.discordId === 'free')?.sheetRow, 7);
});

test('replacement rejects the outgoing player and cross-division free agents', () => {
  assert.throws(() => buildDropPlan(snapshot(), 'two', 'two'), /cannot replace themselves/i);
  const current = snapshot();
  current.names.find((row) => row.discordId === 'free')!.division = 'Alfheim';
  assert.throws(() => buildSelfDropPlan(current, 'two', 'free'), /cross-division replacements/i);
});

test('departure rejects a player who is still in the server', () => {
  assert.throws(() => buildDeparturePlan(snapshot(), 'two'), /still in the YSL server.*transaction drop/i);
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

test('Discord-authoritative rename accepts only the player current Discord display name', () => {
  const current = snapshot();
  current.discordMembers.find((member) => member.discordId === 'one')!.displayName = 'One Prime';

  assert.throws(
    () => buildDiscordRenamePlan(current, 'one', 'Anything Else'),
    /must exactly match.*Discord display name.*One Prime/i,
  );
  assert.equal(buildDiscordRenamePlan(current, 'one', 'One Prime').players[0], 'One Prime');
});

test('rename rejects a canonical name already used in the same managed roster area', () => {
  const current = snapshot();
  const secondRoster = current.rosters.find((row) => row.discordId === 'two')!;
  secondRoster.teamRoleId = 'team-a';
  secondRoster.team = 'Dream Walkers VD';
  secondRoster.franchise = 'Dream Walkers';
  assert.throws(() => buildRenamePlan(current, 'one', 'Two'), /already used by another player/i);
});

test('layered findings get plain-English wording, route to role repair, and repairs keep valid Niflheim roles', async () => {
  const { humanizeLeagueAuditIssues } = await import('../services/leagueAuditPresentation.js');
  const { buildLeagueAuditReviewView } = await import('../services/leagueAuditReviewView.js');
  const { buildManagedRoleRepair } = await import('../services/leagueAuditResolution.js');
  const current = layeredSnapshot();
  member(current, 'faye').roleIds.push('team-n-lm');
  member(current, 'free').roleIds.push('division-n');
  member(current, 'qronch').roleIds = ['team-s-lm', 'division-s', 'division-n'];
  const issues = auditLeagueRoster(current);
  const human = humanizeLeagueAuditIssues(current, issues);
  assert.ok(human.every((line) => !line.startsWith('Ratatoskr found a roster rule mismatch')), human.join('\n'));
  assert.ok(human.includes('Faye — Discord Niflheim roles: Something Spicy ND, Little Monsters ND; Current Rosters Niflheim team: Something Spicy ND. Make the Niflheim team role match.'));
  for (const line of human) assert.equal(buildLeagueAuditReviewView([line], 0, 'r').title, 'Roster problems — Discord roles', line);
  assert.deepEqual(buildManagedRoleRepair(current, 'faye'), { discordId: 'faye', remove: ['team-n-lm'], add: [] });
  assert.deepEqual(buildManagedRoleRepair(current, 'free'), { discordId: 'free', remove: ['division-n'], add: [] });
  assert.deepEqual(buildManagedRoleRepair(current, 'qronch'), { discordId: 'qronch', remove: [], add: ['team-n-ss'] });
  // A correct layered player needs no change: valid Niflheim roles are never removed.
  assert.deepEqual(buildManagedRoleRepair(layeredSnapshot(), 'faye'), { discordId: 'faye', remove: [], add: [] });
  const vanaheimOnly = snapshot();
  member(vanaheimOnly, 'free').roleIds = ['division-v'];
  assert.deepEqual(buildManagedRoleRepair(vanaheimOnly, 'free'), { discordId: 'free', remove: [], add: ['free-agent'] });
});

test('a primary-record problem under a Niflheim row is explained in plain English', async () => {
  const { humanizeLeagueAuditIssues } = await import('../services/leagueAuditPresentation.js');
  const current = layeredSnapshot();
  current.names.at(-1)!.leagueStatus = 'Inactive';
  const finding = 'Niflheim roster member faye is not a current Svartalfheim player or free agent.';
  assert.ok(humanizeLeagueAuditIssues(current, [finding])[0]!
    .startsWith('Faye is on a Niflheim team, but Player Name History lists them in Svartalfheim inactive.'));
  current.names.at(-1)!.leagueStatus = SELF_DROP_LEAGUE_STATUS;
  const selfDrop = humanizeLeagueAuditIssues(current, [finding])[0]!;
  assert.match(selfDrop, /suspended after a self-drop \(this season and next season\)/);
  assert.ok(!selfDrop.includes(SELF_DROP_LEAGUE_STATUS));
  current.names.at(-1)!.leagueStatus = 'Mystery';
  assert.ok(!humanizeLeagueAuditIssues(current, [finding])[0]!.includes('Mystery'));
});

// #200: Niflheim roster moves. Sven is a Svartalfheim free agent with no Niflheim team;
// Mia is a Svartalfheim free agent on Little Monsters (Niflheim).
function niflheimSnapshot(): LeagueSnapshot {
  const current = layeredSnapshot();
  current.rosters.push({ sheetRow: 11, division: 'Niflheim', franchise: 'Little Monsters', teamRoleId: 'team-n-lm', team: 'Little Monsters ND', discordId: 'mia', player: 'Mia', rosterStatus: 'Player' });
  current.names.push(
    { sheetRow: 11, discordId: 'sven', currentLeagueName: 'Sven', knownName: 'Sven', nameStatus: 'Current Discord Name', division: 'Svartalfheim', franchise: '', leagueStatus: 'Free Agent' },
    { sheetRow: 12, discordId: 'mia', currentLeagueName: 'Mia', knownName: 'Mia', nameStatus: 'Current Discord Name', division: 'Svartalfheim', franchise: '', leagueStatus: 'Free Agent' },
  );
  current.discordMembers.push(
    { discordId: 'sven', displayName: 'Sven', roleIds: ['free-agent', 'division-s'] },
    { discordId: 'mia', displayName: 'Mia', roleIds: ['free-agent', 'division-s', 'team-n-lm', 'division-n'] },
  );
  current.publicRosters.Svartalfheim!.freeAgents.push('Sven', 'Mia');
  current.publicRosters.Niflheim!.teams['Little Monsters'] = ['Mia'];
  return current;
}

// What the sheets and Discord look like once a plan is applied.
function applyPlan(current: LeagueSnapshot, plan: ReturnType<typeof buildDropPlan>): LeagueSnapshot {
  const after = structuredClone(current);
  after.rosters = structuredClone(plan.rosters);
  after.names = structuredClone(plan.nameUpdates);
  for (const change of plan.publicChanges) {
    const list = change.area === 'team' ? after.publicRosters[change.division]!.teams[change.group]! : after.publicRosters[change.division]!.freeAgents;
    if (change.from === '') list.push(change.to);
    else if (change.to === '') list.splice(list.indexOf(change.from), 1);
    else list[list.indexOf(change.from)] = change.to;
  }
  for (const change of plan.discordRoleChanges) {
    const entry = member(after, change.discordId);
    entry.roleIds = entry.roleIds.filter((id) => !change.remove.includes(id)).concat(change.add);
  }
  return after;
}

const niflheimRows = (rows: LeagueSnapshot['rosters']) => rows.filter((row) => row.division === 'Niflheim').map((row) => `${row.discordId}:${row.franchise}`);

test('a Niflheim trade and 1-for-0 transfer change only Niflheim rows and ND roles', () => {
  const current = niflheimSnapshot();
  // Qronch is on two teams; Niflheim is the only division Mia shares with him.
  const swap = buildTradePlan(current, 'qronch', 'mia');
  assert.deepEqual(niflheimRows(swap.rosters), ['qronch:Little Monsters', 'faye:Something Spicy', 'mia:Something Spicy']);
  assert.deepEqual(swap.nameUpdates, current.names);
  assert.deepEqual(swap.discordRoleChanges, [
    { discordId: 'qronch', remove: ['team-n-ss'], add: ['team-n-lm'] },
    { discordId: 'mia', remove: ['team-n-lm'], add: ['team-n-ss'] }]);
  assert.deepEqual(auditLeagueRoster(applyPlan(current, swap)), []);

  const transfer = buildOneWayTradePlan(current, 'faye', 'team-n-lm');
  assert.deepEqual(transfer.nameUpdates, current.names);
  assert.deepEqual(transfer.publicChanges.map((change) => change.division), ['Niflheim', 'Niflheim']);
  assert.deepEqual(transfer.discordRoleChanges, [{ discordId: 'faye', remove: ['team-n-ss'], add: ['team-n-lm'] }]);
  assert.deepEqual(auditLeagueRoster(applyPlan(current, transfer)), []);
});

test('trades between Niflheim and another division are refused in plain words', () => {
  const current = niflheimSnapshot();
  assert.throws(() => buildOneWayTradePlan(current, 'faye', 'team-s-lm'), /Cross-division trades aren't allowed\. Niflheim and Svartalfheim are separate rosters/);
  assert.throws(() => buildTradePlan(current, 'faye', 'one'), /Cross-division trades aren't allowed\. Niflheim and Vanaheim are separate rosters/);
  assert.throws(() => buildTradePlan(current, 'mia', 'qronch', 'Svartalfheim'), /<@mia> is not on a Svartalfheim team\./);
});

test('a Niflheim drop removes only the ND and Niflheim roles; the Svartalfheim status is untouched', () => {
  const current = niflheimSnapshot();
  for (const [id, division] of [['faye', undefined], ['qronch', 'Niflheim']] as const) {
    const plan = buildDropPlan(current, id, undefined, division);
    assert.deepEqual(plan.discordRoleChanges, [{ discordId: id, remove: ['team-n-ss', 'division-n'], add: [] }]);
    assert.ok(!plan.discordRoleChanges[0]!.remove.some((role) => ['free-agent', 'division-s', 'team-s-lm'].includes(role)));
    assert.deepEqual(plan.nameUpdates, current.names);
    assert.deepEqual(plan.publicChanges, [{ division: 'Niflheim', area: 'team', group: 'Something Spicy', from: id === 'faye' ? 'Faye' : 'Qronch', to: '' }]);
    assert.deepEqual(auditLeagueRoster(applyPlan(current, plan)), []);
  }
  // A Niflheim replacement comes from the Svartalfheim pool and stays a free agent there.
  const replaced = buildDropPlan(current, 'faye', 'sven');
  assert.deepEqual(replaced.discordRoleChanges.at(-1), { discordId: 'sven', remove: [], add: ['team-n-ss', 'division-n'] });
  assert.deepEqual(auditLeagueRoster(applyPlan(current, replaced)), []);
});

test('a Niflheim pickup takes a Svartalfheim free agent with no Niflheim team and keeps them a free agent', () => {
  const current = niflheimSnapshot();
  const plan = buildPickupPlan(current, 'sven', 'team-n-lm');
  assert.deepEqual(plan.discordRoleChanges, [{ discordId: 'sven', remove: [], add: ['team-n-lm', 'division-n'] }]);
  assert.deepEqual(plan.nameUpdates, current.names);
  assert.deepEqual(plan.publicChanges, [{ division: 'Niflheim', area: 'team', group: 'Little Monsters', from: '', to: 'Sven' }]);
  assert.deepEqual(auditLeagueRoster(applyPlan(current, plan)), []);

  assert.throws(() => buildPickupPlan(current, 'free', 'team-n-lm'), /Niflheim players come from the Svartalfheim free-agent pool\. <@free> plays in Vanaheim\./);
  assert.throws(() => buildPickupPlan(current, 'mia', 'team-n-ss'), /<@mia> is already on a Niflheim team\./);
  current.rosters = current.rosters.filter((row) => !(row.discordId === 'qronch' && row.division === 'Niflheim'));
  assert.throws(() => buildPickupPlan(current, 'qronch', 'team-n-lm'), /Only Svartalfheim free agents can join a Niflheim team\./);
});

test('departure and self-drop end both memberships in one plan', () => {
  const current = niflheimSnapshot();
  const selfDrop = buildSelfDropPlan(current, 'qronch');
  assert.deepEqual(selfDrop.teams.map((team) => team.teamRoleId), ['team-s-lm', 'team-n-ss']);
  assert.deepEqual(selfDrop.rosters.filter((row) => row.discordId === 'qronch'), []);
  assert.deepEqual(selfDrop.discordRoleChanges, [{ discordId: 'qronch', remove: ['team-s-lm', 'team-n-ss', 'division-n'], add: [] }]);
  assert.deepEqual(auditLeagueRoster(applyPlan(current, selfDrop)), []);

  // A Svartalfheim free agent on a Niflheim team also leaves the free-agent list.
  const freeAgent = buildSelfDropPlan(current, 'faye');
  assert.deepEqual(freeAgent.discordRoleChanges, [{ discordId: 'faye', remove: ['team-n-ss', 'division-n', 'free-agent'], add: [] }]);
  assert.deepEqual(freeAgent.publicChanges.map((change) => `${change.division}:${change.area}`), ['Niflheim:team', 'Svartalfheim:free-agent']);
  assert.deepEqual(auditLeagueRoster(applyPlan(current, freeAgent)), []);

  current.discordMembers = current.discordMembers.filter((entry) => entry.discordId !== 'qronch');
  const departure = buildDeparturePlan(current, 'qronch');
  assert.deepEqual(departure.discordRoleChanges, []);
  assert.deepEqual(departure.publicChanges.map((change) => `${change.division}:${change.group}`), ['Svartalfheim:Little Monsters', 'Niflheim:Something Spicy']);
  assert.equal(departure.nameUpdates.find((row) => row.discordId === 'qronch')!.leagueStatus, 'Inactive');
  assert.deepEqual(auditLeagueRoster(applyPlan(current, departure), { allowAbsentRosterMemberId: 'qronch' }), []);
});
