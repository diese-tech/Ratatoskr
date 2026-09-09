import type { Guild } from 'discord.js';
import type { ScoutSignup } from '../db/index.js';

export type ScoutIneligibilityReason =
  | { kind: 'missing_role'; roleId: string }
  | { kind: 'not_in_server' }
  | { kind: 'bot' };

export interface ScoutSignupEligibility {
  eligibleSignups: ScoutSignup[];
  ineligibleSignups: Array<{ signup: ScoutSignup; reason: ScoutIneligibilityReason }>;
}

export function isScoutUserEligible(
  memberRoleIds: Iterable<string>,
  eligibilityRoleId: string | null,
): boolean {
  return !eligibilityRoleId || new Set(memberRoleIds).has(eligibilityRoleId);
}

export async function resolveScoutUserEligibility(
  guild: Guild,
  userIds: Iterable<string>,
  eligibilityRoleId: string | null,
): Promise<{ eligibleUserIds: Set<string>; ineligibilityByUserId: Map<string, ScoutIneligibilityReason> }> {
  const unique = [...new Set(userIds)];
  if (eligibilityRoleId && !await guild.roles.fetch(eligibilityRoleId)) {
    throw new Error('The configured Scout eligibility role is missing. Restore the role or review this setup.');
  }
  const resolved = await Promise.all(unique.map(async (userId) => {
    const member = await guild.members.fetch(userId).catch((error: unknown) => {
      if (Number((error as { code?: number })?.code) === 10007) return undefined;
      throw error;
    });
    if (!member) return [userId, { kind: 'not_in_server' }] as const;
    if (member.user.bot) return [userId, { kind: 'bot' }] as const;
    if (eligibilityRoleId && !isScoutUserEligible(member.roles.cache.keys(), eligibilityRoleId)) {
      return [userId, { kind: 'missing_role', roleId: eligibilityRoleId }] as const;
    }
    return [userId, undefined] as const;
  }));
  const eligibleUserIds = new Set(resolved.filter(([, reason]) => !reason).map(([userId]) => userId));
  const ineligibilityByUserId = new Map(
    resolved.filter((entry): entry is readonly [string, ScoutIneligibilityReason] => Boolean(entry[1])),
  );
  return { eligibleUserIds, ineligibilityByUserId };
}

export async function resolveEligibleScoutUserIds(
  guild: Guild,
  userIds: Iterable<string>,
  eligibilityRoleId: string | null,
): Promise<Set<string>> {
  return (await resolveScoutUserEligibility(guild, userIds, eligibilityRoleId)).eligibleUserIds;
}

export async function classifyScoutSignups(
  guild: Guild,
  signups: readonly ScoutSignup[],
  eligibilityRoleId: string | null,
): Promise<ScoutSignupEligibility> {
  const { eligibleUserIds, ineligibilityByUserId } = await resolveScoutUserEligibility(
    guild, signups.map((signup) => signup.userId), eligibilityRoleId,
  );
  return {
    eligibleSignups: signups.filter((signup) => eligibleUserIds.has(signup.userId)),
    ineligibleSignups: signups.flatMap((signup) => {
      const reason = ineligibilityByUserId.get(signup.userId);
      return reason ? [{ signup, reason }] : [];
    }),
  };
}

export async function eligibleScoutSignups(
  guild: Guild,
  signups: readonly ScoutSignup[],
  eligibilityRoleId: string | null,
): Promise<ScoutSignup[]> {
  return (await classifyScoutSignups(guild, signups, eligibilityRoleId)).eligibleSignups;
}
