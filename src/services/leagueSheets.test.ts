import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTradePlan } from '../domain/leagueOperations.js';
import { LeagueSheetsService, type LeagueSheetsGateway, type SheetValueUpdate } from './leagueSheets.js';

type Rows = (string | number | boolean | null)[][];

function emptyPublic(): Rows { return Array.from({ length: 99 }, () => Array(15).fill('')); }

class FakeGateway implements LeagueSheetsGateway {
  readonly data = new Map<string, Rows>();
  readonly writes: { spreadsheetId: string; updates: SheetValueUpdate[] }[] = [];
  changed = false;

  key(spreadsheetId: string, range: string) { return `${spreadsheetId}:${range}`; }
  async getValues(spreadsheetId: string, range: string): Promise<Rows> {
    const rows = structuredClone(this.data.get(this.key(spreadsheetId, range)) ?? []);
    if (this.changed && range.includes('Current Rosters')) rows[1]![5] = 'Manual edit';
    return rows;
  }
  async batchUpdate(spreadsheetId: string, updates: SheetValueUpdate[], option: 'RAW' | 'USER_ENTERED' = 'RAW') {
    this.writes.push({ spreadsheetId, updates });
    for (const update of updates) {
      if (update.range.startsWith("'Current Rosters'!A6:")) {
        const key = this.key(spreadsheetId, "'Current Rosters'!A5:J1000");
        const header = this.data.get(key)![0]!;
        const evaluate = (cell: string | number | boolean | null) => option === 'USER_ENTERED' && typeof cell === 'string' && /^=\".*\"$/.test(cell)
          ? cell.slice(2, -1) : cell;
        this.data.set(key, [header, ...update.values.map((row) => row.map(evaluate))]);
      } else {
        const publicMatch = /^'([^']+) Roster'!([A-O])(\d+)$/.exec(update.range);
        if (publicMatch) {
          const key = this.key(spreadsheetId, `'${publicMatch[1]} Roster'!A1:O99`);
          const rows = this.data.get(key)!;
          rows[Number(publicMatch[3]) - 1]![publicMatch[2]!.charCodeAt(0) - 65] = update.values[0]![0]!;
        }
        const nameMatch = /^'Player Name History'!([BE])(\d+)(?::G\d+)?$/.exec(update.range);
        if (nameMatch) {
          const key = this.key(spreadsheetId, "'Player Name History'!A5:K1000");
          const rows = this.data.get(key)!;
          const row = rows[Number(nameMatch[2]) - 5]!;
          const start = nameMatch[1]!.charCodeAt(0) - 65;
          update.values[0]!.forEach((cell, index) => { row[start + index] = cell; });
        }
      }
    }
  }
  async append() {}
}

