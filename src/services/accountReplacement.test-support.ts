import type { AccountReplacementMember, AccountReplacementRoleChange } from '../domain/leagueAccountReplacement.js';
import { LeagueSheetsService, type LeagueSheetsGateway, type SheetValueUpdate } from './leagueSheets.js';
import { DRAFT_PICK_HEADERS } from './draftPicks.js';

type Rows = (string | number | boolean | null)[][];
const column = (letters: string) => [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
function address(range: string) {
  const match = /^'([^']+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d+)?)?$/.exec(range);
  if (!match) throw Error(`Unsupported fixture range ${range}`);
  return { tab: match[1]!, row: Number(match[3]) - 1, column: column(match[2]!),
    endColumn: column(match[4] ?? match[2]!), endRow: match[4] ? (match[5] ? Number(match[5]) : Infinity) : Number(match[3]) };
}

export class ReplacementTestGateway implements LeagueSheetsGateway {
  async ensureDraftPickHighlights() {}
  async getWorkbookProperties() {
    return { title: 'Admin', sheets: ['League Teams', 'Current Rosters', 'Player Name History', 'Transaction History',
      ...(this.missingDraftPicks ? [] : ['Draft Picks'])].map((title, sheetId) => ({ title, sheetId })) };
  }
  data = new Map<string, Rows>();
  writes: Array<{ workbook: string; updates: SheetValueUpdate[] }> = [];
  appends = 0;
  missingDraftPicks = false;
  failWorkbook?: string;
  beforeRead?: (workbook: string, range: string) => void;
  rows(workbook: string, tab: string) { return this.data.get(`${workbook}:${tab}`)!; }
  async getValues(workbook: string, range: string): Promise<Rows> {
    this.beforeRead?.(workbook, range);
    const a = address(range);
    if (a.tab === 'Draft Picks' && this.missingDraftPicks) throw Object.assign(Error('Unable to parse range: Draft Picks'), { status: 400 });
    const grid = this.rows(workbook, a.tab) ?? [];
    const rows = grid.slice(a.row, a.endRow).map((row) => row.slice(a.column, a.endColumn + 1));
    while (rows.length && rows.at(-1)!.every((cell) => cell === '' || cell === null)) rows.pop();
    return structuredClone(rows);
  }
  async batchUpdate(workbook: string, updates: SheetValueUpdate[]) {
    this.writes.push({ workbook, updates: structuredClone(updates) });
    for (const update of updates) {
      const a = address(update.range);
      const grid = this.rows(workbook, a.tab);
      for (const [offset, values] of update.values.entries()) {
        while (grid.length <= a.row + offset) grid.push([]);
        values.forEach((value, index) => { grid[a.row + offset]![a.column + index] = value; });
      }
    }
    if (workbook === this.failWorkbook) throw Error('write committed but response lost');
  }
  async append(_workbook: string, _range: string, _values: Rows) { this.appends++; throw Error('Account replacement must not append transaction history'); }
  async getSelfDropPresentation() { return { sheetId: 1, legend: [], ruleExists: false }; }
  async ensureSelfDropPresentation() { throw Error('Unrelated presentation write'); }
}

export function accountReplacementSources() {
  const gateway = new ReplacementTestGateway();
  const header = (rows: Rows) => [[], [], [], [], [], ...rows];
  gateway.data.set('admin:League Teams', [[], [], [], [],
    ['Team Key', 'Franchise', 'Division', 'Team Role ID', 'Team Role', '', '', 'Division Role ID'],
    ['a', 'Dream Walkers', 'Vanaheim', 'a', 'Dream Walkers VD', '', '', 'division', '', 'captain-access', '', 'Yes'],
    ['b', 'The Sewer', 'Vanaheim', 'b', 'The Sewer VD', '', '', 'division', '', '', '', 'Yes']]);
  gateway.data.set('admin:Current Rosters', [[], [], [], [], ['header'],
    ['Vanaheim', 'Dream Walkers', 'a', 'Dream Walkers VD', 'one', 'One', 'Captain', 'Keep check', 'Keep source', 'Keep timestamp'],
    ['Vanaheim', 'The Sewer', 'b', 'The Sewer VD', 'two', 'Two', 'Player']]);
  gateway.data.set('admin:Player Name History', [[], [], [], [], ['header'],
    ['one', 'One', 'One alias', 'Current Discord Name', 'Vanaheim', 'Dream Walkers', 'Captain', 'Original date', 'Confirmed date', 'Original source', 'Keep notes'],
    ['one', 'One', 'Older alias', 'Previous / Alternate', 'Vanaheim', 'Dream Walkers', 'Captain', 'Earlier date'],
    ['two', 'Two', 'Two', 'Current Discord Name', 'Vanaheim', 'The Sewer', 'Player']]);
  gateway.data.set('admin:Draft Picks', header([
    ['Vanaheim', 'Dream Walkers', 1, 1, 'One draft alias', 'one', 'One', 'Manual', 'Moved · trade · legacy', 'one'],
  ]));
  gateway.rows('admin', 'Draft Picks')[4] = [...DRAFT_PICK_HEADERS];
  gateway.data.set('admin:Transaction History', header([['legacy', 'trade', '2026-10-01', 'Vanaheim', 'The Sewer', 'Dream Walkers', 'one', 'One']]));
  for (const division of ['Vanaheim', 'Alfheim', 'Svartalfheim']) {
    const grid: Rows = Array.from({ length: 99 }, () => Array(15).fill(''));
    if (division === 'Vanaheim') { grid[4]![2] = 'One'; grid[15]![6] = 'Two'; }
    gateway.data.set(`public:${division} Roster`, grid);
  }
  const members = new Map<string, AccountReplacementMember>([
    ['new', { guildId: 'g', bot: false, discordId: 'new', displayName: 'One', roleIds: ['a', 'division', 'unmanaged'] }],
    ['two', { guildId: 'g', bot: false, discordId: 'two', displayName: 'Two', roleIds: ['b', 'division'] }],
  ]);
  let roleWrites = 0;
  const discord = {
    getAccountReplacementMembers: async () => structuredClone([...members.values()].filter((member) => !member.bot)),
    getAccountReplacementMember: async (id: string) => structuredClone(members.get(id) ?? null),
    assertAccountReplacementRoleOwnership: async () => {},
    reconcileAccountReplacementRoles: async (change: AccountReplacementRoleChange) => {
      const member = members.get(change.discordId)!;
      const before = member.roleIds.filter((id) => change.managedRoleIds.includes(id)).sort();
      if (JSON.stringify(before) !== JSON.stringify(change.before)) throw Error('managed roles drifted');
      if (change.add.length || change.remove.length) roleWrites++;
      member.roleIds = member.roleIds.filter((id) => !change.managedRoleIds.includes(id)).concat(change.after);
    },
  };
  return { gateway, members, discord,
    sheets: new LeagueSheetsService(gateway, { adminSpreadsheetId: 'admin', publicSpreadsheetId: 'public' }),
    get roleWrites() { return roleWrites; } };
}
