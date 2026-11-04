import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import {
  describeInspectionFailure, divisionTeamSuffix, InspectionSetupError, inspectDivision, parseDraftTeams, readDivisionDiscordState, renderInspectionReport,
  type DiscordDivisionState, type InspectedMember, type Rows, type SheetDivisionState,
} from './divisionInspection.js';

const role = (id: string, name: string, position: number, permissions = '0') => ({ id, name, position, permissions });
const member = (id: string, name: string, roles: string[], extra: Partial<InspectedMember['user']> = {}, nick: string | null = null): InspectedMember =>
  ({ user: { id, username: name.toLowerCase(), global_name: name, ...extra }, nick, roles });

function fixture(): { discord: DiscordDivisionState; sheets: SheetDivisionState } {
  const roles = [
    role('admin', 'Allfather', 60), role('bot', 'Ratatoskr', 50), role('nifl', 'Niflheim', 10, '1024'),
    role('spicy-nd', 'Something Spicy ND', 9), role('rat-nd', 'The Rat Pack ND', 8), role('lm-nd', 'Little Monsters ND', 7),
    role('old-nd', 'Old Franchise ND', 6), role('fa', 'Free Agent', 5), role('svarta', 'Svartalfheim', 4),
    role('cap', 'Captain', 3), role('niflcap', 'Niflheim Captain', 2), role('lm-sd', 'Little Monsters SD', 1),
  ];
  const members = [
    member('timmy', 'TimmyTurntHer', ['spicy-nd', 'fa', 'svarta', 'nifl']),
    member('qronch', 'Qronch', ['spicy-nd', 'lm-sd', 'svarta', 'nifl', 'cap', 'niflcap']),
    member('deadeye', 'Deadeye', ['rat-nd', 'nifl'], { username: 'deadeyeee_' }),
    member('thinks', 'Thinks', ['rat-nd', 'nifl', 'fa', 'svarta']),
    member('twoteams', 'Twoteams', ['spicy-nd', 'rat-nd', 'nifl', 'fa', 'svarta']),
    member('lonely', 'Lonely', ['nifl', 'fa', 'svarta']),
    member('twin1', 'TwinA', ['fa'], {}, 'Twin'), member('twin2', 'TwinB', ['fa'], {}, 'Twin'),
    member('rat', 'Ratatoskr', ['bot'], { bot: true }),
  ];
  const channels = [
    { id: 'cat', name: 'Niflheim', type: 4 },
    { id: 'general', name: 'niflheim-general', type: 0, parent_id: 'cat', permission_overwrites: [{ id: 'nifl', type: 0, allow: '1024', deny: '0' }] },
    { id: 'other', name: 'vanaheim-general', type: 0, parent_id: null },
  ];
  const teams: Rows = ['Something Spicy', 'The Rat Pack', 'Little Monsters', 'Dream Walkers'].map(franchise => [
    `Svartalfheim|${franchise}`, franchise, 'Svartalfheim', `${franchise}-sd`, `${franchise} SD`, `${franchise}-franchise`, franchise,
    'svarta', 'Svartalfheim', 'svarta-cap', 'Svartalfheim Captain', 'Yes']);
  teams[2]![3] = 'lm-sd';
  const names: Rows = [
    ['timmy', 'TimmyTurntHer', 'TimmyTurntHer', 'Current Discord Name', 'Svartalfheim', '', 'Free Agent'],
    ['qronch', 'Qronch', 'Qronch', 'Current Discord Name', 'Svartalfheim', 'Little Monsters', 'Player'],
    ['thinks', 'Thinks', 'Thinks', 'Current Discord Name', 'Svartalfheim', '', 'Inactive'],
    ['twoteams', 'Twoteams', 'Twoteams', 'Current Discord Name', 'Svartalfheim', '', 'Free Agent'],
    ['lonely', 'Lonely', 'Lonely', 'Current Discord Name', 'Svartalfheim', '', 'Free Agent'],
  ];
  const rosters: Rows = [['Svartalfheim', 'Little Monsters', 'lm-sd', 'Little Monsters SD', 'qronch', 'Qronch', 'Player']];
  const grid: Rows = Array.from({ length: 30 }, () => Array<string>(15).fill(''));
  const block = (top: number, column: number, team: string, captain: string, picks: string[]) => {
    grid[top]![column] = team; grid[top + 2]![column] = 'Cap:'; grid[top + 2]![column + 1] = captain;
    picks.forEach((pick, index) => { grid[top + 3 + index]![column] = String(index + 1); grid[top + 3 + index]![column + 1] = pick; });
  };
  block(2, 1, 'Something Spicy', 'Qronch', ['TimmyTurntHer', 'Ghost', 'Lonely', 'Twin']);
  block(2, 5, 'The Rat Pack', 'Deadeyeee', ['Thinks']);
  return {
    discord: { roles, members, channels, botRoleIds: ['bot'] },
    sheets: { adminTitles: ['League Teams'], publicTitles: ['Niflheim Draft', 'Roster Default (DNE)'], teams, names, rosters, memberDirectory: [], draft: grid },
  };
}

