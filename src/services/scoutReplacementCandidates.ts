import type { ScoutSignup } from '../db/index.js';
import type { ScoutRole } from '../domain/index.js';

export type ScoutReplacementCandidate = {
  userId: string;
  roles: ScoutSignup['role'][];
  offRole: boolean;
};

export function rankScoutReplacementCandidates(
  signups: readonly ScoutSignup[],
  rosteredUserIds: ReadonlySet<string>,
  role: ScoutRole,
): ScoutReplacementCandidate[] {
  const rolesByUser = new Map<string, ScoutSignup['role'][]>();
  for (const signup of signups) {
    if (rosteredUserIds.has(signup.userId)) continue;
    const roles = rolesByUser.get(signup.userId) ?? [];
    if (!roles.includes(signup.role)) roles.push(signup.role);
    rolesByUser.set(signup.userId, roles);
  }
  return [...rolesByUser].map(([userId, roles]) => ({
    userId,
    roles,
    offRole: !roles.some((candidate) => candidate === role || candidate === 'fill'),
  })).sort((a, b) => Number(a.offRole) - Number(b.offRole));
}
