// Read-only inspection of a hand-made league division (#196).
//
// Everything here is pure except readDivisionDiscordState, which takes an
// injected REST client and only ever calls `get`. This module is used by the
// offline maintenance script scripts/inspect-league-division.ts. It must never
// be imported by bot runtime code: its whole-guild member listing is a one-off
// REST read outside the bot's Gateway session. It uses the owner-approved
// maintenance-script exception in ADR 0001 / AGENTS.md (#196) instead of readLeagueMembers.
import { PermissionsBitField, Routes } from 'discord.js';
import { normalizeName } from './draftPicks.js';

type Cell = string | number | boolean | null | undefined;
export type Rows = Cell[][];

export type InspectedRole = { id: string; name: string; position: number; permissions: string; managed?: boolean; mentionable?: boolean };
export type InspectedChannel = {
  id: string; name: string; type: number; parent_id?: string | null;
  permission_overwrites?: Array<{ id: string; type: number; allow: string; deny: string }>;
};
export type InspectedMember = { user: { id: string; username: string; global_name?: string | null; bot?: boolean }; nick?: string | null; roles: string[] };
export type DiscordDivisionState = { roles: InspectedRole[]; channels: InspectedChannel[]; members: InspectedMember[]; botRoleIds: string[] };

export type SheetDivisionState = {
  adminTitles: string[];
  publicTitles: string[];
  teams: Rows;            // League Teams!A6:L
  names: Rows;            // Player Name History!A6:K
  rosters: Rows;          // Current Rosters!A6:J
  memberDirectory: Rows;  // Member Directory!A6:D
  draft?: Rows;           // '<Division> Draft'!A1:O60, when the tab exists
};

/** The only Discord surface the inspection may use. There is deliberately no post/put/patch/delete. */
export type ReadOnlyRest = { get(route: `/${string}`, options?: { query?: URLSearchParams }): Promise<unknown> };

export async function readDivisionDiscordState(rest: ReadOnlyRest, guildId: string): Promise<DiscordDivisionState> {
  const roles = await rest.get(Routes.guildRoles(guildId)) as InspectedRole[];
  const channels = await rest.get(Routes.guildChannels(guildId)) as InspectedChannel[];
  const members: InspectedMember[] = [];
  for (let after = '0'; ;) {
    const page = await rest.get(Routes.guildMembers(guildId), { query: new URLSearchParams({ limit: '1000', after }) }) as InspectedMember[];
    members.push(...page);
    if (page.length < 1000) break;
    after = page.at(-1)!.user.id;
  }
  const bot = await rest.get(Routes.user()) as { id: string };
  const botMember = await rest.get(Routes.guildMember(guildId, bot.id)) as InspectedMember;
  return { roles, channels, members, botRoleIds: botMember.roles };
}

/** A setup problem the script found itself, worded for staff already. */
export class InspectionSetupError extends Error {}

/**
 * Plain-English wording for a failed inspection (AGENTS.md). Staff get a cause and a next step; the
 * original technical message goes in `detail`, printed separately for maintainers.
 */
export function describeInspectionFailure(error: unknown): { message: string; detail?: string } {
  if (error instanceof InspectionSetupError) return { message: error.message };
  const failure = (error && typeof error === 'object' ? error : {}) as {
    name?: unknown; message?: unknown; status?: unknown; url?: unknown; code?: unknown;
    response?: { status?: unknown }; config?: { url?: unknown };
  };
  const detail = `${typeof failure.name === 'string' ? failure.name : 'Error'}: ${typeof failure.message === 'string' ? failure.message : String(error)}`;
  const status = typeof failure.status === 'number' ? failure.status : typeof failure.response?.status === 'number' ? failure.response.status : undefined;
  const url = String(typeof failure.url === 'string' ? failure.url : failure.config?.url ?? '');
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* No usable URL; fall back to the error name. */ }
  const onHost = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  const google = onHost('googleapis.com') || /^Gaxios/.test(String(failure.name ?? ''));
  const discord = onHost('discord.com') || /^(DiscordAPIError|HTTPError)/.test(String(failure.name ?? ''));
  if (discord && status === 401) return { message: 'Discord rejected the bot login. Check that DISCORD_TOKEN in this environment is the current bot token.', detail };
  if (discord && status === 403) return { message: 'Discord denied access. Check that Rat is in the server and that the Server Members Intent is turned on for the bot in the Discord Developer Portal.', detail };
  if (discord && status === 404) return { message: 'Discord could not find the server. Check DISCORD_GUILD_ID in this environment.', detail };
  if (google && (status === 401 || status === 403)) return { message: 'Google denied access to a league workbook. Check that the service account can view both the Admin and public spreadsheets.', detail };
  if (google && status === 404) return { message: 'Google could not find a league workbook. Check YSL_ADMIN_SPREADSHEET_ID and YSL_PUBLIC_SPREADSHEET_ID.', detail };
  if (status === 429) return { message: `${google ? 'Google' : 'Discord'} asked Rat to slow down. Wait a minute, then run the inspection again.`, detail };
  if (typeof failure.code === 'string' && /^(ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED)$/.test(failure.code))
    return { message: 'Rat could not reach Discord or Google. Check the network connection, then run the inspection again.', detail };
  return { message: 'The inspection hit an unexpected problem. Share the details below with a maintainer.', detail };
}

