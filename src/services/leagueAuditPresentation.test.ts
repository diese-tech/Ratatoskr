import assert from 'node:assert/strict';
import test from 'node:test';
import type { LeagueSnapshot } from '../domain/leagueOperations.js';
import { humanizeLeagueAuditIssues } from './leagueAuditPresentation.js';

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

  const messages = humanizeLeagueAuditIssues(snapshot(), diagnostics);

  assert.equal(messages.length, diagnostics.length);
  for (const message of messages) {
    assert.doesNotMatch(message, /\b\d{17,20}\b/);
    assert.doesNotMatch(message, /Discord member snapshot/i);
    assert.doesNotMatch(message, /could not explain safely/i);
  }
  assert.ok(messages.every((message) => /\b(make|keep|add|select|restore|remove|correct|clear|confirm|mark|give|use)\b/i.test(message)));
});

test('unknown diagnostics fail closed into a plain-language instruction without echoing technical details', () => {
  const [message] = humanizeLeagueAuditIssues(snapshot(), [`Unexpected invariant for ${playerId}`]);
  assert.doesNotMatch(message!, new RegExp(playerId));
  assert.match(message!, /ask a bot operator/i);
});
