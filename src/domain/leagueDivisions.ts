// The single list of league divisions Rat manages (#197). Everything that names
// a division (types, sheet tabs, audit wording, sort order) derives from here.
// Niflheim is a temporary division layered on Svartalfheim (#195). It is inert
// until League Teams has an active Niflheim team, so removing it later means
// deactivating those rows; deleting it from this list is the code cleanup.

export const LEAGUE_DIVISIONS = ['Vanaheim', 'Alfheim', 'Svartalfheim', 'Niflheim'] as const;

export type LeagueDivision = (typeof LEAGUE_DIVISIONS)[number];

export type LeagueDivisionMetadata = {
  publicTab: string;
  // Niflheim has no free agents of its own; its pickups come from the Svartalfheim pool.
  hasPublicFreeAgentList: boolean;
  // A layered membership sits on top of the player's record in this division (#198).
  layeredOn?: LeagueDivision;
};

export const LEAGUE_DIVISION_METADATA: Record<LeagueDivision, LeagueDivisionMetadata> = {
  Vanaheim: { publicTab: 'Vanaheim Roster', hasPublicFreeAgentList: true },
  Alfheim: { publicTab: 'Alfheim Roster', hasPublicFreeAgentList: true },
  Svartalfheim: { publicTab: 'Svartalfheim Roster', hasPublicFreeAgentList: true },
  Niflheim: { publicTab: 'Niflheim Roster', hasPublicFreeAgentList: false, layeredOn: 'Svartalfheim' },
};

export function isLeagueDivision(input: string): input is LeagueDivision {
  return (LEAGUE_DIVISIONS as readonly string[]).includes(input);
}

export function parseLeagueDivision(input: string): LeagueDivision {
  if (isLeagueDivision(input)) return input;
  throw new Error(`Unsupported league division: ${input || '(blank)'}.`);
}

// Sort position follows LEAGUE_DIVISIONS; unknown names sort last.
export function compareDivisions(left: string, right: string): number {
  const rank = (division: string) => {
    const index = (LEAGUE_DIVISIONS as readonly string[]).indexOf(division);
    return index === -1 ? LEAGUE_DIVISIONS.length : index;
  };
  return rank(left) - rank(right);
}

// Regex source for "one division name", e.g. new RegExp(`^(${divisionAlternation()}) ...`).
export function divisionAlternation(): string {
  return LEAGUE_DIVISIONS.map((division) => division.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}
