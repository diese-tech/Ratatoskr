import type { Guild } from 'discord.js';
import type { ScoutRosterSlotRecord } from '../db/types.js';
import { SCOUT_ROLE_LABELS } from '../domain/index.js';

function compactName(value: string | null | undefined): string | undefined {
  const clean = value?.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > 36 ? `${clean.slice(0, 35)}…` : clean;
}

export function unknownScoutPlayer(userId: string): string {
  return `Unknown Player (…${userId.slice(-4)})`;
}

/** Per-view lookup, deduplicated and bounded by the visible roster/menu size. */
export async function resolveScoutPlayerNames(guild: Guild, userIds: readonly string[]): Promise<Map<string, string>> {
  return new Map(await Promise.all([...new Set(userIds)].map(async (userId) => {
    const member = guild.members.cache?.get(userId) ?? await guild.members.fetch(userId).catch(() => undefined);
    const displayName = compactName(member?.displayName);
    if (displayName) return [userId, displayName] as const;
    const user = member?.user ?? guild.client?.users?.cache.get(userId)
      ?? await guild.client?.users?.fetch(userId).catch(() => undefined);
    return [userId, compactName(user?.globalName) ?? compactName(user?.username) ?? unknownScoutPlayer(userId)] as const;
  })));
}

export function formatScoutSlotLabel(slot: Pick<ScoutRosterSlotRecord, 'gameNumber' | 'team' | 'role' | 'userId'>, playerName?: string): string {
  return `G${slot.gameNumber} • ${slot.team === 'team_one' ? 'Order' : 'Chaos'} • ${SCOUT_ROLE_LABELS[slot.role]} — ${playerName ?? unknownScoutPlayer(slot.userId)}`.slice(0, 100);
}
