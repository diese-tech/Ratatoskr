// Plans the one-time import of a hand-made layered division (Niflheim, #199) into the
// league Sheets. Pure: scripts/import-league-division.ts does the reads and writes.
// The import writes Sheets only. It never changes Discord roles; missing roles are
// listed for staff to fix afterwards with "Set Discord roles from roster sheets".
// Like divisionInspection.ts, this is maintenance-script code and must never be
// imported by bot runtime modules (ADR 0001 maintenance-script exception, #196).
import { createHash } from 'node:crypto';
import { LEAGUE_DIVISION_METADATA, isLeagueDivision } from '../domain/leagueDivisions.js';
import { PUBLIC_TEAM_CELLS } from './draftPickPresentation.js';
import { normalizeName } from './draftPicks.js';
import { inspectDivision, type DiscordDivisionState, type InspectedMember, type Rows } from './divisionInspection.js';
import { freeAgentCells } from './leagueSheets.js';

export type ImportSources = {
  division: string;
  date: string; // YYYY-MM-DD, used in source notes and history references
  discord: DiscordDivisionState;
  admin: {
    titles: string[];
    teams: Rows;      // 'League Teams'!A5:L   (row 0 is the header row 5)
    rosters: Rows;    // 'Current Rosters'!A5:J
    names: Rows;      // 'Player Name History'!A5:K
    history: Rows;    // 'Transaction History'!A5:M
    memberDirectory: Rows; // 'Member Directory'!A6:D
  };
  public: {
    titles: string[];
    draft?: Rows;         // '<Division> Draft'!A1:O60
    parentRoster: Rows;   // '<Parent> Roster'!A1:O99
    divisionRoster: Rows; // '<Division> Roster'!A1:O99, or the template when the tab does not exist yet
  };
  links?: Record<string, string>; // new Discord ID -> earlier Discord ID, approved by staff (--link)
  accepted?: string[];            // blocking finding IDs staff acknowledged (--accept)
};

export type ImportFinding = { id: string; blocking: boolean; text: string };
export type SheetUpdate = { range: string; values: (string | number | boolean | null)[][] };

export type ImportPlan = {
  division: string;
  parent: string;
  rosterTab: string;
  createRosterTab: boolean;
  adminUpdates: SheetUpdate[];
  publicUpdates: SheetUpdate[];
  teamsAdded: string[];
  playersAdded: Array<{ id: string; name: string; team: string; status: 'Captain' | 'Player' }>;
  newToRat: Array<{ id: string; name: string }>;
  reactivated: Array<{ id: string; name: string; linkedFrom?: string }>;
  roleFixes: string[];
  findings: ImportFinding[];
  blocked: boolean;
  hash: string;
};

const TEMPLATE_TAB = 'Roster Default (DNE)';
const text = (value: unknown) => (value === null || value === undefined ? '' : String(value)).trim();
const column = (index: number) => String.fromCharCode(65 + index);
const displayName = (member: InspectedMember) => member.nick || member.user.global_name || member.user.username;
const ACTIVE = ['Free Agent', 'Player', 'Captain'];