test('reading Discord uses only GET requests, paginates members and never touches other request methods', async () => {
  const calls: string[] = [];
  const pages = [Array.from({ length: 1000 }, (_, index) => member(`m${index}`, `M${index}`, [])), [member('last', 'Last', [])]];
  const rest = new Proxy({
    get: async (route: string, options?: { query?: URLSearchParams }) => {
      calls.push(`${route}${options?.query ? `?${options.query}` : ''}`);
      if (route.endsWith('/roles')) return [role('r', 'Role', 1)];
      if (route.endsWith('/channels')) return [];
      if (route.endsWith('/members')) return pages.shift();
      if (route === '/users/@me') return { id: 'botuser' };
      return member('botuser', 'Bot', ['r'], { bot: true });
    },
  }, { get(target, property) {
    if (property !== 'get') throw new Error(`Unexpected REST access: ${String(property)}`);
    return target.get;
  } });
  const state = await readDivisionDiscordState(rest, 'guild');
  assert.equal(state.members.length, 1001);
  assert.deepEqual(state.botRoleIds, ['r']);
  assert.deepEqual(calls, ['/guilds/guild/roles', '/guilds/guild/channels', '/guilds/guild/members?limit=1000&after=0',
    '/guilds/guild/members?limit=1000&after=m999', '/users/@me', '/guilds/guild/members/botuser']);
});

