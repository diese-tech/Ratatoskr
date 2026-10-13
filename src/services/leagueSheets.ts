import { GoogleAuth } from 'google-auth-library';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { LeagueAccountReplacementPlan } from '../domain/leagueAccountReplacement.js';
import { draftPickIdentityIndex, planDraftPickAccountReplacement } from './draftPicks.js';
import { readDraftPickTracking, DraftPickTrackingError, type DraftPickHealth } from './draftPickTracking.js';
import { PUBLIC_TEAM_CELLS, publicDraftHighlightCells, draftNameColorRequest, DRAFT_HISTORY_RULE, DRAFT_ROW_YELLOW, hasDraftHistoryRule, type DraftHistoryRule, type DraftHighlightSlot } from './draftPickPresentation.js';
import {
  type DiscordLeagueMember,
  type LeagueDivision,
  type LeagueMutationPlan,
  type LeagueNameRow,
  type LeagueRosterRow,
  type LeagueSnapshot,
  type LeagueTeam,
  type PublicRosterChange,
  SELF_DROP_LEAGUE_STATUS,
} from '../domain/leagueOperations.js';

type Cell = string | number | boolean | null;
type CellRows = Cell[][];

export type SheetValueUpdate = { range: string; values: CellRows };
export type SelfDropPresentation = { sheetId: number; legend: CellRows; ruleExists: boolean };

