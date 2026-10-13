import { DRAFT_DIVISIONS, DRAFT_PICK_HEADERS, draftParseProblems, draftPickIdentityIndex } from './draftPicks.js';
import type { LeagueSheetsGateway } from './leagueSheets.js';

type Rows = (string | number | boolean | null)[][];
export const DRAFT_PICK_FEATURE = 'feature:draft-picks';
export function draftPickHealthFinding(health: DraftPickHealth, checkedAt: Date): string {
  return `${health.summary}\nNext: ${health.next}\nTracking checked: ${checkedAt.toISOString()}`;
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
const action = 'Use the approved Draft Picks setup runbook, then recheck tracking.';
const adminTabs = ['League Teams', 'Current Rosters', 'Player Name History', 'Transaction History'];
function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { status?: number; response?: { status?: number } };
  return value.status ?? value.response?.status;
}
function readFailure(error: unknown): DraftPickHealth {
  const status = httpStatus(error);
  const failures: Partial<Record<number, Pick<DraftPickHealth, 'status' | 'summary' | 'next'>>> = {
    400: { status: 'invalid-request', summary: 'Draft tracking not verified: Sheets rejected the request (400).', next: 'Review the configured Admin workbook and range; this is not confirmed tab absence.' },
    403: { status: 'permission-denied', summary: 'Draft tracking not verified: Admin workbook access denied (403).', next: 'Restore the bot service account’s existing workbook access, then recheck.' },
    404: { status: 'workbook-unavailable', summary: 'Draft tracking not verified: Admin workbook unavailable (404).', next: 'Verify the configured Admin workbook ID and existing access, then recheck.' },
    429: { status: 'quota', summary: 'Draft tracking not verified: Google Sheets quota reached (429).', next: 'Let the existing Sheets cooldown finish, then recheck.' },
    503: { status: 'service-unavailable', summary: 'Draft tracking not verified: Google Sheets temporarily unavailable (503).', next: 'Recheck after the service recovers.' },
  };
  return { ...(failures[status ?? 0] ?? { status: 'read-failed', summary: 'Draft tracking not verified: required source could not be read.', next: 'Inspect the configured Admin workbook and retry a fresh read.' }), httpStatus: status };
}
function isRangeError(error: unknown): boolean {
  const value = error as { message?: unknown; response?: { data?: { error?: { message?: unknown } } } } | null;
  const message = value?.response?.data?.error?.message ?? value?.message;
  return typeof message === 'string' && /unable to parse range|invalid.*range/i.test(message);
}

export function validateDraftPickTable(headers: Rows, rows: Rows, options: { allowCorrectedStatusOwner?: boolean } = {}): DraftPickHealth {
  const invalid: DraftPickHealth = { status: 'invalid-schema', summary: 'Draft tracking not verified: columns, pick identity or status ownership are invalid.',
    next: 'Review row 5 and columns A–J; preserve existing IDs, account links and move status before repair.' };
  const populated = rows.filter(row => row.some(cell => String(cell ?? '').trim()));
  if (!headers.length && !populated.length)
    return { status: 'empty-tab', summary: 'Draft tracking not verified: Draft Picks is empty.', next: action };
  if (DRAFT_PICK_HEADERS.some((header, index) => String(headers[0]?.[index] ?? '').trim() !== header)) return invalid;
  if (!populated.length) return { status: 'empty-tab', summary: 'Draft tracking not verified: Draft Picks has no pick rows.', next: action };
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
      || (text(5) && text(8) !== 'On drafted team' && !text(8).startsWith('Moved ·'))
      || (!options.allowCorrectedStatusOwner && text(8).startsWith('Moved ·') && text(9) !== text(5))) return invalid;
    slots.add(slot); if (text(5)) ids.add(text(5));
  }
  try { draftPickIdentityIndex(rows); } catch { return invalid; }
  const problems = draftParseProblems(populated.map(row => ({ division: String(row[0]), team: String(row[1]),
    round: Number(row[2]), pick: String(row[3]), draftName: String(row[4]) })));
  const unresolved = populated.filter(row => !String(row[5] ?? '').trim()).length;
  if (populated.length !== 96 || problems.length || unresolved || populated.some(row => String(row[9] ?? '').trim() && row[9] !== row[5]))
    return { status: 'partial', summary: `Draft tracking incomplete: ${populated.length}/96 slots; ${unresolved} unresolved identities. Unmatched players are not verified.`,
      next: 'Review the seed dry-run and correct unresolved IDs in column F before verifying tracking.' };
  return { status: 'ready', summary: 'Draft tracking ready: 96 resolved top-four picks.', next: 'No setup action needed.' };
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
          return { health: { status: 'wrong-workbook', summary: 'Draft tracking not verified: configured workbook lacks required Admin tabs.', next: 'Correct the Admin workbook configuration; do not seed this workbook.', httpStatus: 400 }, rows: null };
        if (isRangeError(error)) return { health: tabs.has('Draft Picks')
          ? { status: 'invalid-range', summary: 'Draft tracking not verified: Draft Picks exists, but its range was rejected (400).', next: 'Review the range/schema; do not recreate or overwrite the tab.', httpStatus: 400 }
          : { status: 'missing-tab', summary: 'Draft tracking unavailable: Draft Picks tab is missing.', next: action, httpStatus: 400 }, rows: null };
      } catch (metadataError) { return { health: readFailure(metadataError), rows: null }; }
    }
    return { health: readFailure(error), rows: null };
  }
}
