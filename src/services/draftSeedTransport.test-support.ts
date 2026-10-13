// Preload for real seed-script tests: intercept the Google transport, never use credentials/network.
import { GoogleAuth } from 'google-auth-library';
import { DRAFT_DIVISIONS, DRAFT_PICK_HEADERS } from './draftPicks.js';
type Rows = (string | number | boolean | null)[][];
const data = new Map<string, Rows>();
const directory: Rows = [], names: Rows = [], rosters: Rows = [], picks: Rows = [];
for (const division of DRAFT_DIVISIONS) {
  const grid: Rows = Array.from({ length: 20 }, () => Array(15).fill(''));
  for (let team = 0; team < 8; team += 1) {
    const row = team < 4 ? 0 : 10, col = team % 4 * 4;
    grid[row]![col] = `Team ${team}`;
    grid[row + 2]![col] = 'Cap:';
    for (let round = 1; round <= 4; round += 1) {
      const name = `${division} ${team} ${round}`, id = `fixture-${division}-${team}-${round}`;
      grid[row + 2 + round]![col] = team * 4 + round;
      grid[row + 2 + round]![col + 1] = name;
      directory.push([id, id, name, name]); names.push([id, name, name]);
      rosters.push([division, `Team ${team}`, 'role', `Team ${team}`, id, name]);
      picks.push([division, `Team ${team}`, round, team * 4 + round, name, id, name, 'Player Name History', 'On drafted team', '']);
    }
  }
  data.set(`public:'${division} Draft'!A1:O60`, grid);
}
data.set('public:FinalizedVetting!A2:D', []);
data.set("admin:'Member Directory'!A6:D", directory);
data.set("admin:'Player Name History'!A6:C", names);
data.set("admin:'Current Rosters'!A6:F", rosters);
data.set("admin:'Transaction History'!A6:M", [['fixture-history', 'trade', '2026-09-02', 'Vanaheim', 'Team 0', 'Team 1', picks[0]![5], picks[0]![6]]]);
if (process.env.TEST_SEED_UNRESOLVED === 'yes') {
  directory.shift(); names.shift();
  picks[0]![5] = ''; picks[0]![6] = ''; picks[0]![7] = 'UNRESOLVED'; picks[0]![8] = 'Unknown';
  data.get("admin:'Transaction History'!A6:M")![0]![12] = 'Not verified: Draft Picks incomplete';
}
const existing = process.env.TEST_SEED_EXISTING === 'yes';
data.set("admin:'Draft Picks'!A6:J", picks);
data.set("admin:'Draft Picks'!A5:J5", [DRAFT_PICK_HEADERS]);
data.set("admin:'Draft Picks'!B4", [['2026-09-01']]);
const trace = { posts: 0, adminOnly: true, picksWritten: 0, clearedAfterWrite: true,
  historyLabel: String(data.get("admin:'Transaction History'!A6:M")![0]![12] ?? '') };
process.on('exit', () => console.log(`TEST_SEED_TRACE ${JSON.stringify(trace)}`));
GoogleAuth.prototype.getClient = (async () => ({ request: async (options: { url: string; method: string; data?: any }) => {
  const url = new URL(options.url);
  const workbook = url.pathname.includes('/admin') ? 'admin' : 'public';
  if (options.method === 'POST') {
    trace.posts += 1;
    trace.adminOnly &&= workbook === 'admin';
    if (url.pathname.endsWith('/values:batchUpdate')) {
      const rows = options.data.data.find((entry: { range: string }) => entry.range.startsWith("'Draft Picks'!A6:J"));
      trace.picksWritten = rows?.values.length ?? 0;
      const mark = options.data.data.find((entry: { range: string }) => entry.range === "'Transaction History'!M6");
      if (mark) trace.historyLabel = String(mark.values[0][0]);
    }
    if (url.pathname.endsWith('/values:batchClear')) trace.clearedAfterWrite &&= trace.picksWritten === 96;
    return { data: {} };
  }
  if (url.pathname.endsWith('/values:batchGet')) {
    return { data: { valueRanges: url.searchParams.getAll('ranges').map(range => ({ values: data.get(`${workbook}:${range}`) ?? [] })) } };
  }
  const titles = workbook === 'admin' ? ['Member Directory', 'League Teams', 'Player Name History', 'Current Rosters', 'Transaction History',
    ...(existing || trace.posts ? ['Draft Picks'] : [])] : ['FinalizedVetting', ...DRAFT_DIVISIONS.map(division => `${division} Draft`)];
  return { data: { sheets: titles.map((title, sheetId) => ({ properties: { title, sheetId } })) } };
} })) as unknown as typeof GoogleAuth.prototype.getClient;
