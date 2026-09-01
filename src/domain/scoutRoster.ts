import { SCOUT_ROLES, type ScoutRole, type ScoutSignupRole } from './scoutRoles.js';

export const SCOUT_TEAMS = ['team_one', 'team_two'] as const;
export type ScoutTeam = (typeof SCOUT_TEAMS)[number];
export type ScoutSignupRecord = { userId: string; role: ScoutSignupRole; createdAt: string };
export type ScoutRosterSlot = { team: ScoutTeam; role: ScoutRole; userId: string };
export type ScoutRosterResult = { feasible: boolean; slots: ScoutRosterSlot[] };
export type ScoutRosterOptions = { mode?: 'deterministic' | 'shuffle'; random?: () => number };

function eligibilityFor(signups: readonly ScoutSignupRecord[]) {
  const rolesByUser = new Map<string, Set<ScoutSignupRole>>();
  for (const signup of signups) {
    const roles = rolesByUser.get(signup.userId) ?? new Set<ScoutSignupRole>();
    roles.add(signup.role);
    rolesByUser.set(signup.userId, roles);
  }
  return new Map(
    [...rolesByUser].map(([userId, roles]) => {
      const explicit = SCOUT_ROLES.filter((role) => roles.has(role));
      const fallback = roles.has('fill') ? SCOUT_ROLES.filter((role) => !roles.has(role)) : [];
      return [userId, [...explicit, ...fallback]] as const;
    }),
  );
}

function earliestFor(signups: readonly ScoutSignupRecord[]) {
  const earliest = new Map<string, string>();
  for (const signup of signups) {
    const current = earliest.get(signup.userId);
    if (!current || signup.createdAt < current) earliest.set(signup.userId, signup.createdAt);
  }
  return earliest;
}

function shuffle<T>(items: T[], random: () => number) {
  for (let index = items.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [items[index], items[other]] = [items[other]!, items[index]!];
  }
  return items;
}

function tryAssign(
  userId: string,
  eligibility: Map<string, readonly ScoutRole[]>,
  assignment: Map<ScoutRole, string[]>,
  visited: Set<ScoutRole>,
): boolean {
  for (const role of eligibility.get(userId) ?? []) {
    if (visited.has(role)) continue;
    visited.add(role);
    const holders = assignment.get(role)!;
    if (holders.length < 2) {
      holders.push(userId);
      return true;
    }
    for (let index = 0; index < holders.length; index++) {
      const holder = holders[index]!;
      holders.splice(index, 1);
      if (tryAssign(holder, eligibility, assignment, visited)) {
        holders.push(userId);
        return true;
      }
      holders.splice(index, 0, holder);
    }
  }
  return false;
}

export function generateScoutRoster(
  signups: readonly ScoutSignupRecord[],
  options: ScoutRosterOptions = {},
): ScoutRosterResult {
  const eligibility = eligibilityFor(signups);
  const earliest = earliestFor(signups);
  const random = options.random ?? Math.random;
  let players = [...eligibility.keys()];
  const hasExplicitRole = (userId: string) =>
    signups.some((signup) => signup.userId === userId && signup.role !== 'fill');
  if (options.mode === 'shuffle') {
    players = [
      ...shuffle(players.filter(hasExplicitRole), random),
      ...shuffle(players.filter((userId) => !hasExplicitRole(userId)), random),
    ];
  }
  else {
    players.sort(
      (a, b) =>
        Number(hasExplicitRole(b)) - Number(hasExplicitRole(a)) ||
        (earliest.get(a) ?? '').localeCompare(earliest.get(b) ?? '') ||
        a.localeCompare(b),
    );
  }

  const assignment = new Map(SCOUT_ROLES.map((role) => [role, [] as string[]]));
  for (const player of players) tryAssign(player, eligibility, assignment, new Set());
  if ([...assignment.values()].some((holders) => holders.length !== 2)) return { feasible: false, slots: [] };

  const slots: ScoutRosterSlot[] = [];
  for (const role of SCOUT_ROLES) {
    const holders = [...assignment.get(role)!];
    if (options.mode === 'shuffle') shuffle(holders, random);
    else holders.sort((a, b) => (earliest.get(a) ?? '').localeCompare(earliest.get(b) ?? '') || a.localeCompare(b));
    SCOUT_TEAMS.forEach((team, index) => slots.push({ team, role, userId: holders[index]! }));
  }
  return { feasible: true, slots };
}

export function scoutRosterFingerprint(slots: readonly ScoutRosterSlot[]): string {
  return slots.map((slot) => `${slot.team}:${slot.role}:${slot.userId}`).sort().join('|');
}

export function generateDifferentScoutRoster(
  signups: readonly ScoutSignupRecord[],
  currentFingerprint: string,
  random: () => number = Math.random,
): { result: ScoutRosterResult; isDifferent: boolean } {
  let result: ScoutRosterResult = { feasible: false, slots: [] };
  for (let attempt = 0; attempt < 5; attempt++) {
    result = generateScoutRoster(signups, { mode: 'shuffle', random });
    if (!result.feasible) return { result, isDifferent: false };
    if (scoutRosterFingerprint(result.slots) !== currentFingerprint) return { result, isDifferent: true };
  }
  return { result, isDifferent: false };
}