function serviceFixture() {
  const gateway = new FakeGateway();
  const teams: Rows = [
    ['Team Key', 'Franchise', 'Division', 'Team Role ID', 'Team Role', 'Franchise Role ID', 'Franchise Role', 'Division Role ID', 'Division Role', 'Captain Role ID', 'Captain Role', 'Active Team'],
    ['Vanaheim|Dream Walkers', 'Dream Walkers', 'Vanaheim', 'team-a', 'Dream Walkers VD', '', '', 'division-v', 'Vanaheim', '', '', 'Yes'],
    ['Vanaheim|The Sewer', 'The Sewer', 'Vanaheim', 'team-b', 'The Sewer VD', '', '', 'division-v', 'Vanaheim', '', '', 'Yes'],
  ];
  const rosters: Rows = [
    ['Division', 'Franchise', 'Team Role ID', 'Team', 'Discord ID', 'Player', 'Roster Status', 'Check', 'Source', 'Last Updated'],
    ['Vanaheim', 'Dream Walkers', 'team-a', 'Dream Walkers VD', 'one', 'OneLive', 'Captain', 'OK', 'audit', 'now'],
    ['Vanaheim', 'The Sewer', 'team-b', 'The Sewer VD', 'two', 'TwoLive', 'Player', 'OK', 'audit', 'now'],
  ];
  const names: Rows = [
    ['Discord ID', 'Current League Name', 'Known Name', 'Name Status', 'Division', 'Franchise', 'League Status', 'Recorded On', 'Last Confirmed', 'Found In', 'Notes'],
    ['one', 'One', 'OneLive', 'Current Discord Name', 'Vanaheim', 'Dream Walkers', 'Captain', '', '', '', ''],
    ['two', 'Two', 'TwoLive', 'Current Discord Name', 'Vanaheim', 'The Sewer', 'Player', '', '', '', ''],
  ];
  gateway.data.set(gateway.key('admin', "'League Teams'!A5:L100"), teams);
  gateway.data.set(gateway.key('admin', "'Current Rosters'!A5:J1000"), rosters);
  gateway.data.set(gateway.key('admin', "'Player Name History'!A5:K1000"), names);
  for (const division of ['Vanaheim', 'Alfheim', 'Svartalfheim']) {
    const rows = emptyPublic();
    if (division === 'Vanaheim') { rows[4]![2] = 'One'; rows[15]![6] = 'Two'; }
    gateway.data.set(gateway.key('public', `'${division} Roster'!A1:O99`), rows);
  }
  return { gateway, service: new LeagueSheetsService(gateway, { adminSpreadsheetId: 'admin', publicSpreadsheetId: 'public' }) };
}

const members = [
  { discordId: 'one', displayName: 'OneLive', roleIds: ['team-a', 'division-v'] },
  { discordId: 'two', displayName: 'TwoLive', roleIds: ['team-b', 'division-v'] },
];

test('league sheet reader maps only the configured managed tabs and cells', async () => {
  const { service } = serviceFixture();
  const loaded = await service.load(members, 'free-agent');
  assert.equal(loaded.snapshot.teams.length, 2);
  assert.equal(loaded.snapshot.rosters[0]?.discordId, 'one');
  assert.deepEqual(loaded.snapshot.publicRosters.Vanaheim?.teams['Dream Walkers'], ['One']);
  assert.deepEqual(loaded.snapshot.publicRosters.Vanaheim?.freeAgents, []);
});

test('sheet preflight aborts before all writes when any audited value drifted', async () => {
  const { gateway, service } = serviceFixture();
  const loaded = await service.load(members, 'free-agent');
  gateway.changed = true;
  await assert.rejects(() => service.apply(loaded, buildTradePlan(loaded.snapshot, 'one', 'two'), {
    reference: 'YSL-TRX-1', effectiveDate: '2026-09-30', processedById: 'admin', processedBy: 'Admin',
  }), /changed after the audit/i);
  assert.equal(gateway.writes.length, 0);
});

test('trade writes the sorted admin roster and only the two exact public player cells', async () => {
  const { gateway, service } = serviceFixture();
  const loaded = await service.load(members, 'free-agent');
  await service.apply(loaded, buildTradePlan(loaded.snapshot, 'one', 'two'), {
    reference: 'YSL-TRX-1', effectiveDate: '2026-09-30', processedById: 'admin', processedBy: 'Admin',
  });
  const publicRanges = gateway.writes.filter((write) => write.spreadsheetId === 'public')
    .flatMap((write) => write.updates.map((update) => update.range));
  assert.deepEqual(publicRanges, ["'Vanaheim Roster'!C5", "'Vanaheim Roster'!G16"]);
  const reloaded = await service.load([
    { discordId: 'one', displayName: 'OneLive', roleIds: ['team-b', 'division-v'] },
    { discordId: 'two', displayName: 'TwoLive', roleIds: ['team-a', 'division-v'] },
  ], 'free-agent');
  assert.equal(reloaded.snapshot.rosters.find((row) => row.discordId === 'one')?.teamRoleId, 'team-b');
});
