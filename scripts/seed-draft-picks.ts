// Seeds the Admin 'Draft Picks' tab (each captain's first four draft picks, resolved to Discord IDs)
// and backfills Transaction History column M for moves made before tracking existed.
// Dry run by default; pass --write to apply. Re-running keeps staff-entered IDs.
//   railway run npx tsx scripts/seed-draft-picks.ts [--write] [--since=YYYY-MM-DD] [--allow-partial]
// --since: the draft date. Only history on/after it counts. It is stored in Draft Picks B4; a later run
//   with a different date is a new season and starts the tab over, while omitting it reuses B4.
// --allow-partial: write even if fewer than 3 divisions x 8 teams x 4 picks were parsed.
// --write also requires reviewed --expect-admin-id / --expect-public-id targets.
// A changed stored draft date requires explicit --confirm-season-reset approval.
import 'dotenv/config';
import { GoogleAuth } from 'google-auth-library';
import { createHash } from 'node:crypto';
import {
  DRAFT_DIVISIONS, DRAFT_PICK_HEADERS, draftParseProblems, draftPickIdentityIndex, draftPickRow, parseDraftTab, resolveDraftPicks,
  assertDraftPickSeedTargets, assertDraftPickSeedSeason, DraftPickSeedInputError,
} from '../src/services/draftPicks.js';
import { draftPickLabel } from '../src/services/leagueSheets.js';
import { validateDraftPickTable } from '../src/services/draftPickTracking.js';
import { publicDraftHighlightCells, draftNameColorRequest, hasDraftHistoryRule, type DraftHistoryRule } from '../src/services/draftPickPresentation.js';

type Rows = (string | number | boolean | null)[][];
type SheetMeta = { properties: { sheetId: number; title: string }; conditionalFormats?: DraftHistoryRule[] };

const write = process.argv.includes('--write');
const allowPartial = process.argv.includes('--allow-partial');
const summaryOnly = process.argv.includes('--summary-only');
const expectedAdminId = process.argv.find(arg => arg.startsWith('--expect-admin-id='))?.slice('--expect-admin-id='.length);
const expectedPublicId = process.argv.find(arg => arg.startsWith('--expect-public-id='))?.slice('--expect-public-id='.length);
const expectedPlan = process.argv.find(arg => arg.startsWith('--expect-plan='))?.slice('--expect-plan='.length);
const sinceArg = process.argv.find((arg) => arg.startsWith('--since='))?.slice('--since='.length) ?? '';
const EXPECTED_PICKS = DRAFT_DIVISIONS.length * 8 * 4;
// Round-trip through Date so shape-valid but impossible dates (2026-13-01, 2026-02-30) are rejected.
const sinceTime = new Date(`${sinceArg}T00:00:00Z`).getTime();
if (sinceArg && !(/^\d{4}-\d{2}-\d{2}$/.test(sinceArg) && !Number.isNaN(sinceTime) && new Date(sinceTime).toISOString().startsWith(sinceArg)))
  throw new Error(`--since must be a real YYYY-MM-DD date, got "${sinceArg}".`);
