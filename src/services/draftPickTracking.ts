import { leagueEasternTime } from './leaguePresentation.js';
import { DRAFT_DIVISIONS, DRAFT_PICK_HEADERS, draftParseProblems, draftPickIdentityIndex } from './draftPicks.js';
import type { LeagueSheetsGateway, PreparedAccountReplacementSheets } from './leagueSheets.js';

type Rows = (string | number | boolean | null)[][];
export const DRAFT_PICK_FEATURE = 'feature:draft-picks';
export function draftPickVerificationText(verification: PreparedAccountReplacementSheets['draftVerification']): string {
  switch (verification) {
    case 'verified': return 'player and past moves checked';
    case 'skipped:missing-tab': return 'Draft Picks is missing, so the player’s draft history could not be checked';
    case 'skipped:empty-tab': return 'Draft Picks is empty, so the player’s draft history could not be checked';
    case 'partial:unverified-slots': return 'draft records are incomplete; known player details and past moves were checked, but the other picks still need checking';
  }
}
export function draftPickHealthFinding(health: DraftPickHealth, checkedAt: Date): string {
  return `${health.summary}\nNext: ${health.next}\nDraft picks checked: ${leagueEasternTime(checkedAt)}`;
}
export type DraftPickHealth = {
  status: 'ready' | 'partial' | 'empty-tab' | 'missing-tab' | 'invalid-schema' | 'invalid-range'
    | 'wrong-workbook' | 'invalid-request' | 'permission-denied' | 'workbook-unavailable' | 'quota' | 'service-unavailable' | 'read-failed';
  summary: string;
  next: string;
  httpStatus?: number;
};
export class DraftPickTrackingError extends Error {
  readonly status?: number;
  constructor(readonly health: DraftPickHealth) {
    super(`${health.summary} ${health.next}`);
    this.name = 'DraftPickTrackingError';
    this.status = health.httpStatus;
  }
}
const action = 'Ask an admin to follow the approved Draft Picks setup guide, then check again.';
const adminTabs = ['League Teams', 'Current Rosters', 'Player Name History', 'Transaction History'];
function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { status?: number; response?: { status?: number } };
  return value.status ?? value.response?.status;
}
function readFailure(error: unknown): DraftPickHealth {
  const status = httpStatus(error);
  const failures: Partial<Record<number, Pick<DraftPickHealth, 'status' | 'summary' | 'next'>>> = {
    400: { status: 'invalid-request', summary: 'Draft picks not checked: Google Sheets could not read the requested cells.', next: 'Ask an admin to check which sheet and cells Rat is using. Do not create a new Draft Picks tab yet.' },
    403: { status: 'permission-denied', summary: 'Draft picks not checked: Rat cannot open the Admin sheet.', next: 'Ask an admin to restore Rat’s access to the sheet, then check again.' },
    404: { status: 'workbook-unavailable', summary: 'Draft picks not checked: Rat could not find or open the Admin sheet.', next: 'Ask an admin to check that Rat has the correct sheet and can open it, then check again.' },
    429: { status: 'quota', summary: 'Draft picks not checked: Google Sheets asked Rat to wait.', next: 'Wait for Google Sheets to allow another check, then check again.' },
    503: { status: 'service-unavailable', summary: 'Draft picks not checked: Google Sheets is temporarily unavailable.', next: 'Recheck after the service recovers.' },
  };
  return { ...(failures[status ?? 0] ?? { status: 'read-failed', summary: 'Draft picks not checked: Rat could not read all required records.', next: 'Ask an admin to check the Admin sheet, then check again.' }), httpStatus: status };
}
function isRangeError(error: unknown): boolean {
  const value = error as { message?: unknown; response?: { data?: { error?: { message?: unknown } } } } | null;
  const message = value?.response?.data?.error?.message ?? value?.message;
  return typeof message === 'string' && /unable to parse range|invalid.*range/i.test(message);
}

