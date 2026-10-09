// Seeds the Admin 'Draft Picks' tab (each captain's first four draft picks, resolved to Discord IDs)
// and backfills Transaction History column M for moves made before tracking existed.
// Dry run by default; pass --write to apply. Re-running keeps staff-entered IDs.
//   railway run npx tsx scripts/seed-draft-picks.ts [--write] [--since=YYYY-MM-DD] [--allow-partial]
// --since: only backfill history on/after the draft (use when history predates this season's draft).
// --allow-partial: write even if fewer than 3 divisions x 8 teams x 4 picks were parsed.
import 'dotenv/config';
import { GoogleAuth } from 'google-auth-library';
import {
  DRAFT_DIVISIONS, DRAFT_PICK_HEADERS, draftPickRow, parseDraftTab, resolveDraftPicks,
} from '../src/services/draftPicks.js';
import { draftPickLabel } from '../src/services/leagueSheets.js';

type Rows = (string | number | boolean | null)[][];
type SheetMeta = { properties: { sheetId: number; title: string }; conditionalFormats?: Array<{ booleanRule?: { condition?: { values?: Array<{ userEnteredValue?: string }> } } }> };

const write = process.argv.includes('--write');
const allowPartial = process.argv.includes('--allow-partial');
const since = process.argv.find((arg) => arg.startsWith('--since='))?.slice('--since='.length) ?? '';
const EXPECTED_PICKS = DRAFT_DIVISIONS.length * 8 * 4;
const adminId = process.env.YSL_ADMIN_SPREADSHEET_ID!;
const publicId = process.env.YSL_PUBLIC_SPREADSHEET_ID!;
const auth = new GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '{}'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const base = 'https://sheets.googleapis.com/v4/spreadsheets';
const YELLOW = { red: 1, green: 0.95, blue: 0.6 };
const PICKS_RULE = '=LEFT($I6,5)="Moved"';
const HISTORY_RULE = '=$M6<>""';

async function call<T>(url: string, data?: unknown): Promise<T> {
  const client = await auth.getClient();
  return (await client.request<T>({ url, method: data ? 'POST' : 'GET', ...(data ? { data } : {}), retry: false })).data;
}
async function read(spreadsheetId: string, ranges: string[]): Promise<Rows[]> {
  const query = new URLSearchParams({ valueRenderOption: 'FORMATTED_VALUE' });
  for (const range of ranges) query.append('ranges', range);
  const data = await call<{ valueRanges: Array<{ values?: Rows }> }>(`${base}/${spreadsheetId}/values:batchGet?${query}`);
  return data.valueRanges.map((range) => range.values ?? []);
}
const sheetsMeta = async (spreadsheetId: string) => (await call<{ sheets: SheetMeta[] }>(
  `${base}/${spreadsheetId}?fields=sheets(properties(sheetId,title),conditionalFormats(booleanRule(condition(values(userEnteredValue)))))`,
)).sheets;
const yellowRule = (sheetId: number, endColumnIndex: number, formula: string) => ({
  addConditionalFormatRule: {
    index: 0,
    rule: {
      ranges: [{ sheetId, startRowIndex: 5, startColumnIndex: 0, endColumnIndex }],
      booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: formula }] }, format: { backgroundColorStyle: { rgbColor: YELLOW } } },
    },
  },
});
const hasRule = (sheet: SheetMeta | undefined, formula: string) => (sheet?.conditionalFormats ?? [])
  .some((rule) => rule.booleanRule?.condition?.values?.[0]?.userEnteredValue === formula);

