import { SCOUT_ROLES } from './scoutRoles.js';
import type { ScoutRosterSlot } from './scoutRoster.js';

/** Spread division representation after filling seats. This never adds an
 * eligibility rule, drops a player, changes play roles or overrides a manual
 * seat. Unknown divisions have no invented rating. At most 32 choices per game.
 */
export function balanceInhouseRoster(slots: readonly ScoutRosterSlot[],
  divisionByUser: ReadonlyMap<string, string>, fixedSlots: readonly ScoutRosterSlot[] = []): ScoutRosterSlot[] {
  const fixedUsers = new Set(fixedSlots.map(s => s.userId));
  let result = slots.map(s => ({ ...s }));
  for (const game of new Set(slots.map(s => s.gameNumber ?? 1))) {
    const choices = SCOUT_ROLES.map(role => result.map((slot, index) => ({ slot, index }))
      .filter(({ slot }) => (slot.gameNumber ?? 1) === game && slot.role === role))
      .filter(pair => pair.length && !pair.some(({ slot }) => fixedUsers.has(slot.userId)));
    const score = (candidate: readonly ScoutRosterSlot[]) => {
      let sizeDifference = 0;
      const divisions = new Map<string, number>();
      for (const slot of candidate) {
        if ((slot.gameNumber ?? 1) !== game) continue;
        const direction = slot.team === 'team_one' ? 1 : -1;
        sizeDifference += direction;
        const division = divisionByUser.get(slot.userId);
        if (division) divisions.set(division, (divisions.get(division) ?? 0) + direction);
      }
      return [Math.abs(sizeDifference), [...divisions.values()].reduce((sum, n) => sum + Math.abs(n), 0)];
    };
    let best = result, bestScore = score(result);
    for (let mask = 1; mask < 2 ** choices.length; mask++) {
      const candidate = result.map(s => ({ ...s }));
      choices.forEach((pair, i) => {
        if (mask & (1 << i)) for (const { index } of pair) {
          candidate[index]!.team = candidate[index]!.team === 'team_one' ? 'team_two' : 'team_one';
        }
      });
      const next = score(candidate);
      if (next[0]! < bestScore[0]! || (next[0] === bestScore[0] && next[1]! < bestScore[1]!)) {
        best = candidate; bestScore = next;
      }
    }
    result = best;
  }
  return result;
}
