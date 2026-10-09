// Builds the Admin 'Draft Picks' tab: each captain's first four draft picks (rounds 1-4,
// not the Cap: line), resolved to Discord IDs. Pure logic; scripts/seed-draft-picks.ts does I/O.

type Cell = string | number | boolean | null;
type Rows = Cell[][];

export const DRAFT_DIVISIONS = ['Vanaheim', 'Alfheim', 'Svartalfheim'] as const;
export const PROTECTED_ROUNDS = 4;
export const DRAFT_PICK_HEADERS = [
  'Division', 'Team', 'Round', 'Pick #', 'Draft Name', 'Discord ID', 'Current League Name', 'Match Source', 'Status', 'Status For ID',
];

export type DraftPick = { division: string; team: string; round: number; pick: string; draftName: string };
export type ResolvedDraftPick = DraftPick & {
  discordId: string; currentName: string; matchSource: string; status: string;
};

const text = (rows: Rows, row: number, column: number) => String(rows[row]?.[column] ?? '').trim();

// Draft tabs repeat the roster grid: team header two rows above 'Cap:' in the Pick column,
// then one row per round with the snake pick number in the Pick column and the name beside it.
export function parseDraftTab(division: string, rows: Rows): DraftPick[] {
  const picks: DraftPick[] = [];
  rows.forEach((row, rowIndex) => row.forEach((cell, column) => {
    if (String(cell ?? '').trim() !== 'Cap:') return;
    const team = text(rows, rowIndex - 2, column);
    for (let round = 1; round <= PROTECTED_ROUNDS; round += 1) {
      const draftName = text(rows, rowIndex + round, column + 1);
      if (draftName) picks.push({ division, team, round, pick: text(rows, rowIndex + round, column), draftName });
    }
  }));
  return picks;
}

// Draft names drift from league names ("Veroxas" vs "Veroxas (mist)", case changes).
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

export type NameSources = {
  vetting: Rows;          // FinalizedVetting!A2:D  (draft, division, Draft Name, Discord Name)
  memberDirectory: Rows;  // Member Directory!A6:D  (Discord ID, Username, Profile Name, Server Display Name)
  nameHistory: Rows;      // Player Name History!A6:C (Discord ID, Current League Name, Known Name)
  rosters: Rows;          // Current Rosters!A6:F   (Division, Franchise, Team Role ID, Team, Discord ID, Player)
  history?: Rows;         // Transaction History!A6:M (Reference, Move, Effective Date, ..., Discord ID in G)
  since?: string;         // ignore history before this YYYY-MM-DD (the draft)
};

function uniqueIndex(entries: Array<[string, string]>): Map<string, string> {
  const index = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [key, id] of entries) {
    if (!key || !id) continue;
    if (index.has(key) && index.get(key) !== id) ambiguous.add(key);
    else index.set(key, id);
  }
  for (const key of ambiguous) index.delete(key);
  return index;
}

