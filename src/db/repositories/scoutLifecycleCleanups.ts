import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ScoutLifecycleCleanup, ScoutSetup } from '../types.js';
import { appendScoutEvent } from './scoutEvents.js';
import { getScoutSetupById } from './scoutSetups.js';

export const SCOUT_LIFECYCLE_DELAY_SECONDS = 3 * 60 * 60;
const SCOUT_LIFECYCLE_ALERT_RETRY_SECONDS = 60;

type ScoutLifecycleCleanupRow = {
  setup_id: number;
  action: ScoutLifecycleCleanup['action'];
  status_before: ScoutLifecycleCleanup['statusBefore'];
  reason: ScoutLifecycleCleanup['reason'];
  scheduled_start_at: number;
  deadline_at: number;
  processed_at: number;
  actor_user_id: string;
  discord_state: ScoutLifecycleCleanup['discordState'];
  discord_reconciled_at: number | null;
  alert_attempted_at: number | null;
  alert_reference: string | null;
  alert_delivered_at: number | null;
  last_error_at: number | null;
};

function toScoutLifecycleCleanup(row: ScoutLifecycleCleanupRow): ScoutLifecycleCleanup {
  return {
    setupId: row.setup_id,
    action: row.action,
    statusBefore: row.status_before,
    reason: row.reason,
    scheduledStartAt: row.scheduled_start_at,
    deadlineAt: row.deadline_at,
    processedAt: row.processed_at,
    actorUserId: row.actor_user_id,
    discordState: row.discord_state,
    discordReconciledAt: row.discord_reconciled_at,
    alertAttemptedAt: row.alert_attempted_at,
    alertReference: row.alert_reference,
    alertDeliveredAt: row.alert_delivered_at,
    lastErrorAt: row.last_error_at,
  };
}

export function getScoutLifecycleCleanup(
  db: Database.Database,
  setupId: number,
): ScoutLifecycleCleanup | undefined {
  const row = db.prepare('SELECT * FROM scout_lifecycle_cleanups WHERE setup_id = ?')
    .get(setupId) as ScoutLifecycleCleanupRow | undefined;
  return row ? toScoutLifecycleCleanup(row) : undefined;
}

export function listPendingScoutLifecycleCleanups(
  db: Database.Database,
  limit = 25,
): ScoutLifecycleCleanup[] {
  const rows = db.prepare(`SELECT * FROM scout_lifecycle_cleanups
    WHERE discord_state = 'pending'
    ORDER BY COALESCE(last_error_at, 0), deadline_at, setup_id
    LIMIT ?`).all(limit) as ScoutLifecycleCleanupRow[];
  return rows.map(toScoutLifecycleCleanup);
}

export function recordScoutLifecycleRecoveryAttempt(
  db: Database.Database,
  setupId: number,
  attemptedAt: number,
): void {
  db.prepare(`INSERT INTO scout_lifecycle_recovery_attempts (setup_id, last_attempted_at)
    VALUES (?, ?)
    ON CONFLICT(setup_id) DO UPDATE SET last_attempted_at = excluded.last_attempted_at`)
    .run(setupId, attemptedAt);
}

export function markScoutLifecycleCleanupReconciled(
  db: Database.Database,
  setupId: number,
  reconciledAt: number,
): boolean {
  return db.prepare(`UPDATE scout_lifecycle_cleanups
    SET discord_state = 'reconciled', discord_reconciled_at = ?
    WHERE setup_id = ? AND discord_state = 'pending'`)
    .run(reconciledAt, setupId).changes === 1;
}

export function recordScoutLifecycleCleanupFailure(
  db: Database.Database,
  setupId: number,
  failedAt: number,
): string | null {
  return db.transaction(() => {
    const pending = db.prepare(`UPDATE scout_lifecycle_cleanups
      SET last_error_at = ?
      WHERE setup_id = ? AND discord_state = 'pending'`)
      .run(failedAt, setupId);
    if (pending.changes !== 1) return null;
    const alert = db.prepare(`SELECT alert_attempted_at, alert_delivered_at
      FROM scout_lifecycle_cleanups WHERE setup_id = ?`)
      .get(setupId) as { alert_attempted_at: number | null; alert_delivered_at: number | null };
    if (alert.alert_delivered_at !== null
      || (alert.alert_attempted_at !== null
        && failedAt < alert.alert_attempted_at + SCOUT_LIFECYCLE_ALERT_RETRY_SECONDS)) return null;
    db.prepare(`UPDATE scout_lifecycle_cleanups
      SET alert_attempted_at = ?, alert_reference = COALESCE(alert_reference, ?)
      WHERE setup_id = ? AND discord_state = 'pending' AND alert_delivered_at IS NULL`)
      .run(failedAt, randomUUID(), setupId);
    const row = db.prepare(`SELECT alert_reference FROM scout_lifecycle_cleanups
      WHERE setup_id = ? AND discord_state = 'pending' AND alert_delivered_at IS NULL`)
      .get(setupId) as { alert_reference: string } | undefined;
    return row?.alert_reference ?? null;
  })();
}

