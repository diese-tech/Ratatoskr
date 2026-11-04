// #197 parity: making divisions data-driven must not change behavior for the three
// existing divisions. The golden file was generated from main before the change
// (WRITE_GOLDEN=1 writes it); this test compares the same outputs afterwards.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { auditLeagueRoster, buildDropPlan, buildPickupPlan, buildRenamePlan, buildTradePlan } from '../domain/leagueOperations.js';
import { humanizeLeagueAuditIssues } from './leagueAuditPresentation.js';
import { LeagueSheetsService, type LeagueSheetsGateway, type SheetValueUpdate } from './leagueSheets.js';
import { leagueTransactionPlanFingerprint } from './leagueTransactions.js';

type Rows = (string | number | boolean | null)[][];
process.env.ROLE_ALLFATHER_ID ??= 'allfather-test-role';
process.env.ROLE_AESIR_ID ??= 'aesir-test-role';
const { buildRosterPlayerAutocompleteChoices } = await import('../commands/transaction.js');
const golden = new URL('./leagueDivisionsParity.golden.json', import.meta.url);

function grid(cells: Array<[number, number, string]>): Rows {
  const rows: Rows = Array.from({ length: 99 }, () => Array(15).fill(''));
  for (const [row, column, name] of cells) rows[row - 1]![column] = name;
  return rows;
}

function fixture() {
  const data = new Map<string, Rows>();
  const appends: Rows[] = [];
  const gateway: LeagueSheetsGateway = {
    async getValues(spreadsheetId, range) { return structuredClone(data.get(`${spreadsheetId}:${range}`) ?? []); },
    async batchUpdate(_id: string, _updates: SheetValueUpdate[]) {},
    async append(_id, _range, values) { appends.push(values); },
    async getSelfDropPresentation() { return { sheetId: 1, legend: [], ruleExists: false }; },
    async ensureSelfDropPresentation() {},
    async ensureDraftPickHighlights() {},
    async getWorkbookProperties() { return { title: 'Admin', sheets: [{ title: 'League Teams', sheetId: 0 }] }; },
  };
  const team = (division: string, franchise: string, suffix: string, role: string) =>
    [`${division}|${franchise}`, franchise, division, role, `${franchise} ${suffix}`, '', '', `div-${division}`, division, '', '', 'Yes'];
  data.set("admin:'League Teams'!A5:L100", [['header'],
    team('Vanaheim', 'Dream Walkers', 'VD', 'v-dw'), team('Vanaheim', 'The Sewer', 'VD', 'v-ts'),
    team('Alfheim', 'Dream Walkers', 'AD', 'a-dw'), team('Alfheim', 'The Sewer', 'AD', 'a-ts'),
    team('Svartalfheim', 'Dream Walkers', 'SD', 's-dw'), team('Svartalfheim', 'The Sewer', 'SD', 's-ts')]);
  const roster = (division: string, franchise: string, suffix: string, role: string, id: string, player: string, status = 'Player') =>
    [division, franchise, role, `${franchise} ${suffix}`, id, player, status, '', '', ''];
  data.set("admin:'Current Rosters'!A5:J", [['header'],
    roster('Vanaheim', 'Dream Walkers', 'VD', 'v-dw', 'v1', 'Vee One', 'Captain'),
    roster('Vanaheim', 'The Sewer', 'VD', 'v-ts', 'v2', 'Vee Two'),
    roster('Alfheim', 'Dream Walkers', 'AD', 'a-dw', 'a1', 'Alf One'),
    roster('Svartalfheim', 'The Sewer', 'SD', 's-ts', 's1', 'Svart One')]);
  const name = (id: string, player: string, division: string, franchise: string, status: string) =>
    [id, player, player, 'Current Discord Name', division, franchise, status, '', '', '', ''];
  data.set("admin:'Player Name History'!A5:K", [['header'],
    name('v1', 'Vee One', 'Vanaheim', 'Dream Walkers', 'Captain'), name('v2', 'Vee Two', 'Vanaheim', 'The Sewer', 'Player'),
    name('a1', 'Alf One', 'Alfheim', 'Dream Walkers', 'Player'), name('s1', 'Svart One', 'Svartalfheim', 'The Sewer', 'Player'),
    name('vf', 'Vee Free', 'Vanaheim', '', 'Free Agent'), name('af', 'Alf Free', 'Alfheim', '', 'Free Agent'),
    name('sf', 'Svart Free', 'Svartalfheim', '', 'Free Agent')]);
  // Drift: Alfheim free-agent list is missing Alf Free; Svartalfheim Dream Walkers lists a stray name.
  data.set("public:'Vanaheim Roster'!A1:O99", grid([[5, 2, 'Vee One'], [16, 6, 'Vee Two'], [25, 6, 'Vee Free']]));
  data.set("public:'Alfheim Roster'!A1:O99", grid([[5, 2, 'Alf One']]));
  data.set("public:'Svartalfheim Roster'!A1:O99", grid([[5, 2, 'Stray'], [16, 6, 'Svart One'], [25, 10, 'Svart Free']]));
  const members = [
    { discordId: 'v1', displayName: 'Vee One', roleIds: ['v-dw', 'div-Vanaheim'] },
    { discordId: 'v2', displayName: 'Vee Two', roleIds: ['v-ts', 'div-Vanaheim', 'fa'] },
    { discordId: 'a1', displayName: 'Alf One', roleIds: ['a-dw'] },
    { discordId: 's1', displayName: 'Svart One', roleIds: ['s-ts', 'div-Svartalfheim'] },
    { discordId: 'vf', displayName: 'Vee Free', roleIds: ['fa', 'div-Vanaheim'] },
    { discordId: 'af', displayName: 'Alf Free', roleIds: ['fa', 'div-Alfheim'] },
    { discordId: 'sf', displayName: 'Svart Free', roleIds: ['fa', 'div-Svartalfheim'] },
  ];
  return { appends, members, service: new LeagueSheetsService(gateway, { adminSpreadsheetId: 'admin', publicSpreadsheetId: 'public' }) };
}