export function validateDraftPickTable(headers: Rows, rows: Rows, options: { allowCorrectedStatusOwner?: boolean } = {}): DraftPickHealth {
  const invalid: DraftPickHealth = { status: 'invalid-schema', summary: 'Draft picks not checked: the columns, player details or recorded moves in Draft Picks need fixing.',
    next: 'Review row 5 and columns A–J; preserve existing IDs, account links and move status before repair.' };
  const populated = rows.filter(row => row.some(cell => String(cell ?? '').trim()));
  if (!headers.length && !populated.length)
    return { status: 'empty-tab', summary: 'Draft picks not checked: Draft Picks is empty.', next: action };
  if (DRAFT_PICK_HEADERS.some((header, index) => String(headers[0]?.[index] ?? '').trim() !== header)) return invalid;
  if (!populated.length) return { status: 'empty-tab', summary: 'Draft picks not checked: Draft Picks has no players listed.', next: action };
  const ids = new Set<string>();
  const slots = new Set<string>();
  for (const row of populated) {
    const text = (index: number) => String(row[index] ?? '').trim();
    const slot = `${text(0)}|${text(1)}|${text(2)}`;
    if (!DRAFT_DIVISIONS.some(division => division === text(0)) || !text(1) || !/^[1-4]$/.test(text(2))
      || !/^\d+$/.test(text(3)) || Number(text(3)) < 1 || !text(4) || !text(7) || slots.has(slot)
      || (text(5) && (typeof row[5] !== 'string' || ids.has(text(5))))
      || (text(9) && (typeof row[9] !== 'string' || (!options.allowCorrectedStatusOwner && text(9) !== text(5))))
      || (!text(5) && text(8) !== 'Unknown')
      || (text(5) && text(8) !== 'On drafted team' && !text(8).startsWith('Moved ·')
        && !(options.allowCorrectedStatusOwner && text(8) === 'Unknown'))
      || (!options.allowCorrectedStatusOwner && text(8).startsWith('Moved ·') && text(9) !== text(5))) return invalid;
    slots.add(slot); if (text(5)) ids.add(text(5));
  }
  try { draftPickIdentityIndex(rows); } catch { return invalid; }
  const problems = draftParseProblems(populated.map(row => ({ division: String(row[0]), team: String(row[1]),
    round: Number(row[2]), pick: String(row[3]), draftName: String(row[4]) })));
  const unresolved = populated.filter(row => !String(row[5] ?? '').trim()).length;
  if (populated.length !== 96 || problems.length || unresolved
    || populated.some(row => String(row[8]).trim() === 'Unknown' || (String(row[9] ?? '').trim() && row[9] !== row[5])))
    return { status: 'partial', summary: `Draft picks are incomplete: ${populated.length}/96 picks listed; ${unresolved} players still need matching to their Discord accounts. These players have not been checked.`,
      next: 'Review the setup preview and fix missing or incorrect Discord IDs in column F, then check again.' };
  return { status: 'ready', summary: 'Draft picks checked: all 96 top-four picks have matching player records.', next: 'No setup action needed.' };
}

export async function readDraftPickTracking(
  gateway: Pick<LeagueSheetsGateway, 'getValues' | 'getValuesBatch' | 'getWorkbookProperties'>,
  adminId: string,
): Promise<{ health: DraftPickHealth; rows: Rows | null }> {
  try {
    const ranges = ["'Draft Picks'!A5:J5", "'Draft Picks'!A6:J"];
    const [headers = [], rows = []] = gateway.getValuesBatch
      ? await gateway.getValuesBatch(adminId, ranges, { purpose: 'fresh', valueRenderOption: 'UNFORMATTED_VALUE' })
      : await Promise.all(ranges.map(range => gateway.getValues(adminId, range, { purpose: 'fresh', valueRenderOption: 'UNFORMATTED_VALUE' })));
    const health = validateDraftPickTable(headers, rows);
    return { health, rows: health.status === 'invalid-schema' ? null : rows };
  } catch (error) {
    if (httpStatus(error) === 400 && gateway.getWorkbookProperties) {
      try {
        const metadata = await gateway.getWorkbookProperties(adminId);
        const tabs = new Set(metadata.sheets.map(sheet => sheet.title));
        if (adminTabs.some(tab => !tabs.has(tab)))
          return { health: { status: 'wrong-workbook', summary: 'Draft picks not checked: Rat’s selected sheet is missing required league tabs.', next: 'Ask an admin to choose the correct Admin sheet. Do not add draft records here.', httpStatus: 400 }, rows: null };
        if (isRangeError(error)) return { health: tabs.has('Draft Picks')
          ? { status: 'invalid-range', summary: 'Draft picks not checked: Draft Picks exists, but Rat could not read its cells.', next: 'Ask an admin to check the columns and cells Rat reads. Do not replace or overwrite Draft Picks.', httpStatus: 400 }
          : { status: 'missing-tab', summary: 'Draft picks not checked: the Draft Picks tab is missing.', next: action, httpStatus: 400 }, rows: null };
      } catch (metadataError) { return { health: readFailure(metadataError), rows: null }; }
    }
    return { health: readFailure(error), rows: null };
  }
}
