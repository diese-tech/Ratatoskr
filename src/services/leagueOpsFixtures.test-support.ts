import type { LeagueSnapshot } from '../domain/leagueOperations.js';
export function cleanLeagueSnapshot(): LeagueSnapshot {
  return {
    teams: [
      {
        teamKey: 'a',
        franchise: 'A',
        division: 'Vanaheim',
        teamRoleId: 'a',
        teamRole: 'A VD',
        divisionRoleId: 'division',
        active: true,
      },
      {
        teamKey: 'b',
        franchise: 'B',
        division: 'Vanaheim',
        teamRoleId: 'b',
        teamRole: 'B VD',
        divisionRoleId: 'division',
        active: true,
      },
    ],
    rosters: [
      {
        sheetRow: 6,
        division: 'Vanaheim',
        franchise: 'A',
        teamRoleId: 'a',
        team: 'A VD',
        discordId: 'one',
        player: 'One',
        rosterStatus: 'Player',
      },
      {
        sheetRow: 7,
        division: 'Vanaheim',
        franchise: 'B',
        teamRoleId: 'b',
        team: 'B VD',
        discordId: 'two',
        player: 'Two',
        rosterStatus: 'Player',
      },
    ],
    names: [
      {
        sheetRow: 6,
        discordId: 'one',
        currentLeagueName: 'One',
        knownName: 'One',
        nameStatus: 'Current Discord Name',
        division: 'Vanaheim',
        franchise: 'A',
        leagueStatus: 'Player',
      },
      {
        sheetRow: 7,
        discordId: 'two',
        currentLeagueName: 'Two',
        knownName: 'Two',
        nameStatus: 'Current Discord Name',
        division: 'Vanaheim',
        franchise: 'B',
        leagueStatus: 'Player',
      },
    ],
    discordMembers: [
      { discordId: 'one', displayName: 'One', roleIds: ['a', 'division'] },
      { discordId: 'two', displayName: 'Two', roleIds: ['b', 'division'] },
    ],
    publicRosters: { Vanaheim: { teams: { A: ['One'], B: ['Two'] }, freeAgents: [] } },
    freeAgentRoleId: 'fa',
  };
}
