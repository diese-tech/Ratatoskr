import assert from 'node:assert/strict';
import test from 'node:test';
import type { LeagueSnapshot } from '../domain/leagueOperations.js';
import { humanizeLeagueAuditIssues, leagueFindingKind } from './leagueAuditPresentation.js';

const playerId = '143011986349883392';
const otherId = '2424807103111233536';
const teamRoleId = '1541186877145485424';
const divisionRoleId = '1541186877145485425';
const freeAgentRoleId = '1541186877145485426';

function snapshot(): LeagueSnapshot {
  return {
    teams: [
      { teamKey: 'a_vd', division: 'Vanaheim', franchise: 'A', teamRole: 'A VD', teamRoleId, divisionRoleId, active: true },
      { teamKey: 'b_vd', division: 'Vanaheim', franchise: 'B', teamRole: 'B VD', teamRoleId: '1541186877145485427', divisionRoleId, active: true },
    ],
    rosters: [
      { sheetRow: 6, division: 'Vanaheim', franchise: 'A', teamRoleId, team: 'A VD', discordId: playerId, player: 'Old Name', rosterStatus: 'Captain' },
      { sheetRow: 7, division: 'Vanaheim', franchise: 'B', teamRoleId: '1541186877145485427', team: 'B VD', discordId: otherId, player: 'Other Player', rosterStatus: 'Player' },
    ],
    names: [
      { sheetRow: 6, discordId: playerId, currentLeagueName: 'Current Name', knownName: 'Current Name', nameStatus: 'Current Discord Name', division: 'Vanaheim', franchise: 'A', leagueStatus: 'Captain' },
      { sheetRow: 7, discordId: otherId, currentLeagueName: 'Other Player', knownName: 'Other Player', nameStatus: 'Current Discord Name', division: 'Vanaheim', franchise: 'B', leagueStatus: 'Player' },
    ],
    discordMembers: [
      { discordId: playerId, displayName: 'Current Name', roleIds: [teamRoleId, '1541186877145485427', divisionRoleId, freeAgentRoleId] },
      { discordId: otherId, displayName: 'Other Player', roleIds: [divisionRoleId] },
    ],
    publicRosters: { Vanaheim: { teams: { A: ['Public Name'], B: [] }, freeAgents: ['Public Free Agent'] } },
    freeAgentRoleId,
  };
}