test('the inspection script is read-only: no Gateway login, no Discord writes, read-only Sheets scope', () => {
  const source = readFileSync(new URL('../../scripts/inspect-league-division.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /new Client\(|\.login\(|GatewayIntentBits/);
  assert.doesNotMatch(source, /rest\.(post|put|patch|delete)\(|method: '(POST|PUT|PATCH|DELETE)'/);
  assert.match(source, /spreadsheets\.readonly/);
  assert.doesNotMatch(source, /auth\/spreadsheets'/);
});

test('draft tabs parse every team block with its captain and numbered picks', () => {
  const teams = parseDraftTeams(fixture().sheets.draft!);
  assert.deepEqual(teams, [
    { team: 'Something Spicy', captain: 'Qronch', picks: ['TimmyTurntHer', 'Ghost', 'Lonely', 'Twin'] },
    { team: 'The Rat Pack', captain: 'Deadeyeee', picks: ['Thinks'] },
  ]);
  assert.equal(divisionTeamSuffix('Niflheim'), 'ND');
});

test('the inspection reports roles, rosters, layered status, draft matching, captains, channels and the old setting', () => {
  const { discord, sheets } = fixture();
  const report = inspectDivision({ division: 'Niflheim', discord, sheets, legacyNiflheimRoleId: 'nifl' });

  assert.equal(report.divisionRole?.id, 'nifl');
  assert.equal(report.divisionRole?.botCanManage, true);
  assert.deepEqual(report.divisionRole?.permissionNames, ['ViewChannel']);
  assert.equal(report.captainRole?.id, 'niflcap');
  assert.deepEqual(report.teamRoles.map(entry => [entry.franchise, entry.role?.id, entry.holders.map(holder => holder.id)]), [
    ['Dream Walkers', undefined, []],
    ['Little Monsters', 'lm-nd', []],
    ['Something Spicy', 'spicy-nd', ['timmy', 'qronch', 'twoteams']],
    ['The Rat Pack', 'rat-nd', ['deadeye', 'thinks', 'twoteams']],
  ]);
  assert.deepEqual(report.extraTeamRoles.map(entry => entry.name), ['Old Franchise ND']);
  assert.deepEqual(report.multipleTeamRoles.map(entry => entry.id), ['twoteams']);
  assert.deepEqual(report.divisionRoleWithoutTeam.map(entry => entry.id), ['lonely']);

  const byId = new Map(report.layered.map(entry => [entry.discordId, entry]));
  assert.deepEqual(byId.get('timmy')!.problems, [], 'Svartalfheim free agent plus a Niflheim team is the expected layered state');
  assert.deepEqual(byId.get('qronch')!.problems, [], 'A Svartalfheim rostered player plus a Niflheim team is also valid');
  assert.match(byId.get('deadeye')!.ratRecord, /not in Rat/);
  assert.deepEqual(byId.get('deadeye')!.problems, ['No Free Agent role.', 'No Svartalfheim division role.']);
  assert.match(byId.get('thinks')!.problems.join(' '), /Inactive; they would need reactivation/);
  assert.match(byId.get('twoteams')!.problems.join(' '), /Holds 2 Niflheim team roles/);
  assert.deepEqual(report.unknownToRat.map(entry => entry.discordId), ['deadeye']);
  assert.deepEqual(report.inactiveOrSuspended.map(entry => entry.discordId), ['thinks']);

  const outcome = new Map(report.draftResolutions.map(entry => [`${entry.team}:${entry.draftName}`, entry]));
  assert.equal(outcome.get('Something Spicy:Qronch')!.outcome, 'matched');
  assert.equal(outcome.get('Something Spicy:Qronch')!.captain, true);
  assert.equal(outcome.get('Something Spicy:TimmyTurntHer')!.discordId, 'timmy');
  assert.equal(outcome.get('Something Spicy:Ghost')!.outcome, 'unresolved');
  assert.equal(outcome.get('Something Spicy:Lonely')!.outcome, 'other-team');
  assert.equal(outcome.get('Something Spicy:Twin')!.outcome, 'ambiguous');
  assert.equal(outcome.get('The Rat Pack:Deadeyeee')!.discordId, 'deadeye', 'Usernames with trailing underscores still match');
  assert.deepEqual(report.teamRoleHoldersNotDrafted.map(entry => `${entry.id}@${entry.team}`), ['twoteams@Something Spicy', 'twoteams@The Rat Pack']);
  assert.deepEqual(report.captains.map(entry => [entry.team, entry.captainRoleHolders]), [['Something Spicy', ['Qronch']], ['The Rat Pack', []]]);

  assert.deepEqual(report.channels.map(channel => channel.name), ['Niflheim', 'niflheim-general']);
  assert.deepEqual(report.channels[1]!.overwrites, ['Niflheim: allow [ViewChannel] deny [none]']);
  assert.match(report.legacyEnv.conflict ?? '', /division role/);
  assert.equal(report.rosterTabExists, false);
  assert.equal(report.templateTabExists, true);
  assert.equal(report.alreadyConfiguredTeams, 0);
});

test('the rendered report is plain English, states that nothing changed, and flags what needs review', () => {
  const { discord, sheets } = fixture();
  const output = renderInspectionReport(inspectDivision({ division: 'Niflheim', discord, sheets }));
  assert.match(output, /^# Niflheim inspection \(read-only, nothing was changed\)/);
  assert.match(output, /Members not yet in Rat's records: 1/);
  assert.match(output, /Deadeye \(deadeye\) .*REVIEW: No Free Agent role\./);
  assert.match(output, /TimmyTurntHer \(timmy\) .* · OK/);
  assert.match(output, /"Ghost" · unresolved/);
  assert.match(output, /ROLE_NIFLHEIM_FREE_AGENT_ID is not set\./);
  assert.match(output, /Dream Walkers: no "Dream Walkers ND" role found/);
});

test('a missing draft tab and an absent division role are reported, not thrown', () => {
  const { discord, sheets } = fixture();
  const { draft: _draft, ...withoutDraft } = sheets;
  const report = inspectDivision({ division: 'Niflheim', discord: { ...discord, roles: discord.roles.filter(entry => entry.id !== 'nifl') }, sheets: withoutDraft });
  assert.equal(report.divisionRole, undefined);
  assert.equal(report.draftTabFound, false);
  assert.match(renderInspectionReport(report), /No "Niflheim Draft" tab was found\./);
});

test('no bot runtime code imports the inspection module (its member listing is outside the shared coordinator)', () => {
  const root = new URL('../', import.meta.url);
  const offenders: string[] = [];
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, dir));
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && entry.name !== 'divisionInspection.ts'
        && /divisionInspection(\.js)?['"]/.test(readFileSync(new URL(entry.name, dir), 'utf8'))) offenders.push(`${dir.pathname}${entry.name}`);
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});

test('draft headers that use the team role name ("The Rat Pack ND") resolve to their franchise', () => {
  const { discord, sheets } = fixture();
  const draft = sheets.draft!.map(row => row.map(cell => cell === 'The Rat Pack' ? 'The Rat Pack ND' : cell));
  const report = inspectDivision({ division: 'Niflheim', discord, sheets: { ...sheets, draft } });
  assert.deepEqual(report.draftTeams.map(team => team.team), ['Something Spicy', 'The Rat Pack']);
  const ratPack = report.draftResolutions.filter(entry => entry.team === 'The Rat Pack');
  assert.deepEqual(ratPack.map(entry => [entry.draftName, entry.outcome]), [['Deadeyeee', 'matched'], ['Thinks', 'matched']]);
  assert.equal(report.captains.find(entry => entry.team === 'The Rat Pack')!.draftCaptain, 'Deadeyeee');
});

test('failures are worded for staff, with technical detail kept on a separate maintainer line', () => {
  const discord = (status: number) => Object.assign(new Error('raw discord text'), { name: 'DiscordAPIError[50001]', status, url: 'https://discord.com/api/v10/guilds/1/members' });
  const google = (status: number) => Object.assign(new Error('raw google text'), { name: 'GaxiosError', response: { status }, config: { url: 'https://sheets.googleapis.com/v4/spreadsheets/x' } });
  const cases: Array<[unknown, RegExp]> = [
    [new InspectionSetupError('Pass the division name, for example --division=Niflheim.'), /^Pass the division name/],
    [discord(401), /rejected the bot login.*DISCORD_TOKEN/],
    [discord(403), /Server Members Intent/],
    [discord(404), /DISCORD_GUILD_ID/],
    [google(403), /service account can view both/],
    [google(404), /YSL_ADMIN_SPREADSHEET_ID and YSL_PUBLIC_SPREADSHEET_ID/],
    [discord(429), /Discord asked Rat to slow down/],
    [Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), /could not reach Discord or Google/],
    [new TypeError('boom'), /unexpected problem\. Share the details below/],
  ];
  for (const [error, expected] of cases) {
    const described = describeInspectionFailure(error);
    assert.match(described.message, expected);
    assert.doesNotMatch(described.message, /raw (discord|google) text|getaddrinfo|boom|DiscordAPIError|Gaxios/);
  }
  assert.equal(describeInspectionFailure(new InspectionSetupError('x')).detail, undefined);
  assert.equal(describeInspectionFailure(discord(403)).detail, 'DiscordAPIError[50001]: raw discord text');
});
