import type { Season } from '../db/types.js';

// The canonical season workspace (#17): six text channels, all publicly
// readable but staff-managed (read-only for regular members via the same
// primitive #16 establishes in resolveChannelPermissionOverwrites) -- no
// per-season announcements or rules channels; those stay in WELCOME/LEAGUE
// INFORMATION, permanent across seasons.
export type SeasonChannelSpec = {
  name: string;
  readOnly: true;
};

export const SEASON_CHANNELS: readonly SeasonChannelSpec[] = [
  { name: 'banned-content', readOnly: true },
  { name: 'schedule', readOnly: true },
  { name: 'standings', readOnly: true },
  { name: 'rosters', readOnly: true },
  { name: 'transactions', readOnly: true },
  { name: 'free-agency', readOnly: true },
];

function slugify(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-');
}

// Every season channel is text-only today, but the kind suffix mirrors
// serverChannelLogicalKey's format (#16) for consistency across scaffold
// domains rather than assuming a season channel can never be a voice
// channel in the future.
export function seasonChannelLogicalKey(seasonNumber: number, channelName: string): string {
  return `season:${seasonNumber}:${slugify(channelName)}:text_channel`;
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