async function main() {
  const [vetting, ...draftTabs] = await read(publicId, ['FinalizedVetting!A2:D', ...DRAFT_DIVISIONS.map((division) => `'${division} Draft'!A1:O60`)]);
  let adminMeta = await sheetsMeta(adminId);
  const picksTabExists = adminMeta.some((sheet) => sheet.properties.title === 'Draft Picks');
  const [memberDirectory, nameHistory, rosters, history, existing] = await read(adminId, [
    "'Member Directory'!A6:D", "'Player Name History'!A6:C", "'Current Rosters'!A6:F", "'Transaction History'!A6:M",
    ...(picksTabExists ? ["'Draft Picks'!A6:I"] : []),
  ]);

  const picks = resolveDraftPicks(
    DRAFT_DIVISIONS.flatMap((division, index) => parseDraftTab(division, draftTabs[index]!)),
    { vetting: vetting!, memberDirectory: memberDirectory!, nameHistory: nameHistory!, rosters: rosters! },
    existing ?? [],
  );
  const byId = new Map(picks.filter((pick) => pick.discordId).map((pick) => [pick.discordId, pick]));
  const historyMarks = history!.flatMap((row, index) => {
    const pick = byId.get(String(row[6] ?? '').trim());
    // Renames are not roster moves (the runtime skips them too).
    return pick && String(row[1] ?? '').trim() !== 'rename' && !String(row[12] ?? '').trim()
      && String(row[2] ?? '').trim() >= since
      ? [{ row: index + 6, reference: String(row[0]), player: String(row[7]), label: draftPickLabel({ ...pick, round: String(pick.round) }) }]
      : [];
  });

  console.log(`Parsed ${picks.length} top-4 picks (expected ${EXPECTED_PICKS}).`);
  const unresolved = picks.filter((pick) => !pick.discordId);
  console.log(`\nUnresolved (${unresolved.length}) — type the Discord ID into column F of Draft Picks, then re-run:`);
  for (const pick of unresolved) console.log(`  ${pick.division} ${pick.team} R${pick.round} (#${pick.pick}): ${pick.draftName}`);
  const moved = picks.filter((pick) => pick.status.startsWith('Moved'));
  console.log(`\nMoved top-4 picks (${moved.length}) — rows that will be yellow:`);
  for (const pick of moved) console.log(`  ${pick.division} ${pick.team} R${pick.round} (#${pick.pick}): ${pick.draftName} → ${pick.status}`);
  console.log(`\nTransaction History rows to mark (${historyMarks.length}):`);
  for (const mark of historyMarks) console.log(`  row ${mark.row} ${mark.reference} ${mark.player}: ${mark.label}`);

  if (!write) { console.log('\nDry run. Re-run with --write to apply.'); return; }
  // A short parse would drop protected picks (and their staff-entered IDs) from the tab.
  if (picks.length !== EXPECTED_PICKS && !allowPartial) {
    throw new Error(`Parsed ${picks.length} picks, expected ${EXPECTED_PICKS}. Check the draft tabs, or pass --allow-partial.`);
  }

  if (!picksTabExists) {
    await call(`${base}/${adminId}:batchUpdate`, { requests: [{ addSheet: { properties: { title: 'Draft Picks' } } }] });
    adminMeta = await sheetsMeta(adminId);
  }
  // Write first, then clear only leftover rows, so a failed write never erases staff-entered IDs.
  await call(`${base}/${adminId}/values:batchUpdate`, {
    valueInputOption: 'RAW',
    data: [
      { range: "'Draft Picks'!A2", values: [['YSL Top-4 Draft Picks']] },
      { range: "'Draft Picks'!A3", values: [['Each captain\'s first four picks. Yellow = moved since the draft. Ratatoskr fills Status on trades/drops; type a missing Discord ID into column F.']] },
      { range: "'Draft Picks'!A5:I5", values: [DRAFT_PICK_HEADERS] },
      { range: `'Draft Picks'!A6:I${picks.length + 5}`, values: picks.map(draftPickRow) },
      { range: "'Transaction History'!M5", values: [['Top-4 Pick']] },
      ...historyMarks.map((mark) => ({ range: `'Transaction History'!M${mark.row}`, values: [[mark.label]] })),
    ],
  });
  await call(`${base}/${adminId}/values:batchClear`, { ranges: [`'Draft Picks'!A${picks.length + 6}:I`] });
  const picksSheet = adminMeta.find((sheet) => sheet.properties.title === 'Draft Picks')!;
  const historySheet = adminMeta.find((sheet) => sheet.properties.title === 'Transaction History')!;
  const rules = [
    ...(hasRule(picksSheet, PICKS_RULE) ? [] : [yellowRule(picksSheet.properties.sheetId, 9, PICKS_RULE)]),
    ...(hasRule(historySheet, HISTORY_RULE) ? [] : [yellowRule(historySheet.properties.sheetId, 13, HISTORY_RULE)]),
  ];
  if (rules.length) await call(`${base}/${adminId}:batchUpdate`, { requests: rules });
  console.log(`\nWrote ${picks.length} Draft Picks rows, ${historyMarks.length} history marks, ${rules.length} highlight rules.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