// Reuse is opt-in for presentation only. Proof reads always bypass it.
export type LeagueSheetsReadOptions = { purpose: 'presentation' | 'fresh'; valueRenderOption?: 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' };

export interface LeagueSheetsGateway {
  ensureDraftPickHighlights?(adminId: string, publicId: string, slots: DraftHighlightSlot[]): Promise<void>;
  getWorkbookProperties?(spreadsheetId: string): Promise<{ title: string; sheets: Array<{ title: string; sheetId: number }> }>;
  getValues(spreadsheetId: string, range: string, options?: LeagueSheetsReadOptions): Promise<CellRows>;
  getValuesBatch?(spreadsheetId: string, ranges: string[], options?: LeagueSheetsReadOptions): Promise<CellRows[]>;
  batchUpdate(spreadsheetId: string, updates: SheetValueUpdate[], valueInputOption?: 'RAW' | 'USER_ENTERED'): Promise<void>;
  append(spreadsheetId: string, range: string, values: CellRows, valueInputOption?: 'RAW' | 'USER_ENTERED'): Promise<void>;
  getSelfDropPresentation(spreadsheetId: string): Promise<SelfDropPresentation>;
  ensureSelfDropPresentation(spreadsheetId: string, presentation: { sheetId: number; writeLegend: boolean; addRule: boolean }): Promise<void>;
}

export type LeagueSheetsConfig = {
  adminSpreadsheetId: string;
  publicSpreadsheetId: string;
};

const ServiceAccountSchema = z.object({
  client_email: z.string().email(),
  private_key: z.string().min(1),
  project_id: z.string().optional(),
});

const LeagueSheetsEnvironmentSchema = z.object({
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().min(1),
  YSL_ADMIN_SPREADSHEET_ID: z.string().min(1),
  YSL_PUBLIC_SPREADSHEET_ID: z.string().min(1),
});

// Pace league reads below the service-account limit and respect quota cooldowns.
// A failed read is returned to durable recovery rather than replayed here.
export function createLeagueSheetsReadSchedule(
  clock = {
    now: () => Date.now(),
    wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  },
) {
  let tail: Promise<unknown> = Promise.resolve();
  let nextReadAt = 0;
  type ReadEntry = { workbook: string; pending: Promise<unknown>; expiresAt: number };
  const reusable = new Map<string, ReadEntry>();
  const ttlMs = 3000;
  const maxEntries = 128;
  const schedule = <T>(read: () => Promise<T>, reuse?: {
    workbook: string; key: string; purpose: 'presentation' | 'fresh';
  }): Promise<T> => {
    const key = reuse ? JSON.stringify([reuse.workbook, reuse.key]) : '';
    if (reuse?.purpose === 'presentation') {
      for (const [candidate, entry] of reusable)
        if (entry.expiresAt <= clock.now()) reusable.delete(candidate);
      const existing = reusable.get(key);
      if (existing) return existing.pending.then((value) => structuredClone(value) as T);
    }

    const pending = tail.then(async () => {
      const delay = nextReadAt - clock.now();
      if (delay > 0) await clock.wait(delay);
      nextReadAt = clock.now() + 2000;
      try {
        return await read();
      } catch (error) {
        if (error && typeof error === 'object' && 'status' in error && error.status === 429)
          nextReadAt = clock.now() + 60_000;
        throw error;
      }
    });
    tail = pending.catch(() => {});
    if (reuse?.purpose !== 'presentation') return pending;
    // Bound queued/in-flight entries too. Eviction sacrifices reuse, never pacing.
    if (reusable.size >= maxEntries) reusable.delete(reusable.keys().next().value!);
    const entry: ReadEntry = { workbook: reuse.workbook, pending, expiresAt: Infinity };
    reusable.set(key, entry);
    void pending.then(() => {
      if (reusable.get(key) === entry) entry.expiresAt = clock.now() + ttlMs;
    }, () => {
      if (reusable.get(key) === entry) reusable.delete(key);
    });
    return pending.then((value) => structuredClone(value));
  };
  schedule.invalidateWorkbook = (workbook: string): void => {
    for (const [key, entry] of reusable)
      if (entry.workbook === workbook) reusable.delete(key);
  };
  return schedule;
}

const leagueSheetsReadSchedules = new Map<string, ReturnType<typeof createLeagueSheetsReadSchedule>>();
export function getLeagueSheetsReadSchedule(accountId: string, clock?: Parameters<typeof createLeagueSheetsReadSchedule>[0]) {
  let schedule = leagueSheetsReadSchedules.get(accountId);
  if (!schedule) {
    schedule = createLeagueSheetsReadSchedule(clock);
    leagueSheetsReadSchedules.set(accountId, schedule);
  }
  return schedule;
}

export function createGoogleLeagueSheetsGateway(environment: NodeJS.ProcessEnv = process.env): {
  gateway: LeagueSheetsGateway;
  config: LeagueSheetsConfig;
} {
  const parsed = LeagueSheetsEnvironmentSchema.parse(environment);
  let credentials: unknown;
  try { credentials = JSON.parse(parsed.GOOGLE_SERVICE_ACCOUNT_JSON); }
  catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON must contain valid JSON.'); }
  const serviceAccount = ServiceAccountSchema.parse(credentials);
  const auth = new GoogleAuth({ credentials: serviceAccount, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });

  const scheduleRead = getLeagueSheetsReadSchedule(serviceAccount.client_email);

  const gateway = createScheduledLeagueSheetsGateway(scheduleRead, async <T>(options: LeagueSheetsRequest) => {
    const client = await auth.getClient();
    return (await client.request<T>({ ...options, retry: false })).data;
  });
  return { gateway, config: { adminSpreadsheetId: parsed.YSL_ADMIN_SPREADSHEET_ID, publicSpreadsheetId: parsed.YSL_PUBLIC_SPREADSHEET_ID } };
}

type LeagueSheetsRequest = { url: string; method?: 'GET' | 'POST'; data?: unknown };

// One shared scheduler owns pacing, quota cooldown, and presentation reuse.
export function createScheduledLeagueSheetsGateway(
  scheduleRead: ReturnType<typeof createLeagueSheetsReadSchedule>,
  send: <T>(options: LeagueSheetsRequest) => Promise<T>,
): LeagueSheetsGateway {
  const request = async <T>(options: LeagueSheetsRequest,
    readOptions: LeagueSheetsReadOptions = { purpose: 'fresh' }, validate?: (data: T) => void): Promise<T> => {
    const workbook = /\/spreadsheets\/([^/:?]+)/.exec(options.url)![1]!;
    if (options.method === 'POST') {
      // Invalidate even on ambiguous failure; do not let an older in-flight
      // read populate the cache after an external write starts or settles.
      scheduleRead.invalidateWorkbook(workbook);
      try { return await send<T>(options); }
      finally { scheduleRead.invalidateWorkbook(workbook); }
    }
    return scheduleRead(async () => {
      const data = await send<T>(options);
      validate?.(data);
      return data;
    }, { workbook, key: options.url, purpose: readOptions.purpose });
  };
  const gateway: LeagueSheetsGateway = {
    async ensureDraftPickHighlights(adminId, publicId, slots) {
      if (adminId === publicId) throw new Error('Draft highlighting requires distinct Admin and public targets.');
      type Meta = { sheets: Array<{ properties: { title: string; sheetId: number }; conditionalFormats?: DraftHistoryRule[] }> };
      const metadata = (id: string) => request<Meta>({ url: `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets(properties(sheetId,title),conditionalFormats(ranges,booleanRule))` });
      const admin = await metadata(adminId);
      const history = admin.sheets.filter(sheet => sheet.properties.title === 'Transaction History');
      if (history.length !== 1) throw new Error('Transaction History ownership is unavailable for draft highlighting.');
      const historyId = history[0]!.properties.sheetId;
      const ruleExists = hasDraftHistoryRule(historyId, history[0]!.conditionalFormats);
      let publicRequests: ReturnType<typeof draftNameColorRequest>[] = [];
      if (slots.length) {
        const publicMeta = await metadata(publicId), divisions = [...new Set(slots.map(slot => slot.division))];
        const grids = await gateway.getValuesBatch!(publicId, divisions.map(division => `'${division} Roster'!A1:O22`), { purpose: 'fresh' });
        const cells = publicDraftHighlightCells(slots, Object.fromEntries(divisions.map((division, index) => [division, grids[index]!])));
        publicRequests = cells.map(cell => {
          const sheets = publicMeta.sheets.filter(sheet => sheet.properties.title === cell.title);
          if (sheets.length !== 1) throw new Error('Public roster sheet ownership changed before draft highlighting.');
          return draftNameColorRequest({ ...cell, sheetId: sheets[0]!.properties.sheetId });
        });
      }
      // Both projections precede the history idempotency marker. Reapplying a
      // color after a lost response is safe and does not replay the roster move.
      if (publicRequests.length) await request({ method: 'POST', url: `https://sheets.googleapis.com/v4/spreadsheets/${publicId}:batchUpdate`, data: { requests: publicRequests } });
      if (!ruleExists) await request({ method: 'POST', url: `https://sheets.googleapis.com/v4/spreadsheets/${adminId}:batchUpdate`, data: { requests: [{ addConditionalFormatRule: { index: 0, rule: {
        ranges: [{ sheetId: historyId, startRowIndex: 5, startColumnIndex: 0, endColumnIndex: 13 }],
        booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: DRAFT_HISTORY_RULE }] }, format: { backgroundColorStyle: { rgbColor: DRAFT_ROW_YELLOW } } },
      } } }] } });
    },
    async getWorkbookProperties(spreadsheetId) {
      const data = await request<{ properties: { title: string }; sheets: Array<{ properties: { sheetId: number; title: string } }> }>({
        url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=properties(title),sheets(properties(sheetId,title))`,
      });
      return { title: data.properties.title, sheets: data.sheets.map(sheet => sheet.properties) };
    },
    async getValuesBatch(spreadsheetId, ranges, options) {
      if (!ranges.length) return [];
      const query = new URLSearchParams({ valueRenderOption: options?.valueRenderOption ?? 'FORMATTED_VALUE' });
      for (const range of ranges) query.append('ranges', range);
      const data = await request<{ valueRanges?: Array<{ values?: CellRows }> }>({
        url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?${query}`,
      }, options, (result) => {
        if (result.valueRanges?.length !== ranges.length)
          throw new Error('Sheets batch read returned an incomplete range set.');
      });
      return data.valueRanges!.map((range) => range.values ?? []);
    },
    async getValues(spreadsheetId, range, options) {
      const encoded = encodeURIComponent(range);
      const data = await request<{ values?: CellRows }>({
        url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encoded}?valueRenderOption=${options?.valueRenderOption ?? 'FORMATTED_VALUE'}`,
      }, options);
      return data.values ?? [];
    },
    async batchUpdate(spreadsheetId, updates, valueInputOption = 'RAW') {
      if (updates.length === 0) return;
      await request({
        method: 'POST',
        url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
        data: { valueInputOption, data: updates.map((update) => ({ ...update, majorDimension: 'ROWS' })) },
      });
    },
    async append(spreadsheetId, range, values, valueInputOption = 'RAW') {
      const encoded = encodeURIComponent(range);
      await request({
        method: 'POST',
        url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encoded}:append?valueInputOption=${valueInputOption}&insertDataOption=INSERT_ROWS`,
        data: { majorDimension: 'ROWS', values },
      });
    },
    async getSelfDropPresentation(spreadsheetId) {
      const encoded = encodeURIComponent("'Player Name History'!J4:K4");
      const [legendData, metadata] = await Promise.all([
        request<{ values?: CellRows }>({
          url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encoded}?valueRenderOption=FORMATTED_VALUE`,
        }),
        request<{ sheets?: Array<{
          properties?: { sheetId?: number; title?: string };
          conditionalFormats?: Array<{
            ranges?: Array<{ startRowIndex?: number; startColumnIndex?: number; endColumnIndex?: number }>;
            booleanRule?: { condition?: { type?: string; values?: Array<{ userEnteredValue?: string }> } };
          }>;
        }> }>({
          url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(sheetId,title),conditionalFormats(ranges,booleanRule(condition(type,values(userEnteredValue)))))`,
        }),
      ]);
      const sheet = metadata.sheets?.find((candidate) => candidate.properties?.title === 'Player Name History');
      const sheetId = sheet?.properties?.sheetId;
      if (!sheet || sheetId === undefined) throw new Error('Player Name History sheet metadata could not be loaded.');
      const formula = `=$G6="${SELF_DROP_LEAGUE_STATUS}"`;
      const ruleExists = (sheet.conditionalFormats ?? []).some((rule) =>
        rule.booleanRule?.condition?.type === 'CUSTOM_FORMULA'
        && rule.booleanRule.condition.values?.[0]?.userEnteredValue === formula
        && (rule.ranges ?? []).some((range) => range.startRowIndex === 5
          && range.startColumnIndex === 0 && range.endColumnIndex === 11));
      return { sheetId, legend: legendData.values ?? [], ruleExists };
    },
    async ensureSelfDropPresentation(spreadsheetId, presentation) {
      if (presentation.writeLegend) {
        await request({
          method: 'POST',
          url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
          data: {
            valueInputOption: 'RAW',
            data: [{
              range: "'Player Name History'!J4:K4",
              majorDimension: 'ROWS',
              values: [['Red row', 'Self-Drop: suspended for the current season and banned for the next YSL season.']],
            }],
          },
        });
      }
      if (presentation.addRule) {
        await request({
          method: 'POST',
          url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
          data: {
            requests: [{
              addConditionalFormatRule: {
                index: 0,
                rule: {
                  ranges: [{ sheetId: presentation.sheetId, startRowIndex: 5, startColumnIndex: 0, endColumnIndex: 11 }],
                  booleanRule: {
                    condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: `=$G6="${SELF_DROP_LEAGUE_STATUS}"` }] },
                    format: { backgroundColorStyle: { rgbColor: { red: 0.96, green: 0.80, blue: 0.80 } } },
                  },
                },
              },
            }],
          },
        });
      }
    },
  };
  return gateway;
}

