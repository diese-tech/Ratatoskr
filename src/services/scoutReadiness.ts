import type { Client } from 'discord.js';
import type Database from 'better-sqlite3';
import { getScoutSetupById, listScoutSignups, listScoutRosterSlots, withdrawnScoutRosterUserIds,
  ensureScoutReadinessCard, patchScoutReadinessCard, type ScoutSetup } from '../db/index.js';
import { scoutReadinessSnapshot } from '../domain/scoutReadiness.js';
import { resolveEligibleScoutUserIds } from './scoutEligibility.js';
import { withScoutSetupLock } from './scoutSetupLock.js';
import { reportOperationalError } from './operationalErrors.js';

export async function captureScoutReadiness(client: Client, db: Database.Database, setup: ScoutSetup) {
  const guild = await client.guilds.fetch(setup.guildId);
  const signups = listScoutSignups(db, setup.id);
  const slots = listScoutRosterSlots(db, setup.id);
  const eligibleIds = await resolveEligibleScoutUserIds(guild,
    [...signups.map((signup) => signup.userId), ...slots.map((slot) => slot.userId)], setup.eligibilityRoleId);
  const unavailable = new Set([...withdrawnScoutRosterUserIds(db, setup.id),
    ...slots.filter((slot) => !eligibleIds.has(slot.userId)).map((slot) => slot.userId)]);
  return scoutReadinessSnapshot(signups.filter((signup) => eligibleIds.has(signup.userId)), setup.gameCount, slots, unavailable.size);
}

/** Freeze current signup counts atomically with a successful terminal transition.
 * Waiting card edits cannot delay closure. On eligibility failure, retain the
 * timestamped last known snapshot rather than recomputing historical eligibility
 * on a future restart. The existing transition still owns roster validation.
 */
export async function withFinalScoutReadiness<T>(client: Client, db: Database.Database, setupId: number,
  close: () => T): Promise<T> {
  let failure: { setup: ScoutSetup; error: unknown } | undefined;
  const outcome = await withScoutSetupLock(db, setupId, async () => {
    const setup = getScoutSetupById(db, setupId);
    if (!setup?.operationsChannelId || !['open', 'roster_ready'].includes(setup.status)) return close();
    let finalSnapshot: Awaited<ReturnType<typeof captureScoutReadiness>> | undefined;
    try { finalSnapshot = await captureScoutReadiness(client, db, setup); }
    catch (error) { failure = { setup, error }; }
    return db.transaction(() => {
      const result = close();
      const current = getScoutSetupById(db, setupId);
      if (finalSnapshot && current && ['published', 'cancelled'].includes(current.status)) {
        ensureScoutReadinessCard(db, setupId);
        patchScoutReadinessCard(db, setupId, { snapshot_json: JSON.stringify(finalSnapshot) });
      }
      return result;
    })();
  });
  if (failure) await reportOperationalError(client, db, { guildId: failure.setup.guildId, setupId,
    division: failure.setup.divisionDisplayName, action: 'Scout final readiness snapshot' }, failure.error);
  return outcome;
}
