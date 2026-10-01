import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import {
  type DiscordLeagueMember,
  type LeagueDivision,
  type LeagueMutationPlan,
  type LeagueNameRow,
  type LeagueRosterRow,
  type LeagueSnapshot,
  type LeagueTeam,
  type PublicRosterChange,
} from '../domain/leagueOperations.js';

type Cell = string | number | boolean | null;
type CellRows = Cell[][];

export type SheetValueUpdate = { range: string; values: CellRows };

export interface LeagueSheetsGateway {
  getValues(spreadsheetId: string, range: string): Promise<CellRows>;
  batchUpdate(spreadsheetId: string, updates: SheetValueUpdate[], valueInputOption?: 'RAW' | 'USER_ENTERED'): Promise<void>;
  append(spreadsheetId: string, range: string, values: CellRows, valueInputOption?: 'RAW' | 'USER_ENTERED'): Promise<void>;
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

  const request = async <T>(options: { url: string; method?: 'GET' | 'POST'; data?: unknown }): Promise<T> => {
    const client = await auth.getClient();
    const response = await client.request<T>(options);
    return response.data;
  };
  const gateway: LeagueSheetsGateway = {
    async getValues(spreadsheetId, range) {
      const encoded = encodeURIComponent(range);
      const data = await request<{ values?: CellRows }>({
        url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encoded}?valueRenderOption=FORMATTED_VALUE`,
      });
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
  };
  return {
    gateway,
    config: {
      adminSpreadsheetId: parsed.YSL_ADMIN_SPREADSHEET_ID,
      publicSpreadsheetId: parsed.YSL_PUBLIC_SPREADSHEET_ID,
    },
  };
}

const ADMIN_TEAMS_RANGE = "'League Teams'!A5:L100";
const ADMIN_ROSTERS_RANGE = "'Current Rosters'!A5:J1000";
const ADMIN_NAMES_RANGE = "'Player Name History'!A5:K1000";
const PUBLIC_RANGE = 'A1:O99';

const divisions = ['Vanaheim', 'Alfheim', 'Svartalfheim'] as const;
const publicTeamCells: Record<string, { column: number; startRow: number; endRow: number }> = {
  'Dream Walkers': { column: 2, startRow: 5, endRow: 11 },
  'Eternal Vanguard': { column: 6, startRow: 5, endRow: 11 },
  'Little Monsters': { column: 10, startRow: 5, endRow: 11 },
  'Something Spicy': { column: 14, startRow: 5, endRow: 11 },
  'The Rat Pack': { column: 2, startRow: 16, endRow: 22 },
  'The Sewer': { column: 6, startRow: 16, endRow: 22 },
  'Valhalla Vikings': { column: 10, startRow: 16, endRow: 22 },
  'Wailing Banshees': { column: 14, startRow: 16, endRow: 22 },
};

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
};

export type LoadedLeagueSnapshot = { snapshot: LeagueSnapshot; sources: LeagueSheetSources };

export type LeagueTransactionRecord = {
  reference: string;
  effectiveDate: string;
  processedById: string;
  processedBy: string;
  announcementId?: string;
};

export type PreparedLeagueSheetMutation = {
  publicUpdates: SheetValueUpdate[];
};

export class LeagueSheetDriftError extends Error {}
export class LeagueSheetReconciliationRequiredError extends Error {}

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
      throw new Error(`Player Name History row ${index + 6} is populated but has no Discord ID.`);
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

export class LeagueSheetsService {
  constructor(private readonly gateway: LeagueSheetsGateway, private readonly config: LeagueSheetsConfig) {}

  async load(discordMembers: DiscordLeagueMember[], freeAgentRoleId: string): Promise<LoadedLeagueSnapshot> {
    const [teams, rosters, names, ...publicRows] = await Promise.all([
      this.gateway.getValues(this.config.adminSpreadsheetId, ADMIN_TEAMS_RANGE),
      this.gateway.getValues(this.config.adminSpreadsheetId, ADMIN_ROSTERS_RANGE),
      this.gateway.getValues(this.config.adminSpreadsheetId, ADMIN_NAMES_RANGE),
      ...divisions.map((division) => this.gateway.getValues(this.config.publicSpreadsheetId, `'${division} Roster'!${PUBLIC_RANGE}`)),
    ]);
    const publicByDivision = Object.fromEntries(divisions.map((division, index) => [division, publicRows[index] ?? []])) as Record<LeagueDivision, CellRows>;
    return {
      snapshot: {
        teams: parseTeams(teams),
        rosters: parseRosters(rosters),
        names: parseNames(names),
        discordMembers,
        publicRosters: Object.fromEntries(divisions.map((division) => [division, parsePublic(publicByDivision[division])])),
        freeAgentRoleId,
      },
      sources: { teams, rosters, names, publicByDivision },
    };
  }

  async assertUnchanged(loaded: LoadedLeagueSnapshot): Promise<void> {
    const fresh = await this.load(loaded.snapshot.discordMembers, loaded.snapshot.freeAgentRoleId);
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
    return { publicUpdates: this.resolvePublicChanges(loaded, plan.publicChanges) };
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
    const rosterValue = (row: LeagueRosterRow): Cell[] => [
      row.division, row.franchise, row.teamRoleId, row.team, row.discordId, row.player,
      row.rosterStatus, 'OK', 'Ratatoskr approved transaction', now,
    ];
    const nextByPlayer = new Map(plan.rosters.map((row) => [row.discordId, row]));
    const originalByPlayer = new Map(originalRosters.map((row) => [row.discordId, row]));
    const adminUpdates: SheetValueUpdate[] = [];
    for (const previous of originalRosters) {
      const next = nextByPlayer.get(previous.discordId);
      if (!next) {
        adminUpdates.push({ range: `'Current Rosters'!A${previous.sheetRow}:J${previous.sheetRow}`, values: [Array(10).fill('')] });
      } else if (JSON.stringify(rosterValue(previous).slice(0, 7)) !== JSON.stringify(rosterValue(next).slice(0, 7))) {
        adminUpdates.push({ range: `'Current Rosters'!A${previous.sheetRow}:J${previous.sheetRow}`, values: [rosterValue(next)] });
      }
    }
    for (const next of plan.rosters) {
      if (!originalByPlayer.has(next.discordId)) {
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

    try {
      await this.gateway.batchUpdate(this.config.adminSpreadsheetId, adminUpdates, 'RAW');
      await this.gateway.batchUpdate(this.config.publicSpreadsheetId, prepared.publicUpdates, 'RAW');

      if (plan.nameHistoryAppend) {
        const row = plan.nameHistoryAppend;
        await this.gateway.append(this.config.adminSpreadsheetId, "'Player Name History'!A:K", [[
          row.discordId, row.currentLeagueName, row.knownName, row.nameStatus, row.division, row.franchise,
          row.leagueStatus, record.effectiveDate, record.effectiveDate, 'Ratatoskr approved rename',
          'Preserved so historical stats continue matching this player.',
        ]], 'RAW');
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
      if (JSON.stringify(rosterProjection(plan.rosters)) !== JSON.stringify(rosterProjection(verification.snapshot.rosters))
        || !namesMatch
        || !samePublicRosters(expectedPublic, verification.snapshot.publicRosters)) {
        throw new Error('Post-write values do not match the approved transaction.');
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
  ): Promise<void> {
    const existing = await this.gateway.getValues(this.config.adminSpreadsheetId, "'Transaction History'!A6:A");
    if (existing.some((row) => String(row[0] ?? '') === record.reference)) return;
    const transactionRows = plan.discordRoleChanges.length > 0 ? plan.discordRoleChanges.map((change, index) => {
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
    await this.gateway.append(this.config.adminSpreadsheetId, "'Transaction History'!A:L", transactionRows, 'RAW');
  }
}
