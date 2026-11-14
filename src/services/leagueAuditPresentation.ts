import { layeredRoster, primaryRoster, SELF_DROP_LEAGUE_STATUS, type LeagueSnapshot } from '../domain/leagueOperations.js';
import { divisionAlternation, type LeagueDivision } from '../domain/leagueDivisions.js';

const D = divisionAlternation();

// Every finding is a short card for staff who have never opened the league
// spreadsheet (#206): line 1 is a title about one person or team, then the two
// sides in names people know, then (only when Rat cannot fix it) what to do.
// Sheet names, role IDs and stored statuses never appear (AGENTS.md).
// The text doubles as the finding's identity, so each card must stay unique
// for its diagnostic and its title must keep matching leagueFindingKind.
const ADMIN = 'An admin needs to fix this in the league spreadsheet. Rat can’t pick the right answer by itself.';

export type LeagueFindingKind = 'name' | 'roles' | 'public' | 'departed-free-agent' | 'departed' | 'manual';

/** The kind of fix a finding can get, read from its title (first line). */
export function leagueFindingKind(finding: string): LeagueFindingKind {
  const title = leagueFindingTitle(finding);
  if (/’s name (?:doesn’t match Discord|is different in two league records)$/.test(title)) return 'name';
  if (/’s (?:\S+ )?(?:team|division|division role|Free Agent role) doesn’t match$/.test(title)) return 'roles';
  if (/^The .+ (?:roster|free agent) page doesn’t match$/.test(title)) return 'public';
  if (/^Free agent .+ left the server$/.test(title)) return 'departed-free-agent';
  if (/ left the server$/.test(title)) return 'departed';
  return 'manual';
}
export function leagueFindingTitle(finding: string): string {
  return finding.split('\n', 1)[0]!;
}
export function leagueFindingBody(finding: string): string {
  return finding.split('\n').slice(1).join('\n');
}

// Stored Player Name History statuses are never shown raw to staff (AGENTS.md).
function statusPhrase(status: string): string {
  const phrases: Record<string, string> = {
    'Free Agent': 'a free agent', Player: 'a rostered player', Captain: 'a captain', Inactive: 'inactive',
    [SELF_DROP_LEAGUE_STATUS]: 'suspended after a self-drop (this season and next season)',
  };
  return Object.hasOwn(phrases, status) ? phrases[status]! : 'in a status Rat doesn’t recognize';
}

function quoted(value: string): string {
  return `“${value || 'blank'}”`;
}

function list(values: string[], none = 'nobody'): string {
  if (!values.length) return none;
  return values.length === 1 ? values[0]! : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;
}

function card(title: string, ...lines: string[]): string {
  return [title, ...lines].join('\n');
}

function playerName(snapshot: LeagueSnapshot, discordId: string): string {
  return snapshot.names.find((row) => row.discordId === discordId)?.currentLeagueName
    ?? snapshot.rosters.find((row) => row.discordId === discordId)?.player
    ?? snapshot.discordMembers.find((member) => member.discordId === discordId)?.displayName
    ?? 'A player Rat can’t identify';
}

// The player's primary (non-Niflheim) assignment; layered findings name their division.
function rosterFor(snapshot: LeagueSnapshot, discordId: string) {
  return primaryRoster(snapshot.rosters, discordId);
}

function teamLabel(team: { franchise: string; division: string } | undefined, none = 'no team'): string {
  return team ? `${team.franchise} (${team.division})` : none;
}

function memberRoleIds(snapshot: LeagueSnapshot, discordId: string): string[] {
  return snapshot.discordMembers.find((entry) => entry.discordId === discordId)?.roleIds ?? [];
}

function discordTeams(snapshot: LeagueSnapshot, discordId: string, division?: string): string[] {
  return memberRoleIds(snapshot, discordId).flatMap((roleId) => snapshot.teams
    .filter((team) => team.teamRoleId === roleId && (!division || team.division === division)).map((team) => teamLabel(team)));
}

function roleName(snapshot: LeagueSnapshot, roleId: string): string {
  const team = snapshot.teams.find((entry) => entry.teamRoleId === roleId);
  if (team) return `The “${team.teamRole}” role`;
  const division = snapshot.teams.find((entry) => entry.divisionRoleId === roleId)?.division;
  if (division) return `The ${division} role`;
  if (roleId === snapshot.freeAgentRoleId) return 'The Free Agent role';
  return 'A Discord role Rat doesn’t manage';
}