const ADMIN_TEAMS_RANGE = "'League Teams'!A5:L100";
const ADMIN_ROSTERS_RANGE = "'Current Rosters'!A5:J";
const ADMIN_NAMES_RANGE = "'Player Name History'!A5:K";
const PUBLIC_RANGE = 'A1:O99';

const divisions = ['Vanaheim', 'Alfheim', 'Svartalfheim'] as const;
const publicTeamCells = PUBLIC_TEAM_CELLS;

const freeAgentCells = [
  { column: 6, startRow: 25, endRow: 99 },
  { column: 10, startRow: 25, endRow: 99 },
];

function value(rows: CellRows, row: number, column: number): string {
  const cell = rows[row]?.[column];
  return cell === null || cell === undefined ? '' : String(cell).trim();
}

function parseDivision(input: string): LeagueDivision {
  if (input === 'Vanaheim' || input === 'Alfheim' || input === 'Svartalfheim') return input;
  throw new Error(`Unsupported league division: ${input || '(blank)'}.`);
}

export type LeagueSheetSources = {
  teams: CellRows;
  rosters: CellRows;
  names: CellRows;
  publicByDivision: Record<LeagueDivision, CellRows>;
  selfDropPresentation: SelfDropPresentation;
};

export type LoadedLeagueSnapshot = { snapshot: LeagueSnapshot; sources: LeagueSheetSources };

export type PreparedAccountReplacementSheets = {
  plan: LeagueAccountReplacementPlan;
  freeAgentRoleId: string;
  before: LeagueSheetSources;
  after: LeagueSheetSources;
  adminUpdates: SheetValueUpdate[];
  publicUpdates: SheetValueUpdate[];
  draftBefore: CellRows | null;
  draftAfter: CellRows | null;
  draftVerification: 'verified' | 'skipped:missing-tab' | 'skipped:empty-tab' | 'partial:unverified-slots';
};

// A captain's first four draft picks (rounds 1-4, not the Cap: line). Seeded by
// scripts/seed-draft-picks.ts into the Admin 'Draft Picks' tab; moves of these players are
// marked so staff can review trades for competitive balance.
export type DraftPickMove = {
  discordId: string;
  player: string;
  division: string;
  team: string;
  round: string;
  pick: string;
  sheetRow: number;
};

export const DRAFT_PICKS_RANGE = "'Draft Picks'!A6:J";

export function draftPickLabel(pick: Pick<DraftPickMove, 'division' | 'team' | 'round' | 'pick'>): string {
  return `${pick.division} ${pick.team} R${pick.round} (#${pick.pick})`;
}

export type LeagueTransactionRecord = {
  reference: string;
  effectiveDate: string;
  processedById: string;
  processedBy: string;
  announcementId?: string;
  approvalNote?: string;
};

export type PreparedLeagueSheetMutation = {
  publicUpdates: SheetValueUpdate[];
  selfDropPresentation?: { sheetId: number; writeLegend: boolean; addRule: boolean };
};

export class LeagueSheetDriftError extends Error {}
export class AccountReplacementNoWriteError extends LeagueSheetDriftError {}
export class LeagueSheetReconciliationRequiredError extends Error {}
export class LeagueSheetInputError extends Error {
  readonly operationalCode: string;
  readonly operationalSummary: string;
  readonly operationalNext: string;
  readonly operationalNoChanges = true;

  constructor(input: { code: string; summary: string; next: string }) {
    super(input.summary);
    this.name = 'LeagueSheetInputError';
    this.operationalCode = input.code;
    this.operationalSummary = input.summary;
    this.operationalNext = input.next;
  }
}

function parseTeams(rows: CellRows): LeagueTeam[] {
  const populated = rows.slice(1).map((row, index) => ({ row, index }))
    .filter(({ row }) => row.some((cell) => String(cell ?? '').trim() !== ''));
  for (const { row, index } of populated) {
    if ([0, 1, 2, 3, 4, 7, 11].some((column) => String(row[column] ?? '').trim() === '')) {
      throw new Error(`League Teams row ${index + 6} is partially populated; required team fields cannot be blank.`);
    }
    if (!['yes', 'no'].includes(String(row[11]).trim().toLowerCase())) {
      throw new Error(`League Teams row ${index + 6} has unsupported Active Team value; use Yes or No.`);
    }
  }
  return populated.map(({ row }) => ({
    teamKey: String(row[0]),
    franchise: String(row[1]),
    division: parseDivision(String(row[2])),
    teamRoleId: String(row[3]),
    teamRole: String(row[4]),
    divisionRoleId: String(row[7]),
    active: String(row[11]).trim().toLowerCase() === 'yes',
  }));
}

function parseRosters(rows: CellRows): LeagueRosterRow[] {
  const populated = rows.slice(1).map((row, index) => ({ row, index })).filter(({ row }) => row.some((cell) => String(cell ?? '').trim() !== ''));
  for (const { row, index } of populated) {
    if ([0, 1, 2, 3, 4, 5, 6].some((column) => String(row[column] ?? '').trim() === '')) {
      throw new Error(`Current Rosters row ${index + 6} is partially populated; required roster fields cannot be blank.`);
    }
    const status = String(row[6]).trim();
    if (status !== 'Captain' && status !== 'Player') {
      throw new Error(`Current Rosters row ${index + 6} has unsupported Roster Status "${status}"; use Captain or Player.`);
    }
  }
  return populated.map(({ row, index }) => ({
    sheetRow: index + 6,
    division: parseDivision(String(row[0])),
    franchise: String(row[1]),
    teamRoleId: String(row[2]),
    team: String(row[3]),
    discordId: String(row[4]),
    player: String(row[5]),
    rosterStatus: String(row[6]).trim() as 'Captain' | 'Player',
  }));
}