const text = (value: Cell) => (value === null || value === undefined ? '' : String(value)).trim();
const displayName = (member: InspectedMember) => member.nick || member.user.global_name || member.user.username;

export function permissionNames(bits: string): string[] {
  try { return new PermissionsBitField(BigInt(bits || '0')).toArray().map(String); }
  catch { return [`unreadable (${bits})`]; }
}

/** Team-role suffix used by the division's hand-made roles, for example `ND` for Niflheim. */
export function divisionTeamSuffix(division: string): string {
  return `${division.trim()[0]?.toUpperCase() ?? ''}D`;
}

type DraftTeam = { team: string; captain: string; picks: string[] };

/** Every team block in a draft tab: the captain row ("Cap:") plus each numbered pick row below it. */
export function parseDraftTeams(rows: Rows): DraftTeam[] {
  const teams: DraftTeam[] = [];
  rows.forEach((row, rowIndex) => row.forEach((cell, column) => {
    if (text(cell) !== 'Cap:') return;
    const team = text(rows[rowIndex - 2]?.[column]);
    const captain = text(rows[rowIndex]?.[column + 1]);
    const picks: string[] = [];
    for (let next = rowIndex + 1; next < rows.length; next += 1) {
      const marker = text(rows[next]?.[column]);
      if (!/^\d+$/.test(marker)) break;
      const name = text(rows[next]?.[column + 1]);
      if (name) picks.push(name);
    }
    if (team) teams.push({ team, captain, picks });
  }));
  return teams;
}

export type LayeredStatus = {
  discordId: string; name: string; niflheimTeams: string[];
  ratRecord: string; problems: string[];
};

export type DraftResolution = { team: string; draftName: string; captain: boolean; outcome: 'matched' | 'other-team' | 'unresolved' | 'ambiguous'; discordId?: string; detail: string };

export type DivisionInspectionReport = {
  division: string;
  suffix: string;
  divisionRole?: InspectedRole & { botCanManage: boolean; permissionNames: string[] };
  captainRole?: InspectedRole;
  managerRole?: InspectedRole;
  genericCaptainRole?: InspectedRole;
  freeAgentRole?: InspectedRole;
  parentDivisionRole?: InspectedRole;
  franchises: string[];
  teamRoles: Array<{ franchise: string; role?: InspectedRole & { botCanManage: boolean; permissionNames: string[] }; holders: Array<{ id: string; name: string }> }>;
  extraTeamRoles: InspectedRole[];
  duplicateTeamRoleNames: string[];
  missingFranchiseRoles: Array<{ franchise: string; roleId: string }>;
  channels: Array<{ id: string; name: string; type: number; parent: string; overwrites: string[] }>;
  multipleTeamRoles: Array<{ id: string; name: string; roles: string[] }>;
  divisionRoleWithoutTeam: Array<{ id: string; name: string }>;
  teamRoleWithoutDivision: Array<{ id: string; name: string }>;
  layered: LayeredStatus[];
  unknownToRat: LayeredStatus[];
  inactiveOrSuspended: LayeredStatus[];
  draftTabFound: boolean;
  draftTeams: DraftTeam[];
  draftResolutions: DraftResolution[];
  teamRoleHoldersNotDrafted: Array<{ id: string; name: string; team: string }>;
  captains: Array<{ team: string; draftCaptain: string; captainRoleHolders: string[] }>;
  legacyEnv: { set: boolean; roleId?: string; roleName?: string; conflict?: string };
  rosterTabExists: boolean;
  templateTabExists: boolean;
  alreadyConfiguredTeams: number;
};