const adminId = process.env.YSL_ADMIN_SPREADSHEET_ID ?? '';
const publicId = process.env.YSL_PUBLIC_SPREADSHEET_ID ?? '';
assertDraftPickSeedTargets({ adminId, publicId, write, expectedAdminId, expectedPublicId });
let credentials: object;
try { credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '{}'); }
catch { throw new DraftPickSeedInputError('GOOGLE_SERVICE_ACCOUNT_JSON must contain valid JSON.'); }
const auth = new GoogleAuth({
  credentials,
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
async function read(spreadsheetId: string, ranges: string[], valueRenderOption = 'FORMATTED_VALUE'): Promise<Rows[]> {
  const query = new URLSearchParams({ valueRenderOption });
  for (const range of ranges) query.append('ranges', range);
  const data = await call<{ valueRanges: Array<{ values?: Rows }> }>(`${base}/${spreadsheetId}/values:batchGet?${query}`);
  if (data.valueRanges.length !== ranges.length) throw new DraftPickSeedInputError('Seed read returned an incomplete range set. Nothing was written.');
  return data.valueRanges.map((range) => range.values ?? []);
}
const sheetsMeta = async (spreadsheetId: string) => (await call<{ sheets: SheetMeta[] }>(
  `${base}/${spreadsheetId}?fields=sheets(properties(sheetId,title),conditionalFormats(ranges,booleanRule))`,
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
  let adminMeta = await sheetsMeta(adminId);
  const publicMeta = await sheetsMeta(publicId);
  if (['League Teams', 'Current Rosters', 'Player Name History', 'Transaction History'].some(title => !adminMeta.some(sheet => sheet.properties.title === title)))
    throw new DraftPickSeedInputError('Configured Admin workbook lacks required Admin tabs. Do not seed this workbook.');
  if (['FinalizedVetting', ...DRAFT_DIVISIONS.flatMap(division => [`${division} Draft`, `${division} Roster`])].some(title => !publicMeta.some(sheet => sheet.properties.title === title)))
    throw new DraftPickSeedInputError('Configured public workbook lacks required draft source tabs. Nothing was written.');
  const publicRanges = ['FinalizedVetting!A2:D', ...DRAFT_DIVISIONS.map(division => `'${division} Draft'!A1:O60`), ...DRAFT_DIVISIONS.map(division => `'${division} Roster'!A1:O22`)];
  const publicSources = await read(publicId, publicRanges);
  const vetting = publicSources[0], draftTabs = publicSources.slice(1, 4);
  const picksTabExists = adminMeta.some((sheet) => sheet.properties.title === 'Draft Picks');
  let [memberDirectory, nameHistory, rosters, history, existing, storedDate, draftHeaders] = await read(adminId, [
    "'Member Directory'!A6:D", "'Player Name History'!A6:C", "'Current Rosters'!A6:F", "'Transaction History'!A6:M",
    ...(picksTabExists ? ["'Draft Picks'!A6:J", "'Draft Picks'!B4", "'Draft Picks'!A5:J5"] : []),
  ]);
  // Formatted reads turn numeric IDs into strings after precision was lost.
  // Read actual stored F/J types before trusting an existing identity.
  if (picksTabExists) existing = (await read(adminId, ["'Draft Picks'!A6:J"], 'UNFORMATTED_VALUE'))[0];
  // The reviewed seed plan handles a manually corrected F/J owner by recomputing
  // status; runtime proof reads reject that mismatch until this repair is approved.
  if (picksTabExists && validateDraftPickTable(draftHeaders ?? [], existing ?? [], { allowCorrectedStatusOwner: true }).status === 'invalid-schema')
    throw new DraftPickSeedInputError('Existing Draft Picks schema/identity/status is invalid. Preserve and repair it before seeding.');
  // The tab remembers its draft date. Same date (or none given) = same season: keep staff-entered IDs
  // and move records across re-runs. A different date = new season: start over.
  const tabDate = String(storedDate?.[0]?.[0] ?? '').trim();
  const since = sinceArg || tabDate;
  const newSeason = Boolean(sinceArg && tabDate && sinceArg !== tabDate);
  if (newSeason) console.log(`New season: draft date ${tabDate} -> ${sinceArg}. Existing Draft Picks rows are not carried over.`);

  const picks = resolveDraftPicks(
    DRAFT_DIVISIONS.flatMap((division, index) => parseDraftTab(division, draftTabs[index]!)),
    { vetting: vetting!, memberDirectory: memberDirectory!, nameHistory: nameHistory!, rosters: rosters!, history: history!, since },
    newSeason ? [] : existing ?? [],
  );
  const byId = new Map(picks.filter((pick) => pick.discordId).map((pick) => [pick.discordId, pick]));
  for (const [legacyId, currentId] of draftPickIdentityIndex(newSeason ? [] : existing ?? [])) {
    const pick = byId.get(currentId);
    if (pick) byId.set(legacyId, pick);
  }
  const plannedHealth = validateDraftPickTable([DRAFT_PICK_HEADERS], picks.map(draftPickRow));
  const publicHighlights = publicDraftHighlightCells(picks.filter(pick => pick.status.startsWith('Moved')), Object.fromEntries(DRAFT_DIVISIONS.map((division, index) => [division, publicSources[index + 4]!])))
    .map(cell => ({ ...cell, sheetId: publicMeta.find(sheet => sheet.properties.title === cell.title)!.properties.sheetId }));
  // Recompute column M for every in-season row so ID corrections also clear stale marks.
  // Renames are not roster moves (the runtime skips them too).
  const historyMarks = history!.flatMap((row, index) => {
    if (String(row[2] ?? '').trim() < since) return [];
    const rename = String(row[1] ?? '').trim() === 'rename';
    const pick = rename ? undefined : byId.get(String(row[6] ?? '').trim());
    const label = pick ? draftPickLabel({ ...pick, round: String(pick.round) })
      : rename || plannedHealth.status === 'ready' ? '' : 'Not verified: Draft Picks incomplete';
    return label === String(row[12] ?? '').trim()
      ? []
      : [{ row: index + 6, reference: String(row[0]), player: String(row[7]), label }];
  });
  const planFingerprint = createHash('sha256').update(JSON.stringify({ adminId, publicId, since, newSeason,
    allowPartial, picks: picks.map(draftPickRow), historyMarks, publicHighlights, publicSources, existing: existing ?? [], storedDate: storedDate ?? [] })).digest('hex');
  console.log(`Seed plan fingerprint: ${planFingerprint}`);

  console.log(`Parsed ${picks.length} top-4 picks (expected ${EXPECTED_PICKS}).`);
  const unresolved = picks.filter((pick) => !pick.discordId);
  console.log(`\nUnresolved (${unresolved.length}) — type the Discord ID into column F of Draft Picks, then re-run:`);
  if (!summaryOnly) for (const pick of unresolved) console.log(`  ${pick.division} ${pick.team} R${pick.round} (#${pick.pick}): ${pick.draftName}`);
  const moved = picks.filter((pick) => pick.status.startsWith('Moved'));
  console.log(`\nMoved top-4 picks (${moved.length}) — rows that will be yellow:`);
  if (!summaryOnly) for (const pick of moved) console.log(`  ${pick.division} ${pick.team} R${pick.round} (#${pick.pick}): ${pick.draftName} → ${pick.status}`);
  console.log(`\nTransaction History column M changes (${historyMarks.length}):`);
  if (!summaryOnly) for (const mark of historyMarks) console.log(`  row ${mark.row} ${mark.reference} ${mark.player}: ${mark.label || '(clear stale mark)'}`);
  console.log(`\nPublic roster name cells to color yellow (${publicHighlights.length}):`);
  if (!summaryOnly) for (const cell of publicHighlights) console.log(`  ${cell.range}: yellow name text; preserve name, background and other font styling`);

  if (!write) {
    const problems = draftParseProblems(picks, rosters!);
    console.log(`\nParse valid: ${picks.length === EXPECTED_PICKS && !problems.length && plannedHealth.status !== 'invalid-schema'}. Planned tracking: ${plannedHealth.status}. Draft date supplied/stored: ${Boolean(since)}.`);
    console.log('Dry run: no writes. Approval, reviewed --expect-plan, matching workbook IDs and a draft date are required for --write.');
    return;
  }
  if (plannedHealth.status === 'invalid-schema')
    throw new DraftPickSeedInputError('Planned Draft Picks schema is invalid. Correct source slots/identities before seeding. Nothing was written.');
  assertDraftPickSeedSeason(since, newSeason, process.argv.includes('--confirm-season-reset'));
  if (!expectedPlan || expectedPlan !== planFingerprint)
    throw new DraftPickSeedInputError('--write requires --expect-plan matching the reviewed dry-run fingerprint. Nothing was written.');
  // A short parse would drop protected picks (and their staff-entered IDs) from the tab.
  const problems = draftParseProblems(picks, rosters!);
  if ((picks.length !== EXPECTED_PICKS || problems.length) && !allowPartial) {
    throw new Error(`Draft parse is incomplete (${picks.length}/${EXPECTED_PICKS}): ${problems.join('; ') || 'count mismatch'}. Check the draft tabs, or pass --allow-partial.`);
  }
  // One player per slot: lookups are keyed by Discord ID, so a duplicate would silently hide a slot.
  const seen = new Map<string, string>();
  const duplicates = picks.flatMap((pick) => {
    const slot = `${pick.division} ${pick.team} R${pick.round}`;
    const other = pick.discordId ? seen.get(pick.discordId) : undefined;
    if (pick.discordId) seen.set(pick.discordId, slot);
    return other ? [`${pick.discordId} is in both ${other} and ${slot}`] : [];
  });
  if (duplicates.length) throw new Error(`Duplicate Discord IDs in Draft Picks: ${duplicates.join('; ')}. Fix column F, then re-run.`);

  // A local Railway run has no production volume/lock. Guard observed workbook
  // state immediately before writing and require an approved staff quiet window.
  const freshMeta = await sheetsMeta(adminId);
  const priorTab = adminMeta.find(sheet => sheet.properties.title === 'Draft Picks');
  const currentTab = freshMeta.find(sheet => sheet.properties.title === 'Draft Picks');
  if (priorTab?.properties.sheetId !== currentTab?.properties.sheetId)
    throw new DraftPickSeedInputError('Draft Picks tab ownership changed after planning. Nothing was written.');
  const freshAdmin = await read(adminId, ["'Member Directory'!A6:D", "'Player Name History'!A6:C", "'Current Rosters'!A6:F", "'Transaction History'!A6:M",
    ...(picksTabExists ? ["'Draft Picks'!A6:J", "'Draft Picks'!B4", "'Draft Picks'!A5:J5"] : [])]);
  if (picksTabExists) freshAdmin[4] = (await read(adminId, ["'Draft Picks'!A6:J"], 'UNFORMATTED_VALUE'))[0]!;
  const freshPublic = await read(publicId, publicRanges);
  const freshPublicMeta = await sheetsMeta(publicId);
  if (publicHighlights.some(cell => freshPublicMeta.filter(sheet => sheet.properties.title === cell.title).length !== 1
    || freshPublicMeta.find(sheet => sheet.properties.title === cell.title)?.properties.sheetId !== cell.sheetId))
    throw new DraftPickSeedInputError('Public roster ownership changed after planning. Nothing was written.');
  const adminBefore = [memberDirectory, nameHistory, rosters, history, ...(picksTabExists ? [existing, storedDate, draftHeaders] : [])];
  if (JSON.stringify(freshAdmin) !== JSON.stringify(adminBefore) || JSON.stringify(freshPublic) !== JSON.stringify(publicSources))
    throw new DraftPickSeedInputError('Seed inputs changed after planning. Review a new dry run; nothing was written.');

  if (!picksTabExists) {
    await call(`${base}/${adminId}:batchUpdate`, { requests: [{ addSheet: { properties: { title: 'Draft Picks' } } }] });
    adminMeta = await sheetsMeta(adminId);
  }
  // Discord IDs exceed Sheets' 15-digit number precision; keep the ID columns (F, J) as plain text.
  const picksSheetId = adminMeta.find((sheet) => sheet.properties.title === 'Draft Picks')!.properties.sheetId;
  await call(`${base}/${adminId}:batchUpdate`, {
    requests: [5, 9].map((column) => ({
      repeatCell: {
        range: { sheetId: picksSheetId, startRowIndex: 5, startColumnIndex: column, endColumnIndex: column + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'TEXT', pattern: '@' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    })),
  });
  // Write first, then clear only leftover rows, so a failed write never erases staff-entered IDs.
  await call(`${base}/${adminId}/values:batchUpdate`, {
    valueInputOption: 'RAW',
    data: [
      { range: "'Draft Picks'!A2", values: [['YSL Top-4 Draft Picks']] },
      { range: "'Draft Picks'!A3", values: [['Each captain\'s first four picks. Yellow = moved since the draft. Ratatoskr fills Status on trades/drops; type a missing Discord ID into column F.']] },
      { range: "'Draft Picks'!A4:B4", values: [['Draft date', since]] },
      { range: "'Draft Picks'!A5:J5", values: [DRAFT_PICK_HEADERS] },
      { range: `'Draft Picks'!A6:J${picks.length + 5}`, values: picks.map(draftPickRow) },
      { range: "'Transaction History'!M5", values: [['Top-4 Pick']] },
      ...historyMarks.map((mark) => ({ range: `'Transaction History'!M${mark.row}`, values: [[mark.label]] })),
    ],
  });
  await call(`${base}/${adminId}/values:batchClear`, { ranges: [`'Draft Picks'!A${picks.length + 6}:J`] });
  const picksSheet = adminMeta.find((sheet) => sheet.properties.title === 'Draft Picks')!;
  const historySheet = adminMeta.find((sheet) => sheet.properties.title === 'Transaction History')!;
  const rules = [
    ...(hasRule(picksSheet, PICKS_RULE) ? [] : [yellowRule(picksSheet.properties.sheetId, 10, PICKS_RULE)]),
    ...(hasDraftHistoryRule(historySheet.properties.sheetId, historySheet.conditionalFormats) ? [] : [yellowRule(historySheet.properties.sheetId, 13, HISTORY_RULE)]),
  ];
  if (rules.length) await call(`${base}/${adminId}:batchUpdate`, { requests: rules });
  if (publicHighlights.length) await call(`${base}/${publicId}:batchUpdate`, { requests: publicHighlights.map(draftNameColorRequest) });
  console.log(`\nWrote ${picks.length} Draft Picks rows, ${historyMarks.length} history marks, ${rules.length} highlight rules.`);
}

main().catch((error) => {
  // Raw Google errors can include authorization headers and private workbook URLs.
  const status = error && typeof error === 'object' ? (error.status ?? error.response?.status) : undefined;
  console.error(error instanceof DraftPickSeedInputError ? error.message
    : `Draft Picks seeding stopped${typeof status === 'number' ? ` (HTTP ${status})` : ''}. Inspect private source/schema and access; do not replay --write blindly.`);
  process.exitCode = 1;
});