function parseNames(rows: CellRows): LeagueNameRow[] {
  const populated = rows.slice(1).map((row, index) => ({ row, index }))
    .filter(({ row }) => row.some((cell) => String(cell ?? '').trim() !== ''));
  for (const { row, index } of populated) {
    if (String(row[0] ?? '').trim() === '') {
      const sheetRow = index + 6;
      throw new LeagueSheetInputError({
        code: 'LEAGUE_SHEET_MISSING_DISCORD_ID',
        summary: `Player Name History row ${sheetRow} has player information, but its Discord ID cell in column A is blank.`,
        next: `Open Player Name History row ${sheetRow}. If the row was shifted, move the existing row values one column left so the Discord ID is in column A, then retry the action.`,
      });
    }
    if (String(row[1] ?? '').trim() === '') {
      throw new Error(`Player Name History row ${index + 6} has no Current League Name.`);
    }
  }
  return populated.map(({ row, index }) => ({
    sheetRow: index + 6,
    discordId: String(row[0]).trim(),
    currentLeagueName: String(row[1]).trim(),
    knownName: String(row[2]),
    nameStatus: String(row[3]),
    division: parseDivision(String(row[4])),
    franchise: String(row[5] ?? ''),
    leagueStatus: String(row[6]),
  }));
}

function namesInCells(rows: CellRows, cells: { column: number; startRow: number; endRow: number }[]): string[] {
  return cells.flatMap((cell) => {
    const names: string[] = [];
    for (let row = cell.startRow; row <= cell.endRow; row += 1) {
      const name = value(rows, row - 1, cell.column);
      if (name) names.push(name);
    }
    return names;
  });
}

function parsePublic(rows: CellRows) {
  return {
    teams: Object.fromEntries(Object.entries(publicTeamCells).map(([franchise, cell]) => [franchise, namesInCells(rows, [cell])])),
    freeAgents: namesInCells(rows, freeAgentCells),
  };
}

function samePublicRosters(
  left: LeagueSnapshot['publicRosters'],
  right: LeagueSnapshot['publicRosters'],
): boolean {
  const normalized = (values: string[]) => [...values].sort((a, b) => a.localeCompare(b));
  for (const division of divisions) {
    const leftDivision = left[division];
    const rightDivision = right[division];
    if (!leftDivision || !rightDivision) return false;
    const franchises = new Set([...Object.keys(leftDivision.teams), ...Object.keys(rightDivision.teams)]);
    for (const franchise of franchises) {
      if (JSON.stringify(normalized(leftDivision.teams[franchise] ?? []))
        !== JSON.stringify(normalized(rightDivision.teams[franchise] ?? []))) return false;
    }
    if (JSON.stringify(normalized(leftDivision.freeAgents))
      !== JSON.stringify(normalized(rightDivision.freeAgents))) return false;
  }
  return true;
}

const draftHealthWarnings = new Map<string, string>();
export class LeagueSheetsService {
  private draftHealthObservation?: { health: DraftPickHealth; checkedAt: Date };
  get lastDraftPickHealth() { return this.draftHealthObservation && structuredClone(this.draftHealthObservation); }
  constructor(
    private readonly gateway: LeagueSheetsGateway, private readonly config: LeagueSheetsConfig,
  ) {}

  private readRanges(spreadsheetId: string, ranges: string[]): Promise<CellRows[]> {
    return this.gateway.getValuesBatch
      ? this.gateway.getValuesBatch(spreadsheetId, ranges)
      : Promise.all(ranges.map((range) => this.gateway.getValues(spreadsheetId, range)));
  }

  private async accountReplacementDraftRows(): Promise<CellRows | null> {
    const result = await this.readDraftTracking();
    if (result.health.status === 'missing-tab') return null;
    if (!result.rows) throw new DraftPickTrackingError(result.health);
    return result.rows;
  }

  private async readDraftTracking() {
    const result = await readDraftPickTracking(this.gateway, this.config.adminSpreadsheetId);
    this.draftHealthObservation = { health: result.health, checkedAt: new Date() };
    const signature = `${result.health.status}:${result.health.summary}`;
    if (draftHealthWarnings.get(this.config.adminSpreadsheetId) !== signature) {
      draftHealthWarnings.set(this.config.adminSpreadsheetId, signature);
      if (result.health.status !== 'ready') console.warn(result.health.summary, result.health.next);
    }
    return result;
  }

  async checkDraftPickHealth(): Promise<DraftPickHealth> {
    return (await this.readDraftTracking()).health;
  }

  async prepareAccountReplacement(loaded: LoadedLeagueSnapshot, plan: LeagueAccountReplacementPlan): Promise<PreparedAccountReplacementSheets> {
    if (plan.newName.sheetRow !== loaded.sources.names.length + 5)
      throw new LeagueSheetDriftError('The new account name row must be the next unoccupied sheet row.');
    const after = structuredClone(loaded.sources);
    const nextName = [plan.newName.discordId, plan.newName.currentLeagueName, plan.newName.knownName,
      plan.newName.nameStatus, plan.newName.division, plan.newName.franchise, plan.newName.leagueStatus];
    const rosterRow = plan.rosterBefore.sheetRow;
    const nameRow = plan.oldNameBefore.sheetRow;
    const adminUpdates: SheetValueUpdate[] = [
      { range: `'Current Rosters'!E${rosterRow}:F${rosterRow}`, values: [[plan.newDiscordId, plan.rosterAfter.player]] },
      { range: `'Player Name History'!D${nameRow}`, values: [[plan.oldNameAfter.nameStatus]] },
      { range: `'Player Name History'!A${plan.newName.sheetRow}:G${plan.newName.sheetRow}`, values: [nextName] },
    ];
    after.rosters[rosterRow - 5]![4] = plan.newDiscordId;
    after.rosters[rosterRow - 5]![5] = plan.rosterAfter.player;
    after.names[nameRow - 5]![3] = plan.oldNameAfter.nameStatus;
    after.names[plan.newName.sheetRow - 5] = nextName;
    const publicUpdates = this.resolvePublicChanges(loaded, plan.publicChanges);
    for (const update of publicUpdates) {
      const match = /^'(.+) Roster'!([A-O])(\d+)$/.exec(update.range)!;
      after.publicByDivision[match[1] as LeagueDivision][Number(match[3]) - 1]![match[2]!.charCodeAt(0) - 65] = update.values[0]![0]!;
    }
    const draftBefore = await this.accountReplacementDraftRows();
    const draftStatus = this.draftHealthObservation!.health.status;
    const draftAfter = structuredClone(draftBefore);
    if (draftBefore) {
      for (const pick of planDraftPickAccountReplacement(draftBefore, plan.oldDiscordId, plan.newDiscordId, plan.rosterAfter.player)) {
        adminUpdates.push({ range: `'Draft Picks'!F${pick.sheetRow}:H${pick.sheetRow}`, values: [pick.after.slice(5, 8)] });
        if (pick.before[9] !== pick.after[9]) adminUpdates.push({ range: `'Draft Picks'!J${pick.sheetRow}`, values: [[pick.after[9]!]] });
        draftAfter![pick.sheetRow - 6] = pick.after;
      }
    }
    return { plan, freeAgentRoleId: loaded.snapshot.freeAgentRoleId, before: structuredClone(loaded.sources), after,
      adminUpdates, publicUpdates, draftBefore, draftAfter, draftVerification: draftStatus === 'missing-tab' ? 'skipped:missing-tab'
        : draftStatus === 'empty-tab' ? 'skipped:empty-tab' : draftStatus === 'partial' ? 'partial:unverified-slots' : 'verified' };
  }

