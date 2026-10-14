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
  const lines = [historical ? '**Last saved signup check**' : '**Readiness**',
    `**${snapshot.players}/${snapshot.requiredPlayers} players who can join**`,
    ...snapshot.roles.map(({ role, count, compatible }) =>
      `${compatible < snapshot.requiredPerRole ? '⚠️' : '•'} ${SCOUT_ROLE_LABELS[role]} **${count}/${snapshot.requiredPerRole}**`),
    `Fill: **${snapshot.fill} players**`];
  if (snapshot.overflow !== null) lines.push(`Players waiting for a team: **${snapshot.overflow}**`);
  if (!historical) {
    if (snapshot.feasible) lines.push('✅ A complete roster can be formed.');
    else if (snapshot.players < snapshot.requiredPlayers) lines.push(`Need ${snapshot.requiredPlayers - snapshot.players} more players, with enough players for each play role.`);
    else {
      const missing = snapshot.roles.filter((role) => role.compatible < snapshot.requiredPerRole);
      lines.push(missing.length ? `Need players for: ${missing.map(({ role }) => SCOUT_ROLE_LABELS[role]).join(', ')}. Fill players can cover these roles.`
        : 'There are enough players, but their chosen roles do not fill every team spot yet.');
    }
    if (snapshot.unavailableDraftPlayers) lines.push(`⚠️ Teams need checking: ${snapshot.unavailableDraftPlayers} player(s) withdrew or can no longer join.`);
  }
  lines.push(`Checked: <t:${snapshot.recordedAt}:F>${historical ? ' • These are past signups; players may no longer be available.' : ''}`);
  return lines.join('\n');
}