export function planDivisionImport(src: ImportSources): ImportPlan {
  const { division, date } = src;
  if (!isLeagueDivision(division) || !LEAGUE_DIVISION_METADATA[division].layeredOn)
    throw new Error(`${division} is not a layered league division this import supports.`);
  const parent = LEAGUE_DIVISION_METADATA[division].layeredOn!;
  const rosterTab = LEAGUE_DIVISION_METADATA[division].publicTab;
  const parentTab = LEAGUE_DIVISION_METADATA[parent].publicTab;
  const note = `${division} import ${date}`;
  const accepted = new Set(src.accepted ?? []);
  const links = src.links ?? {};
  const findings: ImportFinding[] = [];
  const block = (id: string, value: string) => findings.push({ id, blocking: !accepted.has(id), text: value });
  const warn = (id: string, value: string) => findings.push({ id, blocking: false, text: value });

  const report = inspectDivision({
    division, parentDivision: parent, discord: src.discord,
    sheets: { adminTitles: src.admin.titles, publicTitles: src.public.titles, teams: src.admin.teams.slice(1),
      names: src.admin.names.slice(1), rosters: src.admin.rosters.slice(1), memberDirectory: src.admin.memberDirectory,
      ...(src.public.draft ? { draft: src.public.draft } : {}) },
  });
  const createRosterTab = !src.public.titles.includes(rosterTab);
  if (createRosterTab && !src.public.titles.includes(TEMPLATE_TAB))
    block('no-template', `The public workbook has no "${rosterTab}" tab and no "${TEMPLATE_TAB}" template to copy.`);
  if (!report.divisionRole) block('no-division-role', `No "${division}" division role exists in Discord.`);
  if (!report.draftTabFound) block('no-draft-tab', `No "${division} Draft" tab exists, so the team rosters cannot be checked against the draft.`);
  for (const entry of report.multipleTeamRoles) block(`two-team-roles:${entry.id}`, `${entry.name} holds more than one ${division} team role: ${entry.roles.join(', ')}.`);
  for (const name of report.duplicateTeamRoleNames) block(`duplicate-role:${name}`, `More than one Discord role is named "${name}".`);
  for (const entry of report.draftResolutions.filter(entry => entry.outcome !== 'matched'))
    block(`draft-name:${entry.team}:${entry.draftName}`, `${entry.team} draft name "${entry.draftName}" could not be matched to one team member (${entry.detail}).`);
  for (const entry of report.teamRoleHoldersNotDrafted)
    block(`not-drafted:${entry.id}`, `${entry.name} holds the ${entry.team} ${report.suffix} role but is not on that team in the draft tab.`);
  for (const entry of report.divisionRoleWithoutTeam)
    warn(`division-role-only:${entry.id}`, `${entry.name} has the ${division} role but no team role. They are not imported; "Set Discord roles from roster sheets" will remove the role.`);
  for (const entry of report.teamRoles.filter(entry => entry.role && !entry.role.botCanManage))
    warn(`role-above-rat:${entry.franchise}`, `${entry.role!.name} is above Rat's role, so Rat cannot fix it in Discord later. Move Rat's role above it.`);

  // Team rows: append one League Teams row per franchise that has team-role holders.
  const teams = src.admin.teams;
  const franchiseRow = new Map(teams.slice(1).filter(row => text(row[2]) === parent).map(row => [text(row[1]), row]));
  const existingTeam = new Map(teams.slice(1).filter(row => text(row[2]) === division).map(row => [text(row[1]), row]));
  const importTeams = report.teamRoles.filter(entry => entry.role && entry.holders.length);
  const adminUpdates: SheetUpdate[] = [];
  let nextTeamRow = teams.length + 5;
  const teamsAdded: string[] = [];
  for (const entry of importTeams) {
    const role = entry.role!;
    const existing = existingTeam.get(entry.franchise);
    if (existing) {
      if (text(existing[3]) !== role.id || text(existing[11]).toLowerCase() !== 'yes')
        block(`team-row:${entry.franchise}`, `League Teams already has a ${division} ${entry.franchise} row that does not match the ${role.name} role.`);
      continue;
    }
    const source = franchiseRow.get(entry.franchise);
    if (!source) { block(`no-franchise:${entry.franchise}`, `League Teams has no ${parent} ${entry.franchise} row to copy the franchise role from.`); continue; }
    if (!PUBLIC_TEAM_CELLS[entry.franchise]) { block(`no-block:${entry.franchise}`, `${entry.franchise} has no public roster block layout.`); continue; }
    adminUpdates.push({ range: `'League Teams'!A${nextTeamRow}:L${nextTeamRow}`, values: [[
      `${division}|${entry.franchise}`, entry.franchise, division, role.id, role.name, text(source[5]), text(source[6]),
      report.divisionRole?.id ?? '', report.divisionRole?.name ?? division,
      report.captainRole?.id ?? '', report.captainRole?.name ?? '', 'Yes']] });
    nextTeamRow += 1;
    teamsAdded.push(entry.franchise);
  }
  if (!report.captainRole) warn('no-captain-role', `No "${division} Captain" role exists; the team rows leave the captain role blank.`);

  // Players: one layered roster row each, on top of a current parent-division record.
  const names = src.admin.names;
  const currentRow = new Map<string, { row: Rows[number]; sheetRow: number }>();
  names.slice(1).forEach((row, index) => { if (text(row[3]) === 'Current Discord Name') currentRow.set(text(row[0]), { row, sheetRow: index + 6 }); });
  const layeredRows = src.admin.rosters.slice(1).filter(row => text(row[0]) === division);
  const existingLayered = new Map(layeredRows.map(row => [text(row[4]), row]));
  for (const id of existingLayered.keys())
    if (layeredRows.filter(row => text(row[4]) === id).length > 1)
      block(`duplicate-row:${id}`, `Current Rosters has more than one ${division} row for ${text(existingLayered.get(id)![5])} (${id}). Keep one, then run the dry run again.`);
  const holderIds = new Set(importTeams.flatMap(entry => entry.holders.map(holder => holder.id)));
  for (const [id, row] of existingLayered)
    if (!holderIds.has(id)) block(`stale-row:${id}`, `Current Rosters has a ${division} row for ${text(row[5])} (${id}), who no longer holds a ${division} team role.`);
  const memberById = new Map(src.discord.members.map(member => [member.user.id, member]));
  const draftCaptains = new Map(report.draftResolutions.filter(entry => entry.captain && entry.discordId).map(entry => [entry.team, entry.discordId!]));
  const draftOrder = new Map(report.draftResolutions.filter(entry => entry.discordId).map((entry, index) => [entry.discordId!, index]));
  const nameUpdates: SheetUpdate[] = [];
  const rosterRows: SheetUpdate['values'] = [];
  const newNameRows: SheetUpdate['values'] = [];
  const historyRows: SheetUpdate['values'] = [];
  const parentFreeAgents: string[] = [];
  const playersAdded: ImportPlan['playersAdded'] = [];
  const newToRat: ImportPlan['newToRat'] = [];
  const reactivated: ImportPlan['reactivated'] = [];
  const blockNames = new Map<string, string[]>();
  const existingHistory = new Set(src.admin.history.map(row => text(row[0])));
  const historyReference = (id: string) => `YSL-IMPORT-${division.toUpperCase()}-${date}-${id}`;
  const reactivationRow = (id: string, name: string, linkedFrom?: string) => existingHistory.has(historyReference(id)) ? [] : [[
    historyReference(id), 'reactivation', date, parent, 'Inactive', 'Free Agents', id, name, '', linkedFrom ? `Linked from ${linkedFrom}` : '',
    'Completed', note, '']];

  for (const entry of importTeams) {
    const captainRoleId = report.captainRole?.id;
    const holders = [...entry.holders].sort((a, b) => (draftOrder.get(a.id) ?? 999) - (draftOrder.get(b.id) ?? 999) || a.name.localeCompare(b.name));
    const draftCaptain = draftCaptains.get(entry.franchise);
    const roleCaptains = holders.filter(holder => captainRoleId && memberById.get(holder.id)?.roles.includes(captainRoleId)).map(holder => holder.id);
    if (draftCaptain && roleCaptains.length && (roleCaptains.length !== 1 || roleCaptains[0] !== draftCaptain))
      block(`captain:${entry.franchise}`, `${entry.franchise}'s draft captain does not match who holds the ${division} Captain role.`);
    const captainId = draftCaptain ?? (roleCaptains.length === 1 ? roleCaptains[0] : undefined);
    const blockPlayers: string[] = [];
    for (const holder of holders) {
      const member = memberById.get(holder.id)!;
      const discordName = displayName(member);
      const record = currentRow.get(holder.id);
      let leagueName = discordName;
      if (record) {
        const recordDivision = text(record.row[4]), status = text(record.row[6]);
        leagueName = text(record.row[1]);
        if (recordDivision !== parent) block(`wrong-division:${holder.id}`, `${holder.name} is a ${recordDivision || 'no-division'} player in Rat. Only ${parent} players can join ${division} through Rat.`);
        else if (status === 'Inactive') {
          nameUpdates.push({ range: `'Player Name History'!E${record.sheetRow}:G${record.sheetRow}`, values: [[parent, '', 'Free Agent']] });
          historyRows.push(...reactivationRow(holder.id, leagueName));
          parentFreeAgents.push(leagueName);
          reactivated.push({ id: holder.id, name: leagueName });
        } else if (!ACTIVE.includes(status)) block(`status:${holder.id}`, `${holder.name} is ${status.startsWith('Suspended') ? 'suspended' : `marked "${status}"`} in Rat and is not reactivated automatically. Staff decide first.`);
      } else {
        const earlier = links[holder.id];
        const memberNames = new Set([member.nick, member.user.global_name, member.user.username].filter(Boolean).map(value => normalizeName(value!)));
        const candidates = [...currentRow.entries()].filter(([id, value]) => id !== holder.id
          && [text(value.row[1]), text(value.row[2])].some(name => name && memberNames.has(normalizeName(name))));
        if (earlier) {
          const old = currentRow.get(earlier);
          if (!old || text(old.row[6]) !== 'Inactive' || memberById.has(earlier) || src.admin.rosters.slice(1).some(row => text(row[4]) === earlier))
            block(`link:${holder.id}`, `${holder.name} cannot be linked to ${earlier}: that earlier account must be Inactive in Rat, out of the server and on no roster.`);
          else {
            nameUpdates.push({ range: `'Player Name History'!D${old.sheetRow}`, values: [['Previous / Alternate']] });
            newNameRows.push([holder.id, discordName, text(old.row[1]), 'Current Discord Name', parent, '', 'Free Agent', date, date, note,
              `Same player as earlier account ${earlier}; linked by the ${division} import.`]);
            historyRows.push(...reactivationRow(holder.id, discordName, earlier));
            reactivated.push({ id: holder.id, name: discordName, linkedFrom: earlier });
            parentFreeAgents.push(discordName);
          }
        } else {
          for (const [id, value] of candidates)
            block(`earlier-account:${holder.id}`, `${holder.name} (${holder.id}) is new to Rat, but Rat already has "${text(value.row[1])}" (${id}, ${text(value.row[6]) || 'no status'}). If this is the same player, re-run with --link=${holder.id}:${id}. Otherwise accept this finding to add them as a new player.`);
          newNameRows.push([holder.id, discordName, discordName, 'Current Discord Name', parent, '', 'Free Agent', date, date, note,
            `Added by the ${division} import.`]);
          parentFreeAgents.push(discordName);
          newToRat.push({ id: holder.id, name: discordName });
        }
      }
      blockPlayers.push(leagueName);
      const status = holder.id === captainId ? 'Captain' : 'Player';
      const existing = existingLayered.get(holder.id);
      if (existing) {
        if (text(existing[2]) !== entry.role!.id) block(`roster-row:${holder.id}`, `${holder.name} already has a ${division} roster row for a different team.`);
        continue;
      }
      rosterRows.push([division, entry.franchise, entry.role!.id, entry.role!.name, holder.id, leagueName, status, 'OK', note, `${date}T00:00:00.000Z`]);
      playersAdded.push({ id: holder.id, name: leagueName, team: entry.franchise, status });
    }
    if (holders.length > 7) warn(`roster-size:${entry.franchise}`, `${entry.franchise} has ${holders.length} players, above the roster cap of 7.`);
    blockNames.set(entry.franchise, captainId ? [blockPlayers[holders.findIndex(holder => holder.id === captainId)]!, ...blockPlayers.filter((_, index) => holders[index]!.id !== captainId)] : blockPlayers);
  }
  let nextRosterRow = src.admin.rosters.length + 5;
  for (const values of rosterRows) adminUpdates.push({ range: `'Current Rosters'!A${nextRosterRow}:J${nextRosterRow++}`, values: [values] });
  adminUpdates.push(...nameUpdates);
  let nextNameRow = names.length + 5;
  for (const values of newNameRows) adminUpdates.push({ range: `'Player Name History'!A${nextNameRow}:K${nextNameRow++}`, values: [values] });
  let nextHistoryRow = src.admin.history.length + 5;
  for (const values of historyRows) adminUpdates.push({ range: `'Transaction History'!A${nextHistoryRow}:M${nextHistoryRow++}`, values: [values] });

  // Public: fill the division's team blocks and add new parent free agents to empty owned cells.
  const publicUpdates: SheetUpdate[] = [];
  const grid = src.public.divisionRoster;
  for (const [franchise, players] of blockNames) {
    const cells = PUBLIC_TEAM_CELLS[franchise]!;
    if (text(grid[cells.startRow - 3]?.[cells.column - 1]) !== franchise || text(grid[cells.startRow - 1]?.[cells.column - 1]) !== 'Cap:') {
      block(`layout:${franchise}`, `The ${createRosterTab ? TEMPLATE_TAB : rosterTab} tab does not have the expected ${franchise} block (team name above a "Cap:" row).`);
      continue;
    }
    const slots = Array.from({ length: cells.endRow - cells.startRow + 1 }, (_, index) => cells.startRow + index);
    const present = new Set(slots.map(row => text(grid[row - 1]?.[cells.column])).filter(Boolean));
    const missing = players.filter(name => !present.has(name));
    const empty = slots.filter(row => !text(grid[row - 1]?.[cells.column]));
    if (missing.length > empty.length || [...present].some(name => !players.includes(name))) {
      block(`block:${franchise}`, `The ${rosterTab} ${franchise} block has names that are not on the team, or not enough empty rows.`);
      continue;
    }
    // A fresh block is filled in roster order with the captain first; otherwise only empty rows are used.
    missing.forEach((name, index) => publicUpdates.push({ range: `'${rosterTab}'!${column(cells.column)}${empty[index]}`, values: [[name]] }));
  }
  const parentGrid = src.public.parentRoster;
  const faCells = freeAgentCells.flatMap(cell => Array.from({ length: cell.endRow - cell.startRow + 1 }, (_, index) => ({ row: cell.startRow + index, column: cell.column })));
  const listed = new Set(faCells.map(cell => text(parentGrid[cell.row - 1]?.[cell.column])).filter(Boolean));
  const emptyFa = faCells.filter(cell => !text(parentGrid[cell.row - 1]?.[cell.column]));
  const faMissing = parentFreeAgents.filter(name => !listed.has(name));
  if (faMissing.length > emptyFa.length) block('fa-list-full', `The ${parentTab} free-agent list has no room for ${faMissing.length} more names.`);
  else faMissing.forEach((name, index) => publicUpdates.push({ range: `'${parentTab}'!${column(emptyFa[index]!.column)}${emptyFa[index]!.row}`, values: [[name]] }));

  const roleFixes = report.layered.filter(entry => holderIds.has(entry.discordId) && entry.problems.length)
    .map(entry => `${entry.name}: ${entry.problems.join(' ')}`);
  const blocked = findings.some(finding => finding.blocking);
  const body = { division, parent, rosterTab, createRosterTab, adminUpdates, publicUpdates, teamsAdded, playersAdded, newToRat, reactivated, roleFixes, findings, blocked };
  // The hash binds the reviewed plan to every input it was built from, so any change aborts --write.
  const hash = createHash('sha256').update(JSON.stringify({ body, admin: src.admin, public: src.public })).digest('hex');
  return { ...body, hash };
}