  async assertAccountReplacementUnchanged(prepared: PreparedAccountReplacementSheets): Promise<void> {
    const fresh = await this.load([], prepared.freeAgentRoleId);
    const drafts = await this.accountReplacementDraftRows();
    if (JSON.stringify(fresh.sources) !== JSON.stringify(prepared.before) || JSON.stringify(drafts) !== JSON.stringify(prepared.draftBefore))
      throw new LeagueSheetDriftError('Account replacement sheet before-values changed. Review a fresh preview; nothing was written.');
  }

  async applyAccountReplacement(prepared: PreparedAccountReplacementSheets,
    onWriting: (phase: 'applying_admin' | 'applying_public') => void | Promise<void>): Promise<void> {
    await this.assertAccountReplacementUnchanged(prepared);
    await onWriting('applying_admin');
    // Authorization/member reads in the callback are asynchronous. Prove the
    // sheet values again after them, immediately before the first write.
    try { await this.assertAccountReplacementUnchanged(prepared); }
    catch (error) {
      throw new AccountReplacementNoWriteError(`Account replacement sheet proof changed or became unavailable after authorization. No sheet writes were attempted. ${error instanceof Error ? error.message : ''}`);
    }
    try {
      await this.gateway.batchUpdate(this.config.adminSpreadsheetId, prepared.adminUpdates, 'RAW');
      if (prepared.publicUpdates.length) {
        // Compare this workbook again after the Admin write. Drift now requires reconciliation.
        const ranges = divisions.map((division) => `'${division} Roster'!${PUBLIC_RANGE}`);
        await onWriting('applying_public');
        const current = await this.readRanges(this.config.publicSpreadsheetId, ranges);
        if (divisions.some((division, index) => JSON.stringify(current[index]) !== JSON.stringify(prepared.before.publicByDivision[division])))
          throw new Error('The public roster changed after the Admin write.');
        await this.gateway.batchUpdate(this.config.publicSpreadsheetId, prepared.publicUpdates, 'RAW');
      }
    } catch (error) {
      throw new LeagueSheetReconciliationRequiredError(`Account replacement sheet write may be partial: ${String(error)}`);
    }
  }

