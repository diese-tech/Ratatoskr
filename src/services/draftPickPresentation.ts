import { DRAFT_DIVISIONS } from './draftPicks.js';

export type DraftHighlightSlot = { division: string; team: string; round: string | number };
export const PUBLIC_TEAM_CELLS: Record<string, { column: number; startRow: number; endRow: number }> = {
  'Dream Walkers': { column: 2, startRow: 5, endRow: 11 },
  'Eternal Vanguard': { column: 6, startRow: 5, endRow: 11 },
  'Little Monsters': { column: 10, startRow: 5, endRow: 11 },
  'Something Spicy': { column: 14, startRow: 5, endRow: 11 },
  'The Rat Pack': { column: 2, startRow: 16, endRow: 22 },
  'The Sewer': { column: 6, startRow: 16, endRow: 22 },
  'Valhalla Vikings': { column: 10, startRow: 16, endRow: 22 },
  'Wailing Banshees': { column: 14, startRow: 16, endRow: 22 },
};
export const DRAFT_HISTORY_RULE = '=$M6<>""';
export const DRAFT_NAME_YELLOW = { red: 1, green: 1, blue: 0 };
export const DRAFT_ROW_YELLOW = { red: 1, green: 0.95, blue: 0.6 };
export type DraftHistoryRule = {
  ranges?: Array<{ sheetId?: number; startRowIndex?: number; endRowIndex?: number; startColumnIndex?: number; endColumnIndex?: number }>;
  booleanRule?: { condition?: { type?: string; values?: Array<{ userEnteredValue?: string }> }; format?: { backgroundColorStyle?: { rgbColor?: Partial<typeof DRAFT_ROW_YELLOW> } } };
};
export function hasDraftHistoryRule(sheetId: number, rules: DraftHistoryRule[] = []): boolean {
  return rules.some(rule => rule.booleanRule?.condition?.type === 'CUSTOM_FORMULA'
    && rule.booleanRule.condition.values?.[0]?.userEnteredValue === DRAFT_HISTORY_RULE
    && (['red', 'green', 'blue'] as const).every(channel => Math.abs((rule.booleanRule?.format?.backgroundColorStyle?.rgbColor?.[channel] ?? 0) - DRAFT_ROW_YELLOW[channel]) < 0.000001)
    && rule.ranges?.length === 1 && rule.ranges[0]?.sheetId === sheetId && rule.ranges[0]?.startRowIndex === 5
    && rule.ranges[0]?.endRowIndex === undefined && (rule.ranges[0]?.startColumnIndex ?? 0) === 0 && rule.ranges[0]?.endColumnIndex === 13);
}
export function publicDraftHighlightCells(slots: DraftHighlightSlot[], grids: Record<string, (string | number | boolean | null)[][]>) {
  const cells = new Map<string, { title: string; row: number; column: number; range: string }>();
  for (const slot of slots) {
    const block = PUBLIC_TEAM_CELLS[slot.team], round = Number(slot.round), grid = grids[slot.division];
    if (!DRAFT_DIVISIONS.includes(slot.division as typeof DRAFT_DIVISIONS[number]) || !block
      || !Number.isInteger(round) || round < 1 || round > 4 || !grid)
      throw new Error('Protected draft slot cannot be mapped to an owned public roster cell.');
    const row = block.startRow + round, column = block.column;
    if (String(grid[block.startRow - 3]?.[column - 1] ?? '').trim() !== slot.team
      || String(grid[block.startRow - 1]?.[column - 1] ?? '').trim() !== 'Cap:'
      || Number(grid[row - 1]?.[column - 1]) !== round)
      throw new Error('Public roster draft-slot layout changed. Review the original team/round before highlighting.');
    const title = `${slot.division} Roster`, range = `'${title}'!${String.fromCharCode(65 + column)}${row}`;
    cells.set(range, { title, row, column, range });
  }
  return [...cells.values()].sort((a, b) => a.range.localeCompare(b.range));
}
export function draftNameColorRequest(cell: { sheetId: number; row: number; column: number }) {
  return { repeatCell: {
    range: { sheetId: cell.sheetId, startRowIndex: cell.row - 1, endRowIndex: cell.row, startColumnIndex: cell.column, endColumnIndex: cell.column + 1 },
    cell: { userEnteredFormat: { textFormat: { foregroundColorStyle: { rgbColor: DRAFT_NAME_YELLOW } } } },
    fields: 'userEnteredFormat.textFormat.foregroundColorStyle',
  } };
}
