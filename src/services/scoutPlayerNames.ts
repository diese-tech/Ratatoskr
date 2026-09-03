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
  const resolved = await Promise.all([...new Set(userIds)].map(async (userId) => {
    const member = guild.members.cache?.get(userId) ?? await guild.members.fetch(userId).catch(() => undefined);
    const displayName = compactName(member?.displayName);
    const user = member?.user ?? (displayName ? undefined : guild.client?.users?.cache.get(userId)
      ?? await guild.client?.users?.fetch(userId).catch(() => undefined));
    return { userId, name: displayName ?? compactName(user?.globalName) ?? compactName(user?.username) ?? unknownScoutPlayer(userId),
      username: compactName(user?.username)?.slice(0, 32) };
  }));
  return new Map(resolved.map(({ userId, name, username }) => {
    const collisions = resolved.filter((player) => player.name === name);
    if (collisions.length === 1) return [userId, name];
    if (username && collisions.filter((player) => player.username === username).length === 1) {
      return [userId, `${name} (@${username})`];
    }
    // Prefer a username; unavailable/duplicate accounts get the shortest unique
    // ID suffix. Stable option values alone cannot disambiguate visible choices.
    let length = Math.min(4, userId.length);
    while (length < userId.length && collisions.some((player) => player.userId !== userId && player.userId.slice(-length) === userId.slice(-length))) length++;
    return [userId, `${name} (${length < userId.length ? '…' : ''}${userId.slice(-length)})`];
  }));
}

export function formatScoutSlotLabel(slot: Pick<ScoutRosterSlotRecord, 'gameNumber' | 'team' | 'role' | 'userId'>, playerName?: string): string {
  return `G${slot.gameNumber} • ${slot.team === 'team_one' ? 'Order' : 'Chaos'} • ${SCOUT_ROLE_LABELS[slot.role]} — ${playerName ?? unknownScoutPlayer(slot.userId)}`.slice(0, 100);
}
