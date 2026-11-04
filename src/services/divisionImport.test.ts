import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PUBLIC_TEAM_CELLS, publicTeamCellsFor } from './draftPickPresentation.js';
import { planDivisionImport, renderImportPlan, type ImportSources, type SheetUpdate } from './divisionImport.js';
import type { InspectedMember, Rows } from './divisionInspection.js';
import { auditLeagueRoster } from '../domain/leagueOperations.js';
import { LeagueSheetsService, type LeagueSheetsGateway } from './leagueSheets.js';

const role = (id: string, name: string, position: number) => ({ id, name, position, permissions: '0' });
const member = (id: string, name: string, roles: string[], username = name.toLowerCase()): InspectedMember =>
  ({ user: { id, username, global_name: name }, nick: null, roles });
const grid = (): Rows => Array.from({ length: 99 }, () => Array<string>(15).fill(''));

function template(layout = PUBLIC_TEAM_CELLS): Rows {
  const rows = grid();
  for (const [franchise, cells] of Object.entries(layout)) {
    rows[cells.startRow - 3]![cells.column - 1] = franchise;
    rows[cells.startRow - 1]![cells.column - 1] = 'Cap:';
    for (let row = cells.startRow + 1; row <= cells.endRow; row += 1) rows[row - 1]![cells.column - 1] = String(row - cells.startRow);
  }
  return rows;
}

function sources(): ImportSources {
  const roles = [role('bot', 'Ratatoskr', 50), role('nifl', 'Niflheim', 10), role('spicy-nd', 'Something Spicy ND', 9),
    role('rat-nd', 'The Rat Pack ND', 8), role('fa', 'Free Agent', 5), role('svarta', 'Svartalfheim', 4),
    role('niflcap', 'Niflheim Captain', 2), role('lm-sd', 'Little Monsters SD', 1)];
  const members = [
    member('111111111111111111', 'TimmyTurntHer', ['spicy-nd', 'fa', 'svarta', 'nifl']),
    member('222222222222222222', 'Qronch', ['spicy-nd', 'lm-sd', 'svarta', 'nifl', 'niflcap']),
    member('333333333333333333', 'Deadeye', ['rat-nd', 'nifl', 'niflcap'], 'deadeyeee_'),
    member('444444444444444444', 'Thinks', ['rat-nd', 'nifl', 'fa', 'svarta']),
    { user: { id: '999999999999999999', username: 'rat', bot: true }, roles: ['bot'] },
  ];
  const draft = grid();
  const draftBlock = (top: number, column: number, team: string, captain: string, picks: string[]) => {
    draft[top]![column] = team; draft[top + 2]![column] = 'Cap:'; draft[top + 2]![column + 1] = captain;
    picks.forEach((pick, index) => { draft[top + 3 + index]![column] = String(index + 1); draft[top + 3 + index]![column + 1] = pick; });
  };
  draftBlock(2, 1, 'Something Spicy', 'Qronch', ['TimmyTurntHer']);
  draftBlock(2, 5, 'The Rat Pack ND', 'Deadeyeee', ['Thinks']);
  const parentRoster = template();
  parentRoster[24]![6] = 'TimmyTurntHer';
  parentRoster[4]![10] = 'Qronch';
  const svartaTeam = (franchise: string, roleId: string) => [`Svartalfheim|${franchise}`, franchise, 'Svartalfheim', roleId, `${franchise} SD`,
    `${franchise}-franchise`, franchise, 'svarta', 'Svartalfheim', '', '', 'Yes'];
  return {
    division: 'Niflheim', date: '2026-11-05',
    discord: { roles, members, channels: [], botRoleIds: ['bot'] },
    admin: {
      titles: ['League Teams', 'Current Rosters', 'Player Name History', 'Transaction History'],
      teams: [['Team Key'], svartaTeam('Something Spicy', 'ss-sd'), svartaTeam('The Rat Pack', 'rp-sd'), svartaTeam('Little Monsters', 'lm-sd')],
      rosters: [['Division'], ['Svartalfheim', 'Little Monsters', 'lm-sd', 'Little Monsters SD', '222222222222222222', 'Qronch', 'Player', 'OK', '', '']],
      names: [['Discord ID'],
        ['111111111111111111', 'TimmyTurntHer', 'TimmyTurntHer', 'Current Discord Name', 'Svartalfheim', '', 'Free Agent'],
        ['222222222222222222', 'Qronch', 'Qronch', 'Current Discord Name', 'Svartalfheim', 'Little Monsters', 'Player'],
        ['444444444444444444', 'Thinks', 'Thinks', 'Current Discord Name', 'Svartalfheim', '', 'Inactive']],
      history: [['Reference']],
      memberDirectory: [],
    },
    public: { titles: ['Svartalfheim Roster', 'Niflheim Roster', 'Niflheim Draft'], draft, parentRoster, divisionRoster: template(publicTeamCellsFor('Niflheim')) },
  };
}