export function markScoutLifecycleCleanupAlertDelivered(
  db: Database.Database,
  setupId: number,
  reference: string,
  deliveredAt: number,
): boolean {
  return db.prepare(`UPDATE scout_lifecycle_cleanups
    SET alert_delivered_at = ?
    WHERE setup_id = ? AND alert_reference = ? AND alert_delivered_at IS NULL`)
    .run(deliveredAt, setupId, reference).changes === 1;
}

export function claimScoutLifecycleRecoveryAlert(
  db: Database.Database,
  setupId: number,
  attemptedAt: number,
): string | null {
  return db.transaction(() => {
    const setup = getScoutSetupById(db, setupId);
    if (!setup || !['posting', 'posting_failed'].includes(setup.status)
      || attemptedAt < setup.startAt + SCOUT_LIFECYCLE_DELAY_SECONDS) return null;
    if (db.prepare(`SELECT 1 FROM scout_events
      WHERE setup_id = ? AND event_type = 'scout_automatic_cleanup_recovery_alerted'`).get(setupId)) return null;
    const row = db.prepare(`SELECT alert_reference, alert_attempted_at, alert_delivered_at
      FROM scout_lifecycle_recovery_attempts WHERE setup_id = ?`)
      .get(setupId) as {
        alert_reference: string | null;
        alert_attempted_at: number | null;
        alert_delivered_at: number | null;
      } | undefined;
    if (row?.alert_delivered_at !== null && row?.alert_delivered_at !== undefined) return null;
    if (row?.alert_attempted_at !== null && row?.alert_attempted_at !== undefined
      && attemptedAt < row.alert_attempted_at + SCOUT_LIFECYCLE_ALERT_RETRY_SECONDS) return null;
    const reference = row?.alert_reference ?? randomUUID();
    db.prepare(`INSERT INTO scout_lifecycle_recovery_attempts
      (setup_id, last_attempted_at, alert_reference, alert_attempted_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(setup_id) DO UPDATE SET
        alert_reference = excluded.alert_reference,
        alert_attempted_at = excluded.alert_attempted_at`)
      .run(setupId, attemptedAt, reference, attemptedAt);
    return reference;
  })();
}

export function markScoutLifecycleRecoveryAlertDelivered(
  db: Database.Database,
  setupId: number,
  reference: string,
  deliveredAt: number,
  actorUserId: string,
): boolean {
  return db.transaction(() => {
    const setup = getScoutSetupById(db, setupId);
    if (!setup || !['posting', 'posting_failed'].includes(setup.status)) return false;
    const row = db.prepare(`SELECT alert_attempted_at FROM scout_lifecycle_recovery_attempts
      WHERE setup_id = ? AND alert_reference = ? AND alert_delivered_at IS NULL`)
      .get(setupId, reference) as { alert_attempted_at: number } | undefined;
    if (!row) return false;
    const updated = db.prepare(`UPDATE scout_lifecycle_recovery_attempts
      SET alert_delivered_at = ?
      WHERE setup_id = ? AND alert_reference = ? AND alert_delivered_at IS NULL`)
      .run(deliveredAt, setupId, reference);
    if (updated.changes !== 1) return false;
    appendScoutEvent(db, {
      setupId,
      setupVersion: setup.version,
      eventType: 'scout_automatic_cleanup_recovery_alerted',
      actorUserId,
      payload: {
        reason: 'automatic_deadline',
        unresolvedStatus: setup.status,
        scheduledStartAt: setup.startAt,
        deadlineAt: setup.startAt + SCOUT_LIFECYCLE_DELAY_SECONDS,
        attemptedAt: row.alert_attempted_at,
        deliveredAt,
        reference,
      },
    });
    return true;
  })();
}

