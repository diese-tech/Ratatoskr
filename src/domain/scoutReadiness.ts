import { generateScoutRoster, type ScoutSignupRecord, type ScoutRosterSlot } from './scoutRoster.js';
import { SCOUT_ROLES, SCOUT_ROLE_LABELS } from './scoutRoles.js';

/** Presentation only: the existing matcher remains the readiness authority. */
export function scoutReadinessSnapshot(signups: readonly ScoutSignupRecord[], gameCount: 1 | 2,
  slots: readonly ScoutRosterSlot[] = [], unavailableDraftPlayers = 0) {
  const players = new Set(signups.map((signup) => signup.userId));
  const fill = new Set(signups.filter((signup) => signup.role === 'fill').map((signup) => signup.userId));
  const requiredPerRole = gameCount * 2;
  const roles = SCOUT_ROLES.map((role) => {
    const explicit = new Set(signups.filter((signup) => signup.role === role).map((signup) => signup.userId));
    return { role, count: explicit.size, compatible: new Set([...explicit, ...fill]).size };
  });
  const feasible = generateScoutRoster(signups, { gameCount }).feasible;
  const seated = new Set(slots.map((slot) => slot.userId));
  return { players: players.size, requiredPlayers: gameCount * 10, requiredPerRole, roles,
    fill: fill.size, feasible, overflow: slots.length ? [...players].filter((id) => !seated.has(id)).length : null,
    unavailableDraftPlayers, recordedAt: Math.floor(Date.now() / 1000) };
}

export type ScoutReadinessSnapshot = ReturnType<typeof scoutReadinessSnapshot>;

export function renderScoutReadiness(snapshot: ScoutReadinessSnapshot, historical = false): string {
  const lines = [historical ? '**Final recorded signup snapshot**' : '**Readiness**',
    `**${snapshot.players}/${snapshot.requiredPlayers} unique eligible players**`,
    ...snapshot.roles.map(({ role, count, compatible }) =>
      `${compatible < snapshot.requiredPerRole ? '⚠️' : '•'} ${SCOUT_ROLE_LABELS[role]} **${count}/${snapshot.requiredPerRole}**`),
    `Fill: **${snapshot.fill} eligible**`];
  if (snapshot.overflow !== null) lines.push(`Eligible unseated players: **${snapshot.overflow}**`);
  if (!historical) {
    if (snapshot.feasible) lines.push('✅ A complete roster can be formed.');
    else if (snapshot.players < snapshot.requiredPlayers) lines.push(`Waiting on ${snapshot.requiredPlayers - snapshot.players} more eligible players and compatible role coverage.`);
    else {
      const missing = snapshot.roles.filter((role) => role.compatible < snapshot.requiredPerRole);
      lines.push(missing.length ? `Waiting on: ${missing.map(({ role }) => SCOUT_ROLE_LABELS[role]).join(', ')} coverage (including Fill).`
        : 'Role overlap prevents a complete assignment of unique players.');
    }
    if (snapshot.unavailableDraftPlayers) lines.push(`⚠️ Current draft needs attention: ${snapshot.unavailableDraftPlayers} withdrawn or ineligible player(s).`);
  }
  lines.push(`Recorded: <t:${snapshot.recordedAt}:F>${historical ? ' • Historical signups; availability is not confirmed.' : ''}`);
  return lines.join('\n');
}
