import type { ScoutRosterSlot } from '../domain/scoutRoster.js';
import { SCOUT_ROLES, SCOUT_ROLE_LABELS } from '../domain/index.js';

export function renderScoutResult(
  setup: { divisionDisplayName: string; startAt: number },
  slots: readonly ScoutRosterSlot[],
): string {
  const lines = [
    `**${setup.divisionDisplayName} Scout Roster — <t:${setup.startAt}:F>**`,
  ];
  for (const [team, label] of [['team_one', 'Order'], ['team_two', 'Chaos']] as const) {
    lines.push('', `**${label}**`);
    for (const role of SCOUT_ROLES) {
      const slot = slots.find((candidate) => candidate.team === team && candidate.role === role);
      lines.push(`${SCOUT_ROLE_LABELS[role]}: ${slot ? `<@${slot.userId}>` : '_empty_'}`);
    }
  }
  return lines.join('\n');
}