export function inspectDivision(input: {
  division: string;
  parentDivision?: string;
  discord: DiscordDivisionState;
  sheets: SheetDivisionState;
  legacyNiflheimRoleId?: string;
}): DivisionInspectionReport {
  const { division, discord, sheets } = input;
  const parentDivision = input.parentDivision ?? 'Svartalfheim';
  const suffix = divisionTeamSuffix(division);
  const roleById = new Map(discord.roles.map(role => [role.id, role]));
  const rolesNamed = (name: string) => discord.roles.filter(role => role.name.trim().toLowerCase() === name.toLowerCase());
  const botTop = Math.max(-1, ...discord.botRoleIds.map(id => roleById.get(id)?.position ?? -1));
  const decorate = (role: InspectedRole) => ({ ...role, botCanManage: role.position < botTop, permissionNames: permissionNames(role.permissions) });
  const humans = discord.members.filter(member => !member.user.bot);

  const teamRows = sheets.teams.filter(row => text(row[0]) && text(row[1]));
  const franchises = [...new Set(teamRows.filter(row => text(row[11]).toLowerCase() === 'yes').map(row => text(row[1])))].sort();
  const alreadyConfiguredTeams = teamRows.filter(row => text(row[2]) === division).length;
  const franchiseRoleIds = new Map(teamRows.map(row => [text(row[1]), text(row[5])]));
  const parentRow = teamRows.find(row => text(row[2]) === parentDivision);

  const divisionRole = rolesNamed(division)[0];
  const teamRolePattern = new RegExp(` ${suffix}$`);
  const allTeamRoles = discord.roles.filter(role => teamRolePattern.test(role.name.trim()));
  const teamRoles = franchises.map(franchise => {
    const role = allTeamRoles.find(candidate => candidate.name.trim() === `${franchise} ${suffix}`);
    return {
      franchise,
      ...(role ? { role: decorate(role) } : {}),
      holders: role ? humans.filter(member => member.roles.includes(role.id)).map(member => ({ id: member.user.id, name: displayName(member) })) : [],
    };
  });
  const expectedNames = new Set(franchises.map(franchise => `${franchise} ${suffix}`));
  const extraTeamRoles = allTeamRoles.filter(role => !expectedNames.has(role.name.trim()));
  const nameCounts = new Map<string, number>();
  for (const role of allTeamRoles) nameCounts.set(role.name.trim(), (nameCounts.get(role.name.trim()) ?? 0) + 1);
  const duplicateTeamRoleNames = [...nameCounts].filter(([, count]) => count > 1).map(([name]) => name);
  const missingFranchiseRoles = franchises.flatMap(franchise => {
    const roleId = franchiseRoleIds.get(franchise) ?? '';
    return roleId && !roleById.has(roleId) ? [{ franchise, roleId }] : [];
  });

  const teamRoleIds = new Set(allTeamRoles.map(role => role.id));
  const teamRoleNameById = new Map(allTeamRoles.map(role => [role.id, role.name.trim()]));
  const relevantMembers = humans.filter(member => member.roles.some(id => teamRoleIds.has(id)) || (divisionRole && member.roles.includes(divisionRole.id)));
  const multipleTeamRoles = relevantMembers.filter(member => member.roles.filter(id => teamRoleIds.has(id)).length > 1)
    .map(member => ({ id: member.user.id, name: displayName(member), roles: member.roles.filter(id => teamRoleIds.has(id)).map(id => teamRoleNameById.get(id)!) }));
  const divisionRoleWithoutTeam = divisionRole ? relevantMembers.filter(member => member.roles.includes(divisionRole.id) && !member.roles.some(id => teamRoleIds.has(id)))
    .map(member => ({ id: member.user.id, name: displayName(member) })) : [];
  const teamRoleWithoutDivision = relevantMembers.filter(member => member.roles.some(id => teamRoleIds.has(id)) && !(divisionRole && member.roles.includes(divisionRole.id)))
    .map(member => ({ id: member.user.id, name: displayName(member) }));

  // Layered status: compare each Niflheim member's roles with Rat's primary (Svartalfheim) record.
  const freeAgentRole = rolesNamed('Free Agent')[0];
  const parentDivisionRoleId = text(parentRow?.[7]);
  const parentDivisionRole = (parentDivisionRoleId && roleById.get(parentDivisionRoleId)) || rolesNamed(parentDivision)[0];
  const currentNames = new Map<string, Rows[number]>();
  for (const row of sheets.names) if (text(row[3]) === 'Current Discord Name' && text(row[0])) currentNames.set(text(row[0]), row);
  const rosterRowsById = new Map<string, Rows>();
  for (const row of sheets.rosters) if (text(row[4])) rosterRowsById.set(text(row[4]), [...(rosterRowsById.get(text(row[4])) ?? []), row]);
  const layered: LayeredStatus[] = relevantMembers.map(member => {
    const id = member.user.id;
    const record = currentNames.get(id);
    const niflheimTeams = member.roles.filter(roleId => teamRoleIds.has(roleId)).map(roleId => teamRoleNameById.get(roleId)!);
    const problems: string[] = [];
    const has = (role?: InspectedRole) => Boolean(role && member.roles.includes(role.id));
    let ratRecord = 'not in Rat (no Player Name History record)';
    if (record) {
      const recordDivision = text(record[4]), status = text(record[6]), franchise = text(record[5]);
      ratRecord = `${recordDivision || '(no division)'} ${status || '(no status)'}${franchise ? ` on ${franchise}` : ''}`;
      const primaryRoster = (rosterRowsById.get(id) ?? []).find(row => text(row[0]) !== division);
      if (recordDivision !== parentDivision) problems.push(`Rat records this player in ${recordDivision || 'no division'}, not ${parentDivision}.`);
      else if (status === 'Free Agent') {
        if (!has(freeAgentRole)) problems.push('Missing the Free Agent role expected for a free agent.');
      } else if (status === 'Player' || status === 'Captain') {
        if (has(freeAgentRole)) problems.push(`Holds Free Agent but Rat has them rostered on ${franchise || 'a team'}.`);
        const expectedTeamRole = text(primaryRoster?.[2]);
        if (!expectedTeamRole) problems.push(`Rat lists them as ${status} but has no ${parentDivision} roster row.`);
        else if (!member.roles.includes(expectedTeamRole)) problems.push(`Missing their ${parentDivision} team role (${roleById.get(expectedTeamRole)?.name ?? expectedTeamRole}).`);
      } else problems.push(`Rat status is ${status || 'blank'}; they would need reactivation.`);
      if (recordDivision === parentDivision && !has(parentDivisionRole)) problems.push(`Missing the ${parentDivision} division role.`);
    } else {
      if (!has(freeAgentRole)) problems.push('No Free Agent role.');
      if (!has(parentDivisionRole)) problems.push(`No ${parentDivision} division role.`);
    }
    if (niflheimTeams.length && !has(divisionRole)) problems.push(`Has a ${division} team role but not the ${division} division role.`);
    if (has(divisionRole) && !niflheimTeams.length) problems.push(`Has the ${division} division role but no ${division} team role.`);
    if (niflheimTeams.length > 1) problems.push(`Holds ${niflheimTeams.length} ${division} team roles.`);
    return { discordId: id, name: displayName(member), niflheimTeams, ratRecord, problems };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const unknownToRat = layered.filter(entry => !currentNames.has(entry.discordId));
  const inactiveOrSuspended = layered.filter(entry => {
    const status = text(currentNames.get(entry.discordId)?.[6]);
    return Boolean(status) && !['Free Agent', 'Player', 'Captain'].includes(status);
  });

  // Draft tab: resolve names to Discord IDs, preferring holders of that team's role.
  // Draft headers may name the franchise ("The Sewer") or its team role ("The Sewer ND"), as draftPicks.ts
  // accepts; normalize to the franchise once so role lookup, matching and captains all agree.
  const draftTeams = (sheets.draft ? parseDraftTeams(sheets.draft) : [])
    .map(team => ({ ...team, team: team.team.trim().replace(teamRolePattern, '') }));
  const directoryNames = new Map<string, string[]>();
  for (const row of sheets.memberDirectory) for (const value of row.slice(1, 4)) if (text(row[0]) && text(value)) directoryNames.set(text(row[0]), [...(directoryNames.get(text(row[0])) ?? []), text(value)]);
  const namesFor = (member: InspectedMember) => {
    const id = member.user.id;
    const record = currentNames.get(id);
    return [member.nick, member.user.global_name, member.user.username, text(record?.[1]), text(record?.[2]),
      ...sheets.names.filter(row => text(row[0]) === id).map(row => text(row[2])), ...(directoryNames.get(id) ?? [])]
      .filter((value): value is string => Boolean(value)).map(normalizeName).filter(Boolean);
  };
  const memberNames = new Map(humans.map(member => [member.user.id, new Set(namesFor(member))]));
  const draftResolutions: DraftResolution[] = [];
  const resolvedIds = new Set<string>();
  for (const team of draftTeams) {
    const teamRole = teamRoles.find(entry => entry.franchise === team.team)?.role;
    for (const [index, draftName] of [team.captain, ...team.picks].entries()) {
      if (!draftName) continue;
      const key = normalizeName(draftName);
      const matches = humans.filter(member => key && memberNames.get(member.user.id)!.has(key));
      const onTeam = teamRole ? matches.filter(member => member.roles.includes(teamRole.id)) : [];
      const captain = index === 0;
      if (onTeam.length === 1) {
        resolvedIds.add(onTeam[0]!.user.id);
        draftResolutions.push({ team: team.team, draftName, captain, outcome: 'matched', discordId: onTeam[0]!.user.id, detail: `matched ${displayName(onTeam[0]!)}, holds ${teamRole!.name}` });
      } else if (matches.length === 1) {
        resolvedIds.add(matches[0]!.user.id);
        draftResolutions.push({ team: team.team, draftName, captain, outcome: 'other-team', discordId: matches[0]!.user.id,
          detail: `matched ${displayName(matches[0]!)}, but they do not hold ${teamRole?.name ?? `the ${team.team} ${suffix} role`}` });
      } else if (matches.length > 1) {
        draftResolutions.push({ team: team.team, draftName, captain, outcome: 'ambiguous', detail: `${matches.length} members share this name: ${matches.map(member => `${displayName(member)} (${member.user.id})`).join(', ')}` });
      } else draftResolutions.push({ team: team.team, draftName, captain, outcome: 'unresolved', detail: 'no server member, Rat record or directory entry matches this name' });
    }
  }
  const teamRoleHoldersNotDrafted = sheets.draft ? teamRoles.flatMap(entry => entry.holders.filter(holder => !resolvedIds.has(holder.id))
    .map(holder => ({ ...holder, team: entry.franchise }))) : [];
  const captainRole = rolesNamed(`${division} Captain`)[0];
  const genericCaptainRole = rolesNamed('Captain')[0];
  const captains = draftTeams.map(team => {
    const holders = teamRoles.find(entry => entry.franchise === team.team)?.holders ?? [];
    return { team: team.team, draftCaptain: team.captain, captainRoleHolders: holders.filter(holder => {
      const member = humans.find(candidate => candidate.user.id === holder.id)!;
      return (captainRole && member.roles.includes(captainRole.id)) || (genericCaptainRole && member.roles.includes(genericCaptainRole.id));
    }).map(holder => holder.name) };
  });

  // Channels named after the division, or inside a category named after it.
  const categoryName = new Map(discord.channels.filter(channel => channel.type === 4).map(channel => [channel.id, channel.name]));
  const divisionKey = division.toLowerCase();
  const channels = discord.channels.filter(channel => channel.name.toLowerCase().includes(divisionKey)
    || (channel.parent_id ? (categoryName.get(channel.parent_id) ?? '').toLowerCase().includes(divisionKey) : false))
    .map(channel => ({
      id: channel.id, name: channel.name, type: channel.type, parent: channel.parent_id ? categoryName.get(channel.parent_id) ?? channel.parent_id : '(none)',
      overwrites: (channel.permission_overwrites ?? []).map(overwrite => {
        const target = overwrite.type === 0 ? roleById.get(overwrite.id)?.name ?? `role ${overwrite.id}`
          : `member ${humans.find(member => member.user.id === overwrite.id) ? displayName(humans.find(member => member.user.id === overwrite.id)!) : overwrite.id}`;
        const allow = permissionNames(overwrite.allow), deny = permissionNames(overwrite.deny);
        return `${target}: allow [${allow.join(', ') || 'none'}] deny [${deny.join(', ') || 'none'}]`;
      }),
    }));

  const legacyRoleId = input.legacyNiflheimRoleId?.trim();
  const legacyRole = legacyRoleId ? roleById.get(legacyRoleId) : undefined;
  const legacyEnv = legacyRoleId ? {
    set: true, roleId: legacyRoleId, ...(legacyRole ? { roleName: legacyRole.name } : {}),
    ...(divisionRole && legacyRoleId === divisionRole.id ? { conflict: `It points at the ${division} division role, which will clash once ${division} is a real division.` }
      : teamRoleIds.has(legacyRoleId) ? { conflict: `It points at a ${division} team role.` }
        : freeAgentRole && legacyRoleId === freeAgentRole.id ? { conflict: 'It points at the Free Agent role.' }
          : !legacyRole ? { conflict: 'It points at a role that no longer exists.' } : {}),
  } : { set: false };

  return {
    division, suffix,
    ...(divisionRole ? { divisionRole: decorate(divisionRole) } : {}),
    ...(captainRole ? { captainRole } : {}),
    ...(rolesNamed(`${division} Manager`)[0] ? { managerRole: rolesNamed(`${division} Manager`)[0] } : {}),
    ...(genericCaptainRole ? { genericCaptainRole } : {}),
    ...(freeAgentRole ? { freeAgentRole } : {}),
    ...(parentDivisionRole ? { parentDivisionRole } : {}),
    franchises, teamRoles, extraTeamRoles, duplicateTeamRoleNames, missingFranchiseRoles, channels,
    multipleTeamRoles, divisionRoleWithoutTeam, teamRoleWithoutDivision,
    layered, unknownToRat, inactiveOrSuspended,
    draftTabFound: Boolean(sheets.draft), draftTeams, draftResolutions, teamRoleHoldersNotDrafted, captains,
    legacyEnv,
    rosterTabExists: sheets.publicTitles.includes(`${division} Roster`),
    templateTabExists: sheets.publicTitles.includes('Roster Default (DNE)'),
    alreadyConfiguredTeams,
  };
}

const roleLine = (role: InspectedRole | undefined, label: string) => role
  ? `${label}: ${role.name} (${role.id}), position ${role.position}`
  : `${label}: not found`;

export function renderInspectionReport(report: DivisionInspectionReport): string {
  const lines: string[] = [];
  const section = (title: string) => lines.push('', `## ${title}`);
  const list = (items: string[], empty = 'None.') => lines.push(...(items.length ? items.map(item => `- ${item}`) : [empty]));
  const problems = report.layered.filter(entry => entry.problems.length).length;
  const unmatched = report.draftResolutions.filter(entry => entry.outcome !== 'matched').length;

  lines.push(`# ${report.division} inspection (read-only, nothing was changed)`);
  section('Summary');
  list([
    `${report.division} division role: ${report.divisionRole ? 'found' : 'NOT FOUND'}`,
    `Team roles (${report.suffix}): ${report.teamRoles.filter(entry => entry.role).length} of ${report.franchises.length} franchises found, ${report.extraTeamRoles.length} unexpected`,
    `${report.division} Captain role: ${report.captainRole ? 'found' : 'not found'}`,
    `Members holding ${report.division} roles: ${report.layered.length} (${problems} with something to review)`,
    `Members not yet in Rat's records: ${report.unknownToRat.length}`,
    `Members Rat lists as inactive or suspended: ${report.inactiveOrSuspended.length}`,
    `Draft tab: ${report.draftTabFound ? `${report.draftTeams.length} teams, ${report.draftResolutions.length} names, ${unmatched} need review` : 'not found'}`,
    `Old ROLE_NIFLHEIM_FREE_AGENT_ID setting: ${report.legacyEnv.set ? `set${report.legacyEnv.conflict ? ' (needs attention)' : ''}` : 'not set'}`,
    `Public "${report.division} Roster" tab: ${report.rosterTabExists ? 'exists' : 'missing'}; template "Roster Default (DNE)": ${report.templateTabExists ? 'exists' : 'missing'}`,
    `League Teams rows already set up for ${report.division}: ${report.alreadyConfiguredTeams}`,
  ]);

  section('Division roles');
  const decorated = report.divisionRole;
  list([
    decorated ? `${roleLine(decorated, 'Division role')}; Rat can manage it: ${decorated.botCanManage ? 'yes' : 'NO (role is above Rat)'}; permissions: ${decorated.permissionNames.join(', ') || 'none'}`
      : roleLine(undefined, 'Division role'),
    roleLine(report.captainRole, `${report.division} Captain role`),
    roleLine(report.managerRole, `${report.division} Manager role`),
    roleLine(report.genericCaptainRole, 'Captain role'),
    roleLine(report.freeAgentRole, 'Free Agent role'),
    roleLine(report.parentDivisionRole, 'Parent division role'),
  ]);

  section(`Team roles and members (proposed ${report.division} rosters)`);
  for (const entry of report.teamRoles) {
    lines.push(entry.role
      ? `- ${entry.franchise}: ${entry.role.name} (${entry.role.id}), position ${entry.role.position}, Rat can manage it: ${entry.role.botCanManage ? 'yes' : 'NO'}, permissions: ${entry.role.permissionNames.join(', ') || 'none'}`
      : `- ${entry.franchise}: no "${entry.franchise} ${report.suffix}" role found`);
    lines.push(...entry.holders.map(holder => `    - ${holder.name} (${holder.id})`));
  }
  if (report.extraTeamRoles.length) { lines.push('Unexpected team roles (no matching franchise):'); list(report.extraTeamRoles.map(role => `${role.name} (${role.id})`)); }
  if (report.duplicateTeamRoleNames.length) { lines.push('Team role names used more than once:'); list(report.duplicateTeamRoleNames); }
  if (report.missingFranchiseRoles.length) { lines.push('Franchise roles listed in League Teams but missing from Discord:'); list(report.missingFranchiseRoles.map(entry => `${entry.franchise} (${entry.roleId})`)); }

  section('Role conflicts');
  list([
    ...report.multipleTeamRoles.map(entry => `${entry.name} (${entry.id}) holds more than one team role: ${entry.roles.join(', ')}`),
    ...report.divisionRoleWithoutTeam.map(entry => `${entry.name} (${entry.id}) has the ${report.division} role but no team role`),
    ...report.teamRoleWithoutDivision.map(entry => `${entry.name} (${entry.id}) has a team role but not the ${report.division} role`),
  ]);

  section(`Each ${report.division} member compared with Rat's records`);
  list(report.layered.map(entry => `${entry.name} (${entry.discordId}) · team: ${entry.niflheimTeams.join(', ') || 'none'} · Rat: ${entry.ratRecord}`
    + (entry.problems.length ? ` · REVIEW: ${entry.problems.join(' ')}` : ' · OK')));

  section('Not yet in Rat (the import would add them as Svartalfheim free agents)');
  list(report.unknownToRat.map(entry => `${entry.name} (${entry.discordId})`));
  section('Inactive or suspended in Rat (would need reactivation)');
  list(report.inactiveOrSuspended.map(entry => `${entry.name} (${entry.discordId}) · Rat: ${entry.ratRecord}`));

  section('Draft tab');
  if (!report.draftTabFound) lines.push(`No "${report.division} Draft" tab was found.`);
  for (const team of report.draftTeams) lines.push(`- ${team.team}: captain ${team.captain || '(blank)'}; picks: ${team.picks.join(', ') || 'none'}`);
  const needsReview = report.draftResolutions.filter(entry => entry.outcome !== 'matched');
  if (report.draftTabFound) {
    lines.push('Draft names that need review:');
    list(needsReview.map(entry => `${entry.team}${entry.captain ? ' (captain)' : ''} · "${entry.draftName}" · ${entry.outcome}: ${entry.detail}`));
    lines.push('Team role holders not found in the draft tab:');
    list(report.teamRoleHoldersNotDrafted.map(entry => `${entry.name} (${entry.id}) on ${entry.team}`));
  }

  section('Captains');
  list(report.captains.map(entry => `${entry.team}: draft captain ${entry.draftCaptain || '(blank)'}; members holding a captain role: ${entry.captainRoleHolders.join(', ') || 'none'}`));

  section('Channels');
  for (const channel of report.channels) {
    lines.push(`- ${channel.name} (${channel.id}), type ${channel.type}, category ${channel.parent}`);
    lines.push(...channel.overwrites.map(overwrite => `    - ${overwrite}`));
  }
  if (!report.channels.length) lines.push('None found.');

  section('Old Niflheim free-agent setting (#178)');
  lines.push(report.legacyEnv.set
    ? `ROLE_NIFLHEIM_FREE_AGENT_ID is set to ${report.legacyEnv.roleName ?? 'an unknown role'} (${report.legacyEnv.roleId}). ${report.legacyEnv.conflict ?? 'No conflict found.'}`
    : 'ROLE_NIFLHEIM_FREE_AGENT_ID is not set.');

  return `${lines.join('\n')}\n`;
}