test('every league-audit diagnostic has a human-readable staff explanation without raw Discord IDs', () => {
  const diagnostics = [
    `Role ${teamRoleId} is configured as both a team role and a division role.`,
    `Free Agent role ${freeAgentRoleId} is also configured as a team role.`,
    `Free Agent role ${freeAgentRoleId} is also configured as a division role.`,
    `Team role ${teamRoleId} is configured more than once.`,
    'Vanaheim A is configured as more than one active team.',
    'Vanaheim is configured with more than one division role.',
    `Division role ${divisionRoleId} is shared by Vanaheim and Alfheim.`,
    `Discord member ${playerId} has conflicting Current League Name values.`,
    `Discord member ${playerId} must have exactly one current name record.`,
    `Discord member ${playerId} appears more than once in Current Rosters.`,
    `Current Rosters member ${playerId} references an inactive or unknown team role.`,
    `Current Rosters member ${playerId} does not match configured team A VD.`,
    `Current Rosters member ${playerId} has no Current League Name.`,
    `Managed player names for ${playerId} do not match the current Discord display name.`,
    `Current Rosters player name for ${playerId} does not match its Current League Name.`,
    `Current name record for ${playerId} does not match its Current Rosters assignment.`,
    `Current player ${playerId} must have exactly one Current Rosters assignment.`,
    `Discord member ${playerId} has multiple team roles.`,
    `Discord member ${playerId} team role does not match Current Rosters.`,
    `Discord member ${playerId} is rostered without its team role.`,
    `Discord member ${playerId} division roles do not match Vanaheim.`,
    `Discord member ${playerId} is rostered but still has the Free Agent role.`,
    `Discord member ${playerId} is recorded as a free agent but is missing the Free Agent role.`,
    `Discord member ${playerId} has the Free Agent role but is not recorded as a current free agent.`,
    `Current Rosters member ${playerId} is not in the Discord member snapshot.`,
    `Current free agent ${playerId} must not retain a franchise assignment.`,
    `Current free agent ${playerId} is not in the Discord member snapshot.`,
    'Vanaheim A has no managed public roster block.',
    'Vanaheim A has duplicate current player names.',
    'Vanaheim A public roster does not match Current Rosters.',
    'Vanaheim free agents have duplicate current player names.',
    'Vanaheim public free-agent list does not match Player Name History.',
  ];

  const messages = diagnostics.map((diagnostic) => humanizeLeagueAuditIssues(snapshot(), [diagnostic])[0]!);

  for (const message of messages) {
    // #206: readable by a first-time staff member. No sheet or tab names,
    // role or Discord IDs, raw stored statuses or internal terms.
    assert.doesNotMatch(message, /\b\d{16,20}\b/);
    assert.doesNotMatch(message, /Current Rosters|Player Name History|Admin workbook|League Teams|Current Discord Name|Discord member snapshot/i);
    assert.doesNotMatch(message, /\b(?:Captain|Player|Inactive|Self-Drop)\b/);
    assert.doesNotMatch(message, /can’t explain/);
    const [title, ...body] = message.split('\n');
    assert.ok(title && title.length <= 100, `A short title about one person or team: ${title}`);
    assert.ok(body.length >= 1, `A card says more than its title: ${message}`);
    // Every card either offers a Rat fix (shown as two sides) or says who can fix it.
    if (leagueFindingKind(message) === 'manual') assert.match(message, /An admin needs to fix this/);
    else if (!['departed', 'departed-free-agent'].includes(leagueFindingKind(message))) assert.match(message, /says: /);
  }
});

test('finding titles route each kind of problem to its fix', () => {
  const kind = (diagnostic: string) => leagueFindingKind(humanizeLeagueAuditIssues(snapshot(), [diagnostic])[0]!);
  assert.equal(kind(`Managed player names for ${playerId} do not match the current Discord display name.`), 'name');
  for (const roles of ['has multiple team roles', 'team role does not match Current Rosters', 'is rostered without its team role',
    'division roles do not match Vanaheim', 'is rostered but still has the Free Agent role',
    'is recorded as a free agent but is missing the Free Agent role', 'has the Free Agent role but is not recorded as a current free agent'])
    assert.equal(kind(`Discord member ${playerId} ${roles}.`), 'roles', roles);
  assert.equal(kind('Vanaheim A public roster does not match Current Rosters.'), 'public');
  assert.equal(kind('Vanaheim public free-agent list does not match Player Name History.'), 'public');
  assert.equal(kind(`Current free agent ${playerId} is not in the Discord member snapshot.`), 'departed-free-agent');
  assert.equal(kind(`Current Rosters member ${playerId} is not in the Discord member snapshot.`), 'departed');
  assert.equal(kind(`Current name record for ${playerId} does not match its Current Rosters assignment.`), 'manual');
  assert.equal(kind(`Current Rosters member ${playerId} does not match configured team A VD.`), 'manual');
});

test('unknown diagnostics fail closed into a plain-language instruction without echoing technical details', () => {
  const [message] = humanizeLeagueAuditIssues(snapshot(), [`Unexpected invariant for ${playerId}`]);
  assert.doesNotMatch(message!, new RegExp(playerId));
  assert.match(message!, /ask a bot operator/i);
});

test('player-name findings identify Discord as the source and label each sheet value', () => {
  const [message] = humanizeLeagueAuditIssues(snapshot(), [
    `Managed player names for ${playerId} do not match the current Discord display name.`,
  ]);

  assert.equal(message, [
    'Old Name’s name doesn’t match Discord',
    'Discord says: “Current Name”',
    'Our roster says: “Old Name”',
    'Our name list says: “Current Name”',
    'Team: A (Vanaheim)',
  ].join('\n'));
});