function discordDivisions(snapshot: LeagueSnapshot, discordId: string): string[] {
  return memberRoleIds(snapshot, discordId).flatMap((roleId) => {
    const division = snapshot.teams.find((team) => team.divisionRoleId === roleId)?.division;
    return division ? [division] : [];
  }).filter((division, index, all) => all.indexOf(division) === index);
}

function humanize(snapshot: LeagueSnapshot, issue: string): string {
  let match: RegExpMatchArray | null;
  match = issue.match(/^Managed player names for (\S+) do not match the current Discord display name\.$/);
  if (match) {
    const discordId = match[1]!;
    const member = snapshot.discordMembers.find((entry) => entry.discordId === discordId);
    const roster = rosterFor(snapshot, discordId);
    const current = snapshot.names.find((entry) => entry.discordId === discordId && entry.nameStatus === 'Current Discord Name');
    const rosterName = roster?.player ?? current?.currentLeagueName ?? '';
    return card(`${rosterName || playerName(snapshot, discordId)}’s name doesn’t match Discord`,
      `Discord says: ${quoted(member?.displayName ?? '')}`,
      `Our roster says: ${quoted(rosterName)}`,
      ...(current && roster && current.currentLeagueName !== roster.player ? [`Our name list says: ${quoted(current.currentLeagueName)}`] : []),
      `Team: ${teamLabel(roster ?? (current?.franchise ? { franchise: current.franchise, division: current.division } : undefined))}`);
  }

  match = issue.match(/^Current Rosters player name for (\S+) does not match its Current League Name\.$/);
  if (match) {
    const row = rosterFor(snapshot, match[1]!);
    const current = snapshot.names.find((entry) => entry.discordId === match![1])?.currentLeagueName ?? '';
    return card(`${current || row?.player || 'A player'}’s name is different in two league records`,
      `Our roster says: ${quoted(row?.player ?? '')}`,
      `Our name list says: ${quoted(current)}`,
      `Team: ${teamLabel(row)}`);
  }

  match = issue.match(/^Discord member (\S+) has conflicting Current League Name values\.$/);
  if (match) {
    const values = snapshot.names.filter((row) => row.discordId === match![1]).map((row) => quoted(row.currentLeagueName));
    return card(`${playerName(snapshot, match[1]!)} has more than one current name`, `Our records list: ${list(values)}.`, ADMIN);
  }
  match = issue.match(/^Discord member (\S+) must have exactly one current name record\.$/);
  if (match) {
    const count = snapshot.names.filter((row) => row.discordId === match![1] && row.nameStatus === 'Current Discord Name').length;
    return card(`${playerName(snapshot, match[1]!)} has ${count ? count : 'no'} current name${count === 1 ? '' : 's'} on record`,
      'Every player needs exactly one current name.', ADMIN);
  }
  match = issue.match(/^Discord member (\S+) appears more than once in Current Rosters\.$/);
  if (match) return card(`${playerName(snapshot, match[1]!)} is on the roster more than once`, 'They should be listed once for their team.', ADMIN);
  match = issue.match(/^Current Rosters member (\S+) references an inactive or unknown team role\.$/);
  if (match) return card(`${playerName(snapshot, match[1]!)}’s team isn’t one Rat manages`, 'Our roster puts them on a team that isn’t active.', ADMIN);
  match = issue.match(/^Current Rosters member (\S+) does not match configured team (.+)\.$/);
  if (match) {
    const row = rosterFor(snapshot, match[1]!);
    return card(`${playerName(snapshot, match[1]!)}’s team setup is wrong`,
      `Our roster says: ${teamLabel(row)}`, `Their team role belongs to: ${match[2]}`, ADMIN);
  }
  match = issue.match(/^Current Rosters member (\S+) has no Current League Name\.$/);
  if (match) return card(`${playerName(snapshot, match[1]!)} is missing from the name list`, 'They’re on a team, but Rat has no current name for them.', ADMIN);
  match = issue.match(/^Current name record for (\S+) does not match its Current Rosters assignment\.$/);
  if (match) {
    const roster = rosterFor(snapshot, match[1]!);
    const name = snapshot.names.find((row) => row.discordId === match![1] && row.nameStatus === 'Current Discord Name');
    return card(`${playerName(snapshot, match[1]!)}’s league records disagree`,
      `Our name list says: ${name ? `${statusPhrase(name.leagueStatus)} in ${name.division}${name.franchise ? ` on ${name.franchise}` : ''}` : 'nothing'}`,
      `Our roster says: ${roster ? `${statusPhrase(roster.rosterStatus)} on ${teamLabel(roster)}` : 'no team'}`, ADMIN);
  }
  match = issue.match(/^Current player (\S+) must have exactly one Current Rosters assignment\.$/);
  if (match) {
    const count = snapshot.rosters.filter((row) => row.discordId === match![1] && primaryRoster([row], row.discordId)).length;
    return card(`${playerName(snapshot, match[1]!)} is on ${count ? `${count} teams` : 'no team'}`,
      'They’re marked as playing, so they should be on exactly one team.', ADMIN);
  }
  match = issue.match(new RegExp(`^Discord member (\\S+) has more than one (${D}) roster assignment\\.$`));
  if (match) return card(`${playerName(snapshot, match[1]!)} is on more than one ${match[2]} team`, 'They should be on one team in each division.', ADMIN);
  match = issue.match(new RegExp(`^(${D}) roster member (\\S+) is not a current (${D}) player or free agent\\.$`));
  if (match) {
    const name = snapshot.names.find((row) => row.discordId === match![2] && row.nameStatus === 'Current Discord Name');
    return card(`${playerName(snapshot, match[2]!)} can’t be on a ${match[1]} team right now`,
      `They’re on a ${match[1]} team, but our records show them as ${name ? `${statusPhrase(name.leagueStatus)} in ${name.division}` : 'not in the league'}.`,
      `${match[1]} players must also be ${match[3]} players or free agents.`, ADMIN);
  }
  match = issue.match(new RegExp(`^Discord member (\\S+) (?:has multiple (${D}) team roles|(${D}) team role does not match Current Rosters|is on a (${D}) roster without its team role|(${D}) division role does not match Current Rosters)\\.$`));
  if (match) {
    const division = (match[2] ?? match[3] ?? match[4] ?? match[5])!;
    const row = layeredRoster(snapshot.rosters, match[1]!);
    if (match[5]) {
      const hasRole = snapshot.teams.some((team) => team.division === division && memberRoleIds(snapshot, match![1]!).includes(team.divisionRoleId));
      return card(`${playerName(snapshot, match[1]!)}’s ${division} division role doesn’t match`,
        `Discord says: ${hasRole ? `they have the ${division} role` : `they don’t have the ${division} role`}`,
        `Our roster says: ${row ? `they’re on ${row.franchise}` : `they’re not on a ${division} team`}`);
    }
    return card(`${playerName(snapshot, match[1]!)}’s ${division} team doesn’t match`,
      `Discord says: ${list(discordTeams(snapshot, match[1]!, division), 'no team')}`,
      `Our roster says: ${teamLabel(row)}`);
  }
  match = issue.match(/^Discord member (\S+) (has multiple team roles|team role does not match Current Rosters|is rostered without its team role)\.$/);
  if (match) {
    return card(`${playerName(snapshot, match[1]!)}’s team doesn’t match`,
      `Discord says: ${list(discordTeams(snapshot, match[1]!), 'no team')}`,
      `Our roster says: ${teamLabel(rosterFor(snapshot, match[1]!))}`);
  }
  match = issue.match(new RegExp(`^Discord member (\\S+) division roles do not match (${D})\\.$`));
  if (match) {
    return card(`${playerName(snapshot, match[1]!)}’s division doesn’t match`,
      `Discord says: ${list(discordDivisions(snapshot, match[1]!), 'no division')}`, `Our roster says: ${match[2]}`);
  }
  match = issue.match(/^Discord member (\S+) is rostered but still has the Free Agent role\.$/);
  if (match) {
    return card(`${playerName(snapshot, match[1]!)}’s Free Agent role doesn’t match`,
      'Discord says: they’re a free agent', `Our roster says: they’re on ${teamLabel(rosterFor(snapshot, match[1]!), 'a team')}`);
  }
  match = issue.match(/^Discord member (\S+) is recorded as a free agent but is missing the Free Agent role\.$/);
  if (match) {
    return card(`${playerName(snapshot, match[1]!)}’s Free Agent role doesn’t match`,
      'Discord says: they don’t have the Free Agent role', 'Our roster says: they’re a free agent');
  }
  match = issue.match(/^Discord member (\S+) has the Free Agent role but is not recorded as a current free agent\.$/);
  if (match) {
    return card(`${playerName(snapshot, match[1]!)}’s Free Agent role doesn’t match`,
      'Discord says: they’re a free agent', 'Our roster says: they’re not a free agent');
  }
  match = issue.match(/^Current Rosters member (\S+) is not in the Discord member snapshot\.$/);
  if (match) {
    return card(`${playerName(snapshot, match[1]!)} left the server`,
      `They’re still on ${teamLabel(rosterFor(snapshot, match[1]!), 'a team')}, but they’re no longer in the Discord server.`);
  }
  match = issue.match(/^Current free agent (\S+) must not retain a franchise assignment\.$/);
  if (match) return card(`Free agent ${playerName(snapshot, match[1]!)} still has a team on record`, 'Free agents shouldn’t have a team.', ADMIN);
  match = issue.match(/^Current free agent (\S+) is not in the Discord member snapshot\.$/);
  if (match) {
    return card(`Free agent ${playerName(snapshot, match[1]!)} left the server`,
      'They’re still listed as a free agent, but they’re no longer in the Discord server.');
  }

  match = issue.match(/^Role (\S+) is configured as both a team role and a division role\.$/);
  if (match) return card(`${roleName(snapshot, match[1]!)} is used for two things`, 'It’s set up as both a team role and a division role. Each needs its own role.', ADMIN);
  match = issue.match(/^Free Agent role \S+ is also configured as a (team|division) role\.$/);
  if (match) return card(`The Free Agent role is also a ${match[1]} role`, 'Each needs its own Discord role.', ADMIN);
  match = issue.match(/^Team role (\S+) is configured more than once\.$/);
  if (match) return card(`${roleName(snapshot, match[1]!)} is set up for more than one team`, 'Each team needs its own role.', ADMIN);
  match = issue.match(new RegExp(`^(${D}) (.+) is configured as more than one active team\\.$`));
  if (match) return card(`${match[1]} ${match[2]} is set up twice`, 'Each team should be listed once.', ADMIN);
  match = issue.match(new RegExp(`^(${D}) is configured with more than one division role\\.$`));
  if (match) return card(`${match[1]} has more than one division role`, `Every ${match[1]} team should use the same division role.`, ADMIN);
  match = issue.match(new RegExp(`^Division role (\\S+) is shared by (${D}) and (${D})\\.$`));
  if (match) return card(`${roleName(snapshot, match[1]!)} is shared by ${match[2]} and ${match[3]}`, 'Each division needs its own role.', ADMIN);

  match = issue.match(new RegExp(`^(${D}) (.+) has no managed public roster block\\.$`));
  if (match) return card(`${match[1]} ${match[2]} is missing from the roster page`, 'The public roster page has no section for this team.', ADMIN);
  match = issue.match(new RegExp(`^(${D}) (.+) has duplicate current player names\\.$`));
  if (match) return card(`${match[1]} ${match[2]} has two players with the same name`, 'Each player on a team needs a different name.', ADMIN);
  match = issue.match(new RegExp(`^(${D}) (.+) public roster does not match Current Rosters\\.$`));
  if (match) {
    const team = snapshot.teams.find((entry) => entry.division === match![1] && entry.franchise === match![2]);
    const expected = snapshot.rosters.filter((row) => row.teamRoleId === team?.teamRoleId).map((row) => row.player);
    const actual = snapshot.publicRosters[match[1] as LeagueDivision]?.teams[match[2]!] ?? [];
    return card(`The ${match[1]} ${match[2]} roster page doesn’t match`,
      `Our roster says: ${list(expected)}`, `The roster page says: ${list(actual)}`);
  }
  match = issue.match(new RegExp(`^(${D}) free agents have duplicate current player names\\.$`));
  if (match) return card(`${match[1]} has two free agents with the same name`, 'Each free agent needs a different name.', ADMIN);
  match = issue.match(new RegExp(`^(${D}) public free-agent list does not match Player Name History\\.$`));
  if (match) {
    const division = match[1] as LeagueDivision;
    const expected = snapshot.names.filter((row) => row.nameStatus === 'Current Discord Name' && row.division === division && row.leagueStatus === 'Free Agent').map((row) => row.currentLeagueName);
    const actual = snapshot.publicRosters[division]?.freeAgents ?? [];
    return card(`The ${division} free agent page doesn’t match`,
      `Our roster says: ${list(expected)}`, `The roster page says: ${list(actual)}`);
  }

  return card('Rat found a roster problem it can’t explain',
    'Ask a bot operator to look at the latest check before changing anything.');
}

export function humanizeLeagueAuditIssues(snapshot: LeagueSnapshot, issues: string[]): string[] {
  return [...new Set(issues.map((issue) => humanize(snapshot, issue)))];
}