const cell = (updates: SheetUpdate[], range: string) => updates.find(update => update.range === range)?.values;

test('the import plans team rows, layered roster rows, new and returning free agents and the public tab', () => {
  const plan = planDivisionImport(sources());
  assert.deepEqual(plan.findings.filter(finding => finding.blocking), []);
  assert.deepEqual(plan.teamsAdded, ['Something Spicy', 'The Rat Pack']);
  assert.deepEqual(cell(plan.adminUpdates, "'League Teams'!A9:L9"), [['Niflheim|Something Spicy', 'Something Spicy', 'Niflheim', 'spicy-nd',
    'Something Spicy ND', 'Something Spicy-franchise', 'Something Spicy', 'nifl', 'Niflheim', 'niflcap', 'Niflheim Captain', 'Yes']]);
  assert.deepEqual(plan.playersAdded.map(player => [player.name, player.team, player.status]), [
    ['Qronch', 'Something Spicy', 'Captain'], ['TimmyTurntHer', 'Something Spicy', 'Player'],
    ['Deadeye', 'The Rat Pack', 'Captain'], ['Thinks', 'The Rat Pack', 'Player']]);
  assert.deepEqual(cell(plan.adminUpdates, "'Current Rosters'!A7:J7"), [['Niflheim', 'Something Spicy', 'spicy-nd', 'Something Spicy ND',
    '222222222222222222', 'Qronch', 'Captain', 'OK', 'Niflheim import 2026-11-05', '2026-11-05T00:00:00.000Z']]);
  // New to Rat: a Svartalfheim free-agent record. Inactive and drafted: reactivated with one history row.
  assert.deepEqual(plan.newToRat, [{ id: '333333333333333333', name: 'Deadeye' }]);
  assert.deepEqual(cell(plan.adminUpdates, "'Player Name History'!A9:K9")![0]!.slice(0, 7),
    ['333333333333333333', 'Deadeye', 'Deadeye', 'Current Discord Name', 'Svartalfheim', '', 'Free Agent']);
  assert.deepEqual(cell(plan.adminUpdates, "'Player Name History'!E8:G8"), [['Svartalfheim', '', 'Free Agent']]);
  assert.deepEqual(cell(plan.adminUpdates, "'Transaction History'!A6:M6")![0]!.slice(0, 8),
    ['YSL-IMPORT-NIFLHEIM-2026-11-05-444444444444444444', 'reactivation', '2026-11-05', 'Svartalfheim', 'Inactive', 'Free Agents', '444444444444444444', 'Thinks']);
  assert.equal(plan.adminUpdates.filter(update => update.range.startsWith("'Transaction History'")).length, 1, 'only reactivations write history');
  // Public: Niflheim's own block positions, captain first; new Svartalfheim free agents fill empty owned cells.
  assert.deepEqual(plan.publicUpdates.map(update => `${update.range}=${update.values[0]![0]}`), [
    "'Niflheim Roster'!K5=Qronch", "'Niflheim Roster'!K6=TimmyTurntHer",
    "'Niflheim Roster'!C16=Deadeye", "'Niflheim Roster'!C17=Thinks",
    "'Svartalfheim Roster'!G26=Deadeye", "'Svartalfheim Roster'!G27=Thinks"]);
  assert.match(plan.roleFixes.join('\n'), /Deadeye: No Free Agent role\. No Svartalfheim division role\./);
  assert.match(renderImportPlan(plan, false), /dry run, nothing was changed[\s\S]*Plan hash: [0-9a-f]{64}/);
});