test('three-division outputs are identical to main before #197', async () => {
  const f = fixture();
  const loaded = await f.service.load(f.members, 'fa');
  const issues = auditLeagueRoster(loaded.snapshot);
  const plans = {
    trade: buildTradePlan(loaded.snapshot, 'v1', 'v2'),
    drop: buildDropPlan(loaded.snapshot, 's1'),
    pickup: buildPickupPlan(loaded.snapshot, 'sf', 's-dw'),
    rename: buildRenamePlan(loaded.snapshot, 'vf', 'Vee Free Renamed'),
  };
  const record = { reference: 'YSL-TRX-PARITY', effectiveDate: '2026-11-04', processedById: 'admin', processedBy: 'Admin' };
  for (const plan of Object.values(plans)) await f.service.appendTransactionHistory(plan, record);
  const actual = JSON.parse(JSON.stringify({
    publicRosters: loaded.snapshot.publicRosters,
    sourceDivisions: Object.keys(loaded.sources.publicByDivision),
    issues,
    humanized: humanizeLeagueAuditIssues(loaded.snapshot, issues),
    fingerprints: Object.fromEntries(Object.entries(plans).map(([kind, plan]) => [kind, leagueTransactionPlanFingerprint(plan)])),
    publicUpdates: Object.fromEntries(Object.entries(plans).map(([kind, plan]) => [kind, f.service.prepare(loaded, plan).publicUpdates])),
    history: f.appends,
    autocomplete: buildRosterPlayerAutocompleteChoices(loaded.snapshot.rosters, ''),
  }));
  if (process.env.WRITE_GOLDEN) writeFileSync(golden, `${JSON.stringify(actual, null, 2)}\n`);
  assert.deepEqual(actual, JSON.parse(readFileSync(golden, 'utf8')));
});