  async verifyAccountReplacement(prepared: PreparedAccountReplacementSheets): Promise<{ draftVerification: PreparedAccountReplacementSheets['draftVerification']; sourceFingerprint: string }> {
    const fresh = await this.load([], prepared.freeAgentRoleId);
    const drafts = await this.accountReplacementDraftRows();
    if (JSON.stringify(fresh.snapshot.teams) !== JSON.stringify(parseTeams(prepared.before.teams)))
      throw new LeagueSheetReconciliationRequiredError('Account replacement league role configuration changed. Review League Teams before reconciliation.');
    const captainRoles = (sources: LeagueSheetSources) => {
      const active = new Set(parseTeams(sources.teams).filter(team => team.active).map(team => team.teamRoleId));
      return sources.teams.slice(1).filter(row => active.has(String(row[3] ?? '')))
        .map(row => [String(row[3] ?? ''), String(row[9] ?? '').trim()]);
    };
    if (JSON.stringify(captainRoles(fresh.sources)) !== JSON.stringify(captainRoles(prepared.before)))
      throw new LeagueSheetReconciliationRequiredError('Configured captain access changed. Review current role ownership before reconciliation.');
    // Recovery proves replacement-owned cells, rather than freezing every other
    // player's notes indefinitely. Fresh sources still bind recovery approval.
    for (const update of [...prepared.adminUpdates, ...prepared.publicUpdates]) {
      const address = /^'([^']+)'!([A-Z]+)(\d+)/.exec(update.range);
      if (!address) throw new LeagueSheetReconciliationRequiredError('Account replacement has an invalid owned-cell range.');
      const [, tab, letters, row] = address;
      const column = [...letters!].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1;
      const rows = tab === 'Current Rosters' ? fresh.sources.rosters : tab === 'Player Name History' ? fresh.sources.names
        : tab === 'Draft Picks' ? drafts : fresh.sources.publicByDivision[tab!.replace(/ Roster$/, '') as LeagueDivision];
      const offset = tab === 'Draft Picks' ? 6 : tab!.endsWith(' Roster') ? 1 : 5;
      if (!rows || update.values.some((values, index) => values.some((value, cell) =>
        rows[Number(row) - offset + index]?.[column + cell] !== value)))
        throw new LeagueSheetReconciliationRequiredError('Account replacement read-back does not match the approved sheet values.');
    }
    if ((drafts === null) !== (prepared.draftAfter === null))
      throw new LeagueSheetReconciliationRequiredError('Draft Picks availability changed during replacement.');
    if (drafts) {
      let identities: Map<string, string>;
      try { identities = draftPickIdentityIndex(drafts); }
      catch { throw new LeagueSheetReconciliationRequiredError('Draft Picks historical player attribution is ambiguous.'); }
      const expectedIdentities = draftPickIdentityIndex(prepared.draftAfter ?? []);
      const ids = new Set([prepared.plan.oldDiscordId, prepared.plan.newDiscordId]);
      const ownerRows = (rows: CellRows) => rows.flatMap((row, index) =>
        ids.has(String(row[5] ?? '').trim()) || ids.has(String(row[9] ?? '').trim()) ? [index] : []);
      if ([...ids].some(id => identities.get(id) !== expectedIdentities.get(id))
        || JSON.stringify(ownerRows(drafts)) !== JSON.stringify(ownerRows(prepared.draftAfter ?? [])))
        throw new LeagueSheetReconciliationRequiredError('Replacement Draft Picks identity/status ownership is duplicated or changed.');
      // Older durable plans read round/pick cells with FORMATTED_VALUE. Compare
      // those two non-ID cells consistently; raw identity validation above stays strict.
      const slotProof = (row: CellRows[number] | undefined) => JSON.stringify(row?.map((cell, column) =>
        column === 2 || column === 3 ? String(cell) : cell));
      for (const [index, row] of (prepared.draftAfter ?? []).entries()) {
        if (slotProof(row) !== slotProof(prepared.draftBefore?.[index])
          && slotProof(drafts[index]) !== slotProof(row))
          throw new LeagueSheetReconciliationRequiredError('The replacement draft slot or move status changed.');
      }
    }
    const plan = prepared.plan;
    const roster = fresh.snapshot.rosters.filter((row) => row.discordId === plan.newDiscordId);
    const currentNames = fresh.snapshot.names.filter((row) => row.discordId === plan.newDiscordId && row.nameStatus === 'Current Discord Name');
    const equal = <T extends object>(expected: T, actual: T | undefined) => actual
      && (Object.keys(expected) as Array<keyof T>).every((key) => expected[key] === actual[key]);
    if (roster.length !== 1 || currentNames.length !== 1 || !equal(plan.rosterAfter, roster[0]) || !equal(plan.newName, currentNames[0])
      || fresh.snapshot.rosters.some((row) => row.discordId === plan.oldDiscordId)
      || fresh.snapshot.names.some((row) => row.discordId === plan.oldDiscordId && row.nameStatus === 'Current Discord Name'))
      throw new LeagueSheetReconciliationRequiredError('Account replacement active identity invariants do not match the approved plan.');
    for (const expected of [plan.oldNameAfter, ...plan.preservedHistory.nameRows])
      if (!equal(expected, fresh.snapshot.names.find(row => row.sheetRow === expected.sheetRow)))
        throw new LeagueSheetReconciliationRequiredError('The original account name/alias history changed. Review preserved attribution before reconciliation.');
    const block = publicTeamCells[plan.rosterAfter.franchise];
    const expectedBlock = prepared.after.publicByDivision[plan.rosterAfter.division];
    const currentBlock = fresh.sources.publicByDivision[plan.rosterAfter.division];
    const ownedRows = block && Array.from({ length: block.endRow - block.startRow + 1 }, (_, index) => index + block.startRow - 1);
    const identityRows = ownedRows?.filter(row => value(expectedBlock, row, block!.column) === plan.rosterAfter.player);
    if (identityRows?.length !== 1 || value(currentBlock, identityRows[0]!, block!.column) !== plan.rosterAfter.player
      || ownedRows!.filter(row => value(currentBlock, row, block!.column) === plan.rosterAfter.player).length !== 1)
      throw new LeagueSheetReconciliationRequiredError('The replacement public roster assignment is missing, moved or duplicated.');
    return { draftVerification: prepared.draftVerification,
      sourceFingerprint: createHash('sha256').update(JSON.stringify({ sources: fresh.sources, drafts })).digest('hex') };
  }

  async listRosterPlayers(): Promise<LeagueRosterRow[]> {
    const rows = await this.gateway.getValues(this.config.adminSpreadsheetId, ADMIN_ROSTERS_RANGE, { purpose: 'presentation' });
    return parseRosters(rows);
  }

  async load(discordMembers: DiscordLeagueMember[], freeAgentRoleId: string): Promise<LoadedLeagueSnapshot> {
    const [adminRows, publicRows, selfDropPresentation] = await Promise.all([
      this.readRanges(this.config.adminSpreadsheetId, [ADMIN_TEAMS_RANGE, ADMIN_ROSTERS_RANGE, ADMIN_NAMES_RANGE]),
      this.readRanges(
        this.config.publicSpreadsheetId,
        divisions.map((division) => `'${division} Roster'!${PUBLIC_RANGE}`),
      ),
      this.gateway.getSelfDropPresentation(this.config.adminSpreadsheetId),
    ]);
    const [teams = [], rosters = [], names = []] = adminRows;
    const publicByDivision = Object.fromEntries(
      divisions.map((division, index) => [division, publicRows[index] ?? []]),
    ) as Record<LeagueDivision, CellRows>;
    return {
      snapshot: {
        teams: parseTeams(teams),
        rosters: parseRosters(rosters),
        names: parseNames(names),
        discordMembers,
        publicRosters: Object.fromEntries(
          divisions.map((division) => [division, parsePublic(publicByDivision[division])]),
        ),
        freeAgentRoleId,
      },
      sources: { teams, rosters, names, publicByDivision, selfDropPresentation },
    };
  }

  // Sheets has no server-side Discord-ID predicate. Read the three managed
  // index tables, then only public divisions containing the affected identity.
  // This read-only path never supplies a mutation's before-values.
  async loadMember(
    discordId: string, member: DiscordLeagueMember | null, freeAgentRoleId: string,
  ): Promise<LeagueSnapshot> {
    const [teamRows = [], rosterRows = [], nameRows = []] = await this.readRanges(this.config.adminSpreadsheetId, [
      ADMIN_TEAMS_RANGE,
      ADMIN_ROSTERS_RANGE,
      ADMIN_NAMES_RANGE,
    ]);
    const teams = parseTeams(teamRows);
    const rosters = parseRosters(rosterRows);
    const names = parseNames(nameRows);
    const affectedDivisions = [
      ...new Set([
      ...rosters.filter((row) => row.discordId === discordId).map((row) => row.division),
      ...names.filter((row) => row.discordId === discordId).map((row) => row.division),
      ...teams
          .filter((team) => member?.roleIds.includes(team.teamRoleId) || member?.roleIds.includes(team.divisionRoleId))
          .map((team) => team.division),
    ]),
    ];
    const publicRows = await this.readRanges(
      this.config.publicSpreadsheetId,
      affectedDivisions.map((division) => `'${division} Roster'!${PUBLIC_RANGE}`),
    );
    const publicRosters = Object.fromEntries(
      affectedDivisions.map((division, index) => [division,
      parsePublic(publicRows[index] ?? [])]),
    );
    return { teams, rosters, names, discordMembers: member ? [member] : [], publicRosters, freeAgentRoleId };
  }

  async assertUnchanged(loaded: LoadedLeagueSnapshot): Promise<void> {
    let fresh: LoadedLeagueSnapshot;
    try {
      fresh = await this.load(loaded.snapshot.discordMembers, loaded.snapshot.freeAgentRoleId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new LeagueSheetDriftError(`League sheets became unreadable after the audit. Nothing was written: ${detail}`);
    }
    const changed = JSON.stringify(fresh.sources) !== JSON.stringify(loaded.sources);
    if (changed) throw new LeagueSheetDriftError('League sheets changed after the audit. Nothing was written; run the command again.');
  }

  private resolvePublicChanges(loaded: LoadedLeagueSnapshot, changes: PublicRosterChange[]): SheetValueUpdate[] {
    const claimed = new Set<string>();
    return changes.map((change) => {
      const rows = loaded.sources.publicByDivision[change.division];
      const cells = change.area === 'team' ? [publicTeamCells[change.group]] : freeAgentCells;
      if (!cells[0]) throw new Error(`No managed public roster block exists for ${change.group}.`);
      let match: { row: number; column: number } | undefined;
      for (const cell of cells as { column: number; startRow: number; endRow: number }[]) {
        for (let row = cell.startRow; row <= cell.endRow; row += 1) {
          const key = `${change.division}:${row}:${cell.column}`;
          if (!claimed.has(key) && value(rows, row - 1, cell.column) === change.from) {
            if (change.from === '') { match = { row, column: cell.column }; break; }
            if (match) throw new Error(`${change.from} appears more than once in the managed ${change.group} block.`);
            match = { row, column: cell.column };
          }
        }
        if (change.from === '' && match) break;
      }
      if (!match) throw new Error(`${change.from || 'No empty slot'} was found in the managed ${change.group} block.`);
      claimed.add(`${change.division}:${match.row}:${match.column}`);
      const column = String.fromCharCode(65 + match.column);
      return { range: `'${change.division} Roster'!${column}${match.row}`, values: [[change.to]] };
    });
  }

  prepare(loaded: LoadedLeagueSnapshot, plan: LeagueMutationPlan): PreparedLeagueSheetMutation {
    const prepared: PreparedLeagueSheetMutation = { publicUpdates: this.resolvePublicChanges(loaded, plan.publicChanges) };
    if (plan.kind === 'self-drop') {
      const expectedLegend = ['Red row', 'Self-Drop: suspended for the current season and banned for the next YSL season.'];
      const actualLegend = loaded.sources.selfDropPresentation.legend[0] ?? [];
      const legendBlank = actualLegend.every((cell) => String(cell ?? '').trim() === '');
      const legendMatches = expectedLegend.every((cell, index) => String(actualLegend[index] ?? '') === cell);
      if (!legendBlank && !legendMatches) {
        throw new LeagueSheetDriftError('Player Name History legend cells J4:K4 are occupied by unexpected values. Nothing was written.');
      }
      prepared.selfDropPresentation = {
        sheetId: loaded.sources.selfDropPresentation.sheetId,
        writeLegend: !legendMatches,
        addRule: !loaded.sources.selfDropPresentation.ruleExists,
      };
    }
    return prepared;
  }

  async apply(
    loaded: LoadedLeagueSnapshot,
    plan: LeagueMutationPlan,
    record: LeagueTransactionRecord,
    prepared: PreparedLeagueSheetMutation,
  ): Promise<void> {
    await this.assertUnchanged(loaded);
    const originalRosters = loaded.snapshot.rosters;
    const now = `${record.effectiveDate}T00:00:00.000Z`;
    const approvalNote = record.approvalNote ?? 'Ratatoskr approved transaction';
    const rosterValue = (row: LeagueRosterRow): Cell[] => [
      row.division, row.franchise, row.teamRoleId, row.team, row.discordId, row.player,
      row.rosterStatus, 'OK', approvalNote, now,
    ];
    const nextBySheetRow = new Map(plan.rosters.map((row) => [row.sheetRow, row]));
    const originalBySheetRow = new Map(originalRosters.map((row) => [row.sheetRow, row]));
    const adminUpdates: SheetValueUpdate[] = [];
    const nameHistoryAppendRow = plan.nameHistoryAppend ? loaded.sources.names.length + 5 : undefined;
    const nameHistoryAppendValues: Cell[] | undefined = plan.nameHistoryAppend ? [
      plan.nameHistoryAppend.discordId,
      plan.nameHistoryAppend.currentLeagueName,
      plan.nameHistoryAppend.knownName,
      plan.nameHistoryAppend.nameStatus,
      plan.nameHistoryAppend.division,
      plan.nameHistoryAppend.franchise,
      plan.nameHistoryAppend.leagueStatus,
      record.effectiveDate,
      record.effectiveDate,
      approvalNote,
      'Preserved so historical stats continue matching this player.',
    ] : undefined;
    for (const previous of originalRosters) {
      const next = nextBySheetRow.get(previous.sheetRow);
      if (!next) {
        adminUpdates.push({ range: `'Current Rosters'!A${previous.sheetRow}:J${previous.sheetRow}`, values: [Array(10).fill('')] });
      } else if (JSON.stringify(rosterValue(previous).slice(0, 7)) !== JSON.stringify(rosterValue(next).slice(0, 7))) {
        adminUpdates.push({ range: `'Current Rosters'!A${previous.sheetRow}:J${previous.sheetRow}`, values: [rosterValue(next)] });
      }
    }
    for (const next of plan.rosters) {
      if (!originalBySheetRow.has(next.sheetRow)) {
        adminUpdates.push({ range: `'Current Rosters'!A${next.sheetRow}:J${next.sheetRow}`, values: [rosterValue(next)] });
      }
    }

    for (const next of plan.nameUpdates) {
      const previous = loaded.snapshot.names.find((row) => row.sheetRow === next.sheetRow);
      if (!previous) throw new Error(`Player Name History row ${next.sheetRow} disappeared.`);
      if (previous.currentLeagueName !== next.currentLeagueName) {
        adminUpdates.push({ range: `'Player Name History'!B${next.sheetRow}`, values: [[next.currentLeagueName]] });
      }
      if (previous.division !== next.division || previous.franchise !== next.franchise || previous.leagueStatus !== next.leagueStatus) {
        adminUpdates.push({ range: `'Player Name History'!E${next.sheetRow}:G${next.sheetRow}`, values: [[next.division, next.franchise, next.leagueStatus]] });
      }
    }
    if (nameHistoryAppendRow && nameHistoryAppendValues) {
      adminUpdates.push({
        range: `'Player Name History'!A${nameHistoryAppendRow}:K${nameHistoryAppendRow}`,
        values: [nameHistoryAppendValues],
      });
    }

    try {
      await this.gateway.batchUpdate(this.config.adminSpreadsheetId, adminUpdates, 'RAW');
      await this.gateway.batchUpdate(this.config.publicSpreadsheetId, prepared.publicUpdates, 'RAW');
      if (prepared.selfDropPresentation) {
        await this.gateway.ensureSelfDropPresentation(this.config.adminSpreadsheetId, prepared.selfDropPresentation);
      }

      const verification = await this.load(loaded.snapshot.discordMembers, loaded.snapshot.freeAgentRoleId);
      const expectedPublic = structuredClone(loaded.snapshot.publicRosters);
      for (const change of plan.publicChanges) {
        const target = change.area === 'team'
          ? expectedPublic[change.division]!.teams[change.group]!
          : expectedPublic[change.division]!.freeAgents;
        const index = target.indexOf(change.from);
        if (change.from === '') target.push(change.to);
        else if (change.to === '') target.splice(index, 1);
        else target[index] = change.to;
      }
      const rosterProjection = (rows: LeagueRosterRow[]) => rows.map((row) => ({
        division: row.division,
        franchise: row.franchise,
        teamRoleId: row.teamRoleId,
        team: row.team,
        discordId: row.discordId,
        player: row.player,
        rosterStatus: row.rosterStatus,
      }));
      const namesMatch = plan.nameUpdates.every((expected) => {
        const actual = verification.snapshot.names.find((row) => row.sheetRow === expected.sheetRow);
        return actual?.discordId === expected.discordId
          && actual.currentLeagueName === expected.currentLeagueName
          && actual.division === expected.division
          && actual.franchise === expected.franchise
          && actual.leagueStatus === expected.leagueStatus;
      });
      const historyMatches = !nameHistoryAppendRow || !nameHistoryAppendValues
        || JSON.stringify((verification.sources.names[nameHistoryAppendRow - 5] ?? []).slice(0, 11))
          === JSON.stringify(nameHistoryAppendValues);
      const presentationMatches = plan.kind !== 'self-drop'
        || (verification.sources.selfDropPresentation.ruleExists
          && verification.sources.selfDropPresentation.legend[0]?.[0] === 'Red row'
          && verification.sources.selfDropPresentation.legend[0]?.[1]
            === 'Self-Drop: suspended for the current season and banned for the next YSL season.');
      if (JSON.stringify(rosterProjection(plan.rosters)) !== JSON.stringify(rosterProjection(verification.snapshot.rosters))
        || !namesMatch
        || !historyMatches
        || !presentationMatches
        || !samePublicRosters(expectedPublic, verification.snapshot.publicRosters)) {
        throw new Error('Post-write values do not match the approved league change.');
      }
    } catch (error) {
      throw new LeagueSheetReconciliationRequiredError(
        `League sheet mutation may be partial: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async appendTransactionHistory(
    plan: LeagueMutationPlan,
    record: LeagueTransactionRecord,
  ): Promise<DraftPickMove[]> {
    const existing = await this.gateway.getValues(this.config.adminSpreadsheetId, "'Transaction History'!A6:A");
    if (existing.some((row) => String(row[0] ?? '') === record.reference)) return [];
    const exitDestination = plan.kind === 'drop'
      ? 'Free Agents'
      : plan.kind === 'departure' ? 'Inactive'
        : plan.kind === 'self-drop' ? SELF_DROP_LEAGUE_STATUS : undefined;
    const transactionRows = exitDestination ? [
      [
        record.reference, plan.kind, record.effectiveDate, plan.teams[0]!.division,
        plan.teams[0]!.franchise, exitDestination, plan.playerIds[0]!, plan.players[0]!,
        record.processedById, record.announcementId ?? '', 'Completed', record.processedBy,
      ],
      ...(plan.playerIds[1] ? [[
        record.reference, plan.kind, record.effectiveDate, plan.teams[0]!.division,
        'Free Agents', plan.teams[0]!.franchise, plan.playerIds[1], plan.players[1]!,
        record.processedById, record.announcementId ?? '', 'Completed', record.processedBy,
      ]] : []),
    ] : plan.discordRoleChanges.length > 0 ? plan.discordRoleChanges.map((change, index) => {
      const from = plan.teams.find((team) => change.remove.includes(team.teamRoleId));
      const to = plan.teams.find((team) => change.add.includes(team.teamRoleId));
      return [
        record.reference, plan.kind, record.effectiveDate, from?.division ?? to?.division ?? '',
        from?.franchise ?? (plan.kind === 'pickup' ? 'Free Agents' : ''),
        to?.franchise ?? (plan.kind === 'drop' ? 'Free Agents' : ''),
        change.discordId, plan.players[index] ?? plan.players[0] ?? '', record.processedById,
        record.announcementId ?? '', 'Completed', record.processedBy,
      ];
    }) : [[
      record.reference, plan.kind, record.effectiveDate,
      plan.teams[0]?.division ?? plan.publicChanges[0]?.division ?? '', '', '',
      plan.playerIds[0] ?? '',
      plan.players[0] ?? '', record.processedById, record.announcementId ?? '', 'Completed', record.processedBy,
    ]];
    const tracking = plan.kind === 'rename' ? undefined : await this.loadDraftPicks();
    const picks = tracking?.picks ?? new Map<string, DraftPickMove>();
    const moved = new Map<string, DraftPickMove>();
    for (const row of transactionRows) {
      const pick = picks.get(String(row[6] ?? ''));
      // The transaction row carries the current name; Draft Picks may predate a rename.
      if (pick) moved.set(pick.discordId, { ...pick, player: String(row[7] ?? '') || pick.player });
      // Column M drives the Transaction History yellow conditional-format rule.
      row.push(pick ? draftPickLabel(pick) : !tracking || tracking.health.status === 'ready' ? ''
        : tracking.health.status === 'missing-tab' ? 'Not verified: Draft Picks tab missing'
          : tracking.health.status === 'empty-tab' ? 'Not verified: Draft Picks empty' : 'Not verified: Draft Picks incomplete');
    }
    // Status first: the history row is the idempotency marker, so anything written after it
    // would be skipped by recovery. Rewriting the same status on retry is harmless.
    if (moved.size) {
      await this.gateway.batchUpdate(this.config.adminSpreadsheetId, [...moved.values()].map((pick) => ({
        range: `'Draft Picks'!I${pick.sheetRow}:J${pick.sheetRow}`,
        values: [[`Moved · ${plan.kind} · ${record.reference}`, pick.discordId]],
      })), 'RAW');
    }
    if (transactionRows.some(row => Boolean(row[12]))) {
      if (!this.gateway.ensureDraftPickHighlights) throw new Error('Draft highlight delivery is unavailable; retain pending history for recovery.');
      await this.gateway.ensureDraftPickHighlights(this.config.adminSpreadsheetId, this.config.publicSpreadsheetId, [...moved.values()]);
    }
    await this.gateway.append(this.config.adminSpreadsheetId, "'Transaction History'!A:M", transactionRows, 'RAW');
    return [...moved.values()];
  }

  private async loadDraftPicks(): Promise<{ picks: Map<string, DraftPickMove>; health: DraftPickHealth }> {
    const { rows, health } = await this.readDraftTracking();
    const picks = new Map<string, DraftPickMove>();
    if (health.status === 'missing-tab') return { picks, health };
    if (!rows) throw new DraftPickTrackingError(health);
    const identities = draftPickIdentityIndex(rows);
    rows.forEach((row, index) => {
      const discordId = String(row[5] ?? '').trim();
      if (!discordId) return;
      picks.set(discordId, {
        discordId,
        player: String(row[6] ?? '').trim() || String(row[4] ?? '').trim(),
        division: String(row[0] ?? '').trim(),
        team: String(row[1] ?? '').trim(),
        round: String(row[2] ?? '').trim(),
        pick: String(row[3] ?? '').trim(),
        sheetRow: index + 6,
      });
    });
    for (const [historicalId, currentId] of identities) {
      const pick = picks.get(currentId);
      if (pick) picks.set(historicalId, pick);
    }
    return { picks, health };
  }
}
