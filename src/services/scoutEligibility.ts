import type { Guild } from 'discord.js';
import type { ScoutSignup } from '../db/index.js';

export function isScoutUserEligible(
  memberRoleIds: Iterable<string>,
  eligibilityRoleId: string | null,
): boolean {
  return !eligibilityRoleId || new Set(memberRoleIds).has(eligibilityRoleId);
}

export async function resolveEligibleScoutUserIds(
  guild: Guild,
  userIds: Iterable<string>,
  eligibilityRoleId: string | null,
): Promise<Set<string>> {
  const unique = [...new Set(userIds)];
  if (!eligibilityRoleId) return new Set(unique);
  const resolved = await Promise.all(unique.map(async (userId) => {
    const member = await guild.members.fetch(userId).catch(() => undefined);
    return member && isScoutUserEligible(member.roles.cache.keys(), eligibilityRoleId) ? userId : undefined;
  }));
  return new Set(resolved.filter((userId): userId is string => Boolean(userId)));
}

export async function eligibleScoutSignups(
  guild: Guild,
  signups: readonly ScoutSignup[],
  eligibilityRoleId: string | null,
): Promise<ScoutSignup[]> {
  const eligible = await resolveEligibleScoutUserIds(guild, signups.map((signup) => signup.userId), eligibilityRoleId);
  return signups.filter((signup) => eligible.has(signup.userId));
}
