import type { Season } from '../db/types.js';

// The canonical season workspace (#17): five text channels, all publicly
// readable but staff-managed (read-only for regular members via the same
// primitive #16 establishes in resolveChannelPermissionOverwrites) -- no
// per-season announcements or rules channels; those stay in WELCOME/LEAGUE
// INFORMATION, permanent across seasons. No separate free-agency channel --
// rosters and free agents are both tracked on the same linked Google Sheet,
// so #rosters is the single home for both rather than splitting them across
// two channels.
export type SeasonChannelSpec = {
  // Stable identity, authored once and never derived from `name` -- see #31
  // Defect 2. A config-side display-name rename must not change identity.
  key: string;
  name: string;
  readOnly: true;
};

export const SEASON_CHANNELS: readonly SeasonChannelSpec[] = [
  { key: 'banned_content', name: 'banned-content', readOnly: true },
  { key: 'schedule', name: 'schedule', readOnly: true },
  { key: 'standings', name: 'standings', readOnly: true },
  { key: 'rosters', name: 'rosters', readOnly: true },
  { key: 'transactions', name: 'transactions', readOnly: true },
];

// Fails loudly at module load if two season channels were authored with the
// same key -- same rationale as assertNoDuplicateServerLogicalKeys.
function assertNoDuplicateSeasonChannelKeys(channels: readonly SeasonChannelSpec[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const channel of channels) {
    if (seen.has(channel.key)) duplicates.add(channel.key);
    seen.add(channel.key);
  }
  if (duplicates.size > 0) {
    throw new Error(`Duplicate season channel key(s): ${Array.from(duplicates).join(', ')}`);
  }
}

assertNoDuplicateSeasonChannelKeys(SEASON_CHANNELS);

// Every season channel is text-only today, but the kind suffix mirrors
// serverChannelLogicalKey's format (#16) for consistency across scaffold
// domains rather than assuming a season channel can never be a voice
// channel in the future. `key` is authored (config's SeasonChannelSpec.key),
// never derived from a channel's display name -- see #31 Defect 2.
export function seasonChannelLogicalKey(seasonNumber: number, key: string): string {
  return `season:${seasonNumber}:channel:${key}:text_channel`;
}

export type SeasonCreateEligibility =
  | { outcome: 'blocked-active-season'; activeSeasonNumber: number }
  | { outcome: 'blocked-archived-conflict' }
  | { outcome: 'retry-existing'; seasonId: number }
  | { outcome: 'create-new' };

// The single required rule from #17: /season create fails closed, full
// stop, whenever a season is already active -- it never deactivates or
// replaces it, and this is checked first regardless of what else is true.
// A season row already existing for the requested number (with no season
// currently active) means a prior attempt already inserted it -- possibly
// after only partially provisioning Discord resources -- so that's treated
// as a retry against the same row rather than a fresh createSeason() call,
// which would just violate the UNIQUE (guild_id, season_number) constraint
// anyway. An archived row for that number is left alone as a distinct,
// named conflict rather than silently reused (archival itself is out of
// scope for #17, but this keeps the door open for it).
export function evaluateSeasonCreateEligibility(
  activeSeason: Pick<Season, 'seasonNumber'> | undefined,
  existingForNumber: Pick<Season, 'id' | 'status'> | undefined,
): SeasonCreateEligibility {
  if (activeSeason) {
    return { outcome: 'blocked-active-season', activeSeasonNumber: activeSeason.seasonNumber };
  }

  if (existingForNumber) {
    if (existingForNumber.status === 'archived') {
      return { outcome: 'blocked-archived-conflict' };
    }
    return { outcome: 'retry-existing', seasonId: existingForNumber.id };
  }

  return { outcome: 'create-new' };
}