test('ambiguous or unsafe data blocks the import until fixed or explicitly accepted', () => {
  const blocked = (mutate: (src: ImportSources) => void) => {
    const src = sources();
    mutate(src);
    return planDivisionImport(src).findings.filter(finding => finding.blocking).map(finding => finding.id);
  };
  assert.deepEqual(blocked(src => { src.discord.members[0]!.roles.push('rat-nd'); }), ['two-team-roles:111111111111111111']);
  assert.deepEqual(blocked(src => { src.public.draft![5]![2] = ''; }), ['not-drafted:111111111111111111']);
  assert.deepEqual(blocked(src => { src.public.draft![5]![2] = 'Ghost'; }).filter(id => id.startsWith('draft-name')), ['draft-name:Something Spicy:Ghost']);
  assert.ok(blocked(src => { src.public.divisionRoster[2]![9] = 'Renamed'; }).includes('layout:Something Spicy'));
  assert.ok(blocked(src => { src.public.divisionRoster[4]![10] = 'Stranger'; }).includes('block:Something Spicy'));
  assert.ok(blocked(src => { src.public.titles = src.public.titles.filter(title => title !== 'Niflheim Roster'); }).includes('no-roster-tab'));
  assert.ok(blocked(src => { for (let row = 24; row < 99; row += 1) { src.public.parentRoster[row]![6] = `x${row}`; src.public.parentRoster[row]![10] = `y${row}`; } }).includes('fa-list-full'));
  assert.ok(blocked(src => { src.admin.names[3]![6] = 'Suspended - Self-Drop (Current + Next Season)'; }).includes('status:444444444444444444'));
  assert.ok(blocked(src => { src.admin.names[1]![4] = 'Vanaheim'; }).includes('wrong-division:111111111111111111'));
  assert.ok(blocked(src => { src.discord.members[2]!.roles = ['rat-nd', 'nifl']; src.discord.members[3]!.roles.push('niflcap'); }).includes('captain:The Rat Pack'));
  const src = sources();
  src.discord.members[0]!.roles.push('rat-nd');
  src.accepted = ['two-team-roles:111111111111111111'];
  assert.equal(planDivisionImport(src).blocked, false);
  assert.match(renderImportPlan(planDivisionImport(sources()), false), /Must be resolved before importing \(0\)/);
});

test('a player on a new account is held until staff link the earlier account or accept them as new', () => {
  const src = sources();
  src.discord.members[3]!.user.id = '555555555555555555';
  const plan = planDivisionImport(src);
  assert.deepEqual(plan.findings.filter(finding => finding.blocking).map(finding => finding.id), ['earlier-account:555555555555555555']);
  assert.match(plan.findings[0]!.text, /--link=555555555555555555:444444444444444444/);
  src.links = { '555555555555555555': '444444444444444444' };
  const linked = planDivisionImport(src);
  assert.equal(linked.blocked, false);
  assert.deepEqual(cell(linked.adminUpdates, "'Player Name History'!D8"), [['Previous / Alternate']]);
  assert.deepEqual(cell(linked.adminUpdates, "'Player Name History'!A10:K10")![0]!.slice(0, 7),
    ['555555555555555555', 'Thinks', 'Thinks', 'Current Discord Name', 'Svartalfheim', '', 'Free Agent']);
  assert.deepEqual(linked.reactivated, [{ id: '555555555555555555', name: 'Thinks', linkedFrom: '444444444444444444' }]);
  src.links = { '555555555555555555': '111111111111111111' };
  assert.ok(planDivisionImport(src).findings.some(finding => finding.id === 'link:555555555555555555' && finding.blocking));
});

function applyUpdates(src: ImportSources, plan: ReturnType<typeof planDivisionImport>): ImportSources {
  const next = structuredClone(src);
  const tabs: Record<string, [Rows, number]> = {
    'League Teams': [next.admin.teams, 5], 'Current Rosters': [next.admin.rosters, 5], 'Player Name History': [next.admin.names, 5],
    'Transaction History': [next.admin.history, 5], 'Niflheim Roster': [next.public.divisionRoster, 1], 'Svartalfheim Roster': [next.public.parentRoster, 1],
  };
  for (const update of [...plan.adminUpdates, ...plan.publicUpdates]) {
    const [, tab, letter, row] = /^'([^']+)'!([A-O])(\d+)/.exec(update.range)!;
    const [rows, origin] = tabs[tab!]!;
    const index = Number(row) - origin;
    while (rows.length <= index) rows.push([]);
    update.values[0]!.forEach((value, offset) => { rows[index]![letter!.charCodeAt(0) - 65 + offset] = value; });
  }
  return next;
}