// Staff corrections win when re-seeding: an existing Discord ID (typed in by hand) and a
// runtime 'Moved · <move> · <reference>' status from the current tab are kept.
export function resolveDraftPicks(picks: DraftPick[], sources: NameSources, existing: Rows = []): ResolvedDraftPick[] {
  // Keyed by draft name too, so reusing the draft tabs next season never carries a slot's old player over.
  const slotKey = (division: unknown, team: unknown, round: unknown, draftName: unknown) =>
    `${division}|${team}|${round}|${normalizeName(String(draftName ?? ''))}`;
  const previous = new Map(existing.map((row) => [slotKey(row[0], row[1], row[2], row[4]), row]));
  const byUsername = uniqueIndex(sources.memberDirectory.map((row) => [String(row[1] ?? '').trim().toLowerCase(), String(row[0] ?? '').trim()]));
  const vettingDiscordName = uniqueIndex(sources.vetting.map((row) => [normalizeName(String(row[2] ?? '')), String(row[3] ?? '').trim().toLowerCase()]));
  const byLeagueName = uniqueIndex(sources.nameHistory.flatMap((row) => [
    [normalizeName(String(row[1] ?? '')), String(row[0] ?? '').trim()] as [string, string],
    [normalizeName(String(row[2] ?? '')), String(row[0] ?? '').trim()] as [string, string],
  ]));
  const byDisplayName = uniqueIndex(sources.memberDirectory.flatMap((row) => [
    [normalizeName(String(row[2] ?? '')), String(row[0] ?? '').trim()] as [string, string],
    [normalizeName(String(row[3] ?? '')), String(row[0] ?? '').trim()] as [string, string],
  ]));
  const currentName = new Map(sources.nameHistory.map((row) => [String(row[0] ?? '').trim(), String(row[1] ?? '').trim()]));
  const rostered = new Map(sources.rosters.map((row) => [String(row[4] ?? '').trim(), {
    division: String(row[0] ?? '').trim(), franchise: String(row[1] ?? '').trim(), teamRole: String(row[3] ?? '').trim(),
  }]));

  const historyMoves = new Map<string, string>();
  for (const row of sources.history ?? []) {
    const [reference, move, date, discordId] = [row[0], row[1], row[2], row[6]].map((cell) => String(cell ?? '').trim());
    if (discordId && move && move !== 'rename' && date >= (sources.since ?? '')) historyMoves.set(discordId, `Moved · ${move} · ${reference}`);
  }
  return picks.map((pick) => {
    const key = normalizeName(pick.draftName);
    const username = vettingDiscordName.get(key);
    const candidates: Array<[string, string | undefined]> = [
      ['Vetting → Member Directory', username ? byUsername.get(username) : undefined],
      ['Player Name History', byLeagueName.get(key)],
      ['Member Directory name', byDisplayName.get(key)],
    ];
    const kept = previous.get(slotKey(pick.division, pick.team, pick.round, pick.draftName));
    const keptId = String(kept?.[5] ?? '').trim();
    const keptStatus = String(kept?.[8] ?? '').trim();
    const keptStatusId = String(kept?.[9] ?? '').trim();
    const found = candidates.find(([, id]) => id) ?? ['UNRESOLVED', ''];
    const [matchSource, discordId] = keptId && keptId !== found[1]
      ? [String(kept?.[7] ?? '').trim() === 'UNRESOLVED' ? 'Manual' : String(kept?.[7] ?? '').trim() || 'Manual', keptId]
      : found;
    const current = discordId ? rostered.get(discordId) : undefined;
    // Once moved, always moved: a later return to the drafted team must not erase the record.
    // Column J names the player a status was recorded for, so an ID correction never inherits it.
    const keptApplies = keptStatus.startsWith('Moved ·') && keptStatusId === discordId;
    const status = keptApplies ? keptStatus
      : discordId && historyMoves.has(discordId) ? historyMoves.get(discordId)!
      : !discordId ? 'Unknown'
      // Draft headers name the franchise today; accept the division-suffixed team role too.
      : current?.division === pick.division && [current.franchise, current.teamRole].includes(pick.team) ? 'On drafted team'
        : `Moved · before tracking · now ${current ? `${current.division} ${current.franchise}` : 'not rostered'}`;
    return { ...pick, discordId: discordId ?? '', currentName: discordId ? currentName.get(discordId) ?? '' : '', matchSource, status };
  });
}

export function draftPickRow(pick: ResolvedDraftPick): Cell[] {
  return [pick.division, pick.team, pick.round, pick.pick, pick.draftName, pick.discordId, pick.currentName, pick.matchSource, pick.status,
    pick.status.startsWith('Moved') ? pick.discordId : ''];
}

// Each division must yield 8 distinct teams with rounds 1-4 exactly once; a stray or duplicated
// Cap: block can otherwise hide a missing team behind a correct total. With rosters, team names
// must also be that division's franchises (or team roles), so a mistyped header cannot replace one.
export function draftParseProblems(picks: DraftPick[], rosters: Rows = []): string[] {
  return DRAFT_DIVISIONS.flatMap((division) => {
    const teams = new Map<string, number[]>();
    for (const pick of picks.filter((candidate) => candidate.division === division))
      teams.set(pick.team, [...(teams.get(pick.team) ?? []), pick.round]);
    const problems = teams.size === 8 ? [] : [`${division}: ${teams.size} teams parsed, expected 8`];
    if (teams.has('')) problems.push(`${division}: a Cap: block has a blank team header`);
    const known = new Set(rosters.filter((row) => String(row[0] ?? '').trim() === division)
      .flatMap((row) => [String(row[1] ?? '').trim(), String(row[3] ?? '').trim()]));
    if (known.size) for (const team of teams.keys())
      if (team && !known.has(team)) problems.push(`${division}: "${team}" is not a team in Current Rosters`);
    for (const [team, rounds] of teams)
      if ([...rounds].sort().join() !== '1,2,3,4') problems.push(`${division} ${team || '(blank team)'}: rounds ${rounds.join(',')}`);
    return problems;
  });
}