export function listDueScoutLifecycleSetups(
  db: Database.Database,
  now: number,
  limit = 25,
): ScoutSetup[] {
  const ids = db.prepare(`SELECT scout_setups.id FROM scout_setups
    LEFT JOIN scout_lifecycle_recovery_attempts AS recovery
      ON recovery.setup_id = scout_setups.id
    WHERE scout_setups.start_at + ? <= ?
      AND (scout_setups.status IN ('posting', 'posting_failed', 'open', 'roster_ready')
        OR (scout_setups.status = 'published'
          AND NOT EXISTS (SELECT 1 FROM scout_completions WHERE setup_id = scout_setups.id)))
    ORDER BY CASE WHEN scout_setups.status IN ('open', 'roster_ready', 'published') THEN 0 ELSE 1 END,
      COALESCE(recovery.last_attempted_at, 0), scout_setups.start_at + ?, scout_setups.id
    LIMIT ?`).all(SCOUT_LIFECYCLE_DELAY_SECONDS, now, SCOUT_LIFECYCLE_DELAY_SECONDS, limit) as { id: number }[];
  return ids.map((row) => getScoutSetupById(db, row.id)!).filter(Boolean);
}

export type CloseDueScoutSetupOutcome =
  | { status: 'cancelled' | 'finished'; cleanup: ScoutLifecycleCleanup }
  | { status: 'not_due' | 'already_final' | 'recovery_required' | 'missing' };

export function closeDueScoutSetup(
  db: Database.Database,
  setupId: number,
  now: number,
  actorUserId: string,
): CloseDueScoutSetupOutcome {
  return db.transaction((): CloseDueScoutSetupOutcome => {
    const setup = getScoutSetupById(db, setupId);
    if (!setup) return { status: 'missing' };
    const deadlineAt = setup.startAt + SCOUT_LIFECYCLE_DELAY_SECONDS;
    if (now < deadlineAt) return { status: 'not_due' };
    const existingCleanup = getScoutLifecycleCleanup(db, setupId);
    if (existingCleanup) return { status: 'already_final' };
    if (setup.status === 'cancelled'
      || db.prepare('SELECT 1 FROM scout_completions WHERE setup_id = ?').get(setupId)) {
      return { status: 'already_final' };
    }
    if (setup.status === 'posting' || setup.status === 'posting_failed') {
      return { status: 'recovery_required' };
    }
    if (!['open', 'roster_ready', 'published'].includes(setup.status)) return { status: 'already_final' };

    const action = setup.status === 'published' ? 'finished' : 'cancelled';
    const nextVersion = setup.version;
    const updated = action === 'cancelled'
      ? db.prepare(`UPDATE scout_setups
          SET status = 'cancelled',
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?, 'unixepoch')
          WHERE id = ? AND version = ? AND status IN ('open', 'roster_ready')`)
        .run(now, setupId, setup.version)
      : db.prepare(`UPDATE scout_setups
          SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?, 'unixepoch')
          WHERE id = ? AND version = ? AND status = 'published'
            AND NOT EXISTS (SELECT 1 FROM scout_completions WHERE setup_id = scout_setups.id)`)
        .run(now, setupId, setup.version);
    if (updated.changes !== 1) return { status: 'already_final' };

    if (action === 'finished') {
      db.prepare(`INSERT INTO scout_completions (setup_id, finished_by, finished_at)
        VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', ?, 'unixepoch'))`)
        .run(setupId, actorUserId, now);
    }
    db.prepare(`INSERT INTO scout_lifecycle_cleanups (
      setup_id, action, status_before, reason, scheduled_start_at, deadline_at, processed_at, actor_user_id
    ) VALUES (?, ?, ?, 'automatic_deadline', ?, ?, ?, ?)`)
      .run(setupId, action, setup.status, setup.startAt, deadlineAt, now, actorUserId);
    const skippedNotifications = db.prepare(`UPDATE scout_notifications
      SET state = 'skipped', skipped_reason = 'automatic_deadline'
      WHERE setup_id = ? AND state = 'scheduled'`).run(setupId).changes;
    appendScoutEvent(db, {
      setupId,
      setupVersion: nextVersion,
      eventType: action === 'finished' ? 'scout_automatically_finished' : 'scout_automatically_cancelled',
      actorUserId,
      payload: {
        reason: 'automatic_deadline',
        statusBefore: setup.status,
        scheduledStartAt: setup.startAt,
        deadlineAt,
        processedAt: now,
        skippedNotifications,
      },
    });
    return { status: action, cleanup: getScoutLifecycleCleanup(db, setupId)! };
  })();
}