test('applying the plan leaves nothing to import, and the result passes the roster audit apart from role fixes', async () => {
  const src = sources();
  const plan = planDivisionImport(src);
  const after = applyUpdates(src, plan);
  const again = planDivisionImport(after);
  assert.deepEqual([again.adminUpdates, again.publicUpdates, again.blocked], [[], [], false]);
  assert.match(renderImportPlan(again, false), /Everything is already imported/);

  // Load the imported sheets through the bot's own reader and audit them with the Discord roles staff will set.
  const data = new Map<string, Rows>([
    ["admin:'League Teams'!A5:L100", after.admin.teams], ["admin:'Current Rosters'!A5:J", after.admin.rosters],
    ["admin:'Player Name History'!A5:K", after.admin.names],
    ...['Vanaheim', 'Alfheim'].map(division => [`public:'${division} Roster'!A1:O99`, grid()] as [string, Rows]),
    ["public:'Svartalfheim Roster'!A1:O99", after.public.parentRoster], ["public:'Niflheim Roster'!A1:O99", after.public.divisionRoster],
  ]);
  const gateway = {
    getValues: async (id: string, range: string) => structuredClone(data.get(`${id}:${range}`) ?? []),
    getSelfDropPresentation: async () => ({ sheetId: 1, legend: [], ruleExists: false }),
  } as unknown as LeagueSheetsGateway;
  const fixedRoles: Record<string, string[]> = {
    '111111111111111111': ['spicy-nd', 'fa', 'svarta', 'nifl'], '222222222222222222': ['spicy-nd', 'lm-sd', 'svarta', 'nifl'],
    '333333333333333333': ['rat-nd', 'nifl', 'fa', 'svarta'], '444444444444444444': ['rat-nd', 'nifl', 'fa', 'svarta'],
  };
  const members = Object.entries(fixedRoles).map(([discordId, roleIds]) => ({ discordId, roleIds,
    displayName: after.discord.members.find(entry => entry.user.id === discordId)!.user.global_name! }));
  const loaded = await new LeagueSheetsService(gateway, { adminSpreadsheetId: 'admin', publicSpreadsheetId: 'public' }).load(members, 'fa');
  // Only the Svartalfheim team blocks of this minimal fixture are not filled in; every Niflheim and free-agent rule passes.
  assert.deepEqual(auditLeagueRoster(loaded.snapshot).filter(issue => !/^Svartalfheim (Something Spicy|The Rat Pack|Little Monsters) public roster/.test(issue)), []);
});

test('the import script reads Discord with GET only and only asks for Sheets write access with --write', () => {
  const source = readFileSync(new URL('../../scripts/import-league-division.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /new Client\(|\.login\(|GatewayIntentBits/);
  assert.doesNotMatch(source, /rest\.(post|put|patch|delete)\(/);
  assert.match(source, /write \? 'https:\/\/www\.googleapis\.com\/auth\/spreadsheets' : 'https:\/\/www\.googleapis\.com\/auth\/spreadsheets\.readonly'/);
  assert.match(source, /arg\('expect-plan'\) !== plan\.hash/);
  // The post-write check fails on new blocking problems, not only on leftover writes.
  assert.match(source, /if \(leftover \|\| after\.plan\.blocked\) \{\s*process\.exitCode = 1;/);
});

test('duplicate existing Niflheim rows for one player block the import', () => {
  const src = sources();
  const row = ['Niflheim', 'Something Spicy', 'spicy-nd', 'Something Spicy ND', '111111111111111111', 'TimmyTurntHer', 'Player', 'OK', '', ''];
  src.admin.rosters.push(row, [...row]);
  assert.ok(planDivisionImport(src).findings.some(finding => finding.id === 'duplicate-row:111111111111111111' && finding.blocking));
});

test('a filled-in roster tab is linked by draft and known names, rewritten as league names and put in draft order', () => {
  const src = sources();
  // The draft and the tab call TimmyTurntHer "TimTurns", a name Rat only knows from the Member Directory.
  src.admin.memberDirectory = [['111111111111111111', 'timmy', 'TimTurns', '']];
  src.public.draft![5]![2] = 'TimTurns';
  // Hand-filled out of order: the pick sits in the captain row and the captain below it.
  src.public.divisionRoster[4]![10] = 'TimTurns';
  src.public.divisionRoster[5]![10] = 'qronch';
  // The Rat Pack captain is on the tab under his draft name.
  src.public.divisionRoster[15]![2] = 'Deadeyeee';
  const plan = planDivisionImport(src);
  assert.deepEqual(plan.findings.filter(finding => finding.blocking), []);
  assert.deepEqual(plan.publicUpdates.filter(update => update.range.startsWith("'Niflheim Roster'")).map(update => `${update.range}=${update.values[0]![0]}`), [
    "'Niflheim Roster'!K5=Qronch", "'Niflheim Roster'!K6=TimmyTurntHer", "'Niflheim Roster'!C16=Deadeye", "'Niflheim Roster'!C17=Thinks"]);
  // Only the name that is not a form of the player's own Discord names is recorded as theirs.
  assert.deepEqual(plan.nameLinks, [{ id: '111111111111111111', name: 'TimmyTurntHer', sheetName: 'TimTurns' }]);
  const alias = plan.adminUpdates.find(update => update.range.startsWith("'Player Name History'!A") && update.values[0]![2] === 'TimTurns');
  assert.deepEqual(alias?.values[0]!.slice(0, 7), ['111111111111111111', 'TimmyTurntHer', 'TimTurns', 'Previous / Alternate', 'Svartalfheim', '', 'Free Agent']);
  assert.match(renderImportPlan(plan, false), /"TimTurns" is TimmyTurntHer \(111111111111111111\); the tab will show TimmyTurntHer/);
  const again = planDivisionImport(applyUpdates(src, plan));
  assert.deepEqual([again.adminUpdates, again.publicUpdates, again.blocked], [[], [], false]);
});