export function renderImportPlan(plan: ImportPlan, write: boolean): string {
  const lines: string[] = [`# ${plan.division} import ${write ? '' : '(dry run, nothing was changed)'}`.trim(), ''];
  const list = (title: string, items: string[]) => lines.push(`## ${title} (${items.length})`, ...(items.length ? items.map(item => `- ${item}`) : ['None.']), '');
  const blocking = plan.findings.filter(finding => finding.blocking);
  list('Must be resolved before importing', blocking.map(finding => `[${finding.id}] ${finding.text}`));
  list('For your information', plan.findings.filter(finding => !finding.blocking).map(finding => `[${finding.id}] ${finding.text}`));
  list('Teams to add to League Teams', plan.teamsAdded);
  list(`Players to add to ${plan.division} rosters`, plan.playersAdded.map(player => `${player.name} (${player.id}) → ${player.team}${player.status === 'Captain' ? ' (captain)' : ''}`));
  list(`New to Rat (added as ${plan.parent} free agents)`, plan.newToRat.map(player => `${player.name} (${player.id})`));
  list(`Returning to ${plan.parent} free agency`, plan.reactivated.map(player => `${player.name} (${player.id})${player.linkedFrom ? `, linked to earlier account ${player.linkedFrom}` : ''}`));
  lines.push(`## Public sheet`, plan.createRosterTab ? `- Create "${plan.rosterTab}" from "${TEMPLATE_TAB}".` : `- "${plan.rosterTab}" already exists.`,
    `- ${plan.publicUpdates.length} cells to fill.`, '');
  list('Discord roles to fix afterwards with "Set Discord roles from roster sheets"', plan.roleFixes);
  lines.push(`Sheet cells to write: ${plan.adminUpdates.length} Admin, ${plan.publicUpdates.length} public. Discord roles are never changed by this import.`);
  lines.push(blocking.length
    ? 'Nothing can be imported until every item in "Must be resolved" is fixed or accepted with --accept=<id>.'
    : plan.adminUpdates.length || plan.publicUpdates.length || plan.createRosterTab
      ? `Plan hash: ${plan.hash}`
      : 'Everything is already imported. There is nothing to do.');
  return `${lines.join('\n')}\n`;
}
