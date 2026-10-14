import { scoutGameName } from './scoutGamePresentation.js';
import type { ScoutRosterSlot } from '../domain/scoutRoster.js';
import { SCOUT_ROLES, SCOUT_ROLE_LABELS } from '../domain/index.js';

export function renderScoutResult(
  setup: {
    divisionDisplayName: string;
    workflow?: 'scout' | 'inhouse';
    startAt: number;
    gameCount?: 1 | 2;
    hosts?: readonly { gameNumber: 1 | 2; lobbyHostUserId: string }[];
  },
  slots: readonly (ScoutRosterSlot & { replacementNeeded?: boolean })[],
): string {
  const lines = [
    `**${scoutGameName(setup)} Roster — <t:${setup.startAt}:F>**`,
  ];
  const gameCount = setup.gameCount ?? (slots.some((slot) => slot.gameNumber === 2) ? 2 : 1);
  for (let gameNumber = 1; gameNumber <= gameCount; gameNumber++) {
    if (gameCount === 2) lines.push('', `__**Game ${gameNumber}**__`);
    const host = setup.hosts?.find((candidate) => candidate.gameNumber === gameNumber);
    if (host) lines.push('', `**Lobby Host:** <@${host.lobbyHostUserId}>`);
    for (const [team, label] of [['team_one', 'Order'], ['team_two', 'Chaos']] as const) {
      lines.push('', `**${label}**`);
      for (const role of SCOUT_ROLES) {
        const slot = slots.find((candidate) =>
          (candidate.gameNumber ?? 1) === gameNumber && candidate.team === team && candidate.role === role,
        );
        lines.push(`${SCOUT_ROLE_LABELS[role]}: ${slot
          ? `<@${slot.userId}>${slot.replacementNeeded ? ' ⚠️ _replacement needed_' : ''}`
          : '_empty_'}`);
      }
    }
  }
  return lines.join('\n');
}
