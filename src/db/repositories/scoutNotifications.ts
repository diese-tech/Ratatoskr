import type Database from 'better-sqlite3';
import type {
  ScoutNotification,
  ScoutNotificationKind,
  ScoutNotificationPayload,
} from '../types.js';

type ScoutNotificationRow = {
  id: number;
  setup_id: number;
  game_number: 1 | 2 | null;
  kind: ScoutNotificationKind;
  dedupe_key: string;
  nonce: string;
  channel_id: string;
  due_at: number;
  payload_json: string | null;
  state: ScoutNotification['state'];
  attempted_at: number | null;
  sent_at: number | null;
  message_id: string | null;
  skipped_reason: string | null;
  created_at: string;
};

function toScoutNotification(row: ScoutNotificationRow): ScoutNotification {
  return {
    id: row.id,
    setupId: row.setup_id,
    gameNumber: row.game_number,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    nonce: row.nonce,
    channelId: row.channel_id,
    dueAt: row.due_at,
    payload: row.payload_json ? JSON.parse(row.payload_json) as ScoutNotificationPayload : null,
    state: row.state,
    attemptedAt: row.attempted_at,
    sentAt: row.sent_at,
    messageId: row.message_id,
    skippedReason: row.skipped_reason,
    createdAt: row.created_at,
  };
}

export type ScheduleScoutNotificationInput = {
  setupId: number;
  gameNumber?: 1 | 2 | null;
  kind: ScoutNotificationKind;
  dedupeKey: string;
  nonce: string;
  channelId: string;
  dueAt: number;
};

export type ScheduleScoutNotificationResult = {
  created: boolean;
  notification: ScoutNotification;
};

export function getScoutNotificationByDedupeKey(
  db: Database.Database,
  dedupeKey: string,
): ScoutNotification | undefined {
  const row = db.prepare('SELECT * FROM scout_notifications WHERE dedupe_key = ?')
    .get(dedupeKey) as ScoutNotificationRow | undefined;
  return row ? toScoutNotification(row) : undefined;
}

export function scheduleScoutNotification(
  db: Database.Database,
  input: ScheduleScoutNotificationInput,
): ScheduleScoutNotificationResult {
  if (input.nonce.length === 0 || input.nonce.length > 25) {
    throw new Error('Scout notification nonce must contain between 1 and 25 characters.');
  }
  if ((input.kind === 'host_organizer' || input.kind === 'host_change') && input.gameNumber == null) {
    throw new Error(`${input.kind} notifications require a game number.`);
  }
  const result = db.prepare(
    `INSERT INTO scout_notifications (
       setup_id, game_number, kind, dedupe_key, nonce, channel_id, due_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`,
  ).run(
    input.setupId,
    input.gameNumber ?? null,
    input.kind,
    input.dedupeKey,
    input.nonce,
    input.channelId,
    input.dueAt,
  );
  const notification = getScoutNotificationByDedupeKey(db, input.dedupeKey);
  if (!notification) throw new Error('Scheduled scout notification could not be read back.');
  return { created: result.changes === 1, notification };
}

export function listDueScoutNotifications(
  db: Database.Database,
  dueAt: number,
  limit = 100,
): ScoutNotification[] {
  const rows = db.prepare(
    `SELECT * FROM scout_notifications
     WHERE state = 'scheduled' AND due_at <= ?
     ORDER BY due_at, id LIMIT ?`,
  ).all(dueAt, limit) as ScoutNotificationRow[];
  return rows.map(toScoutNotification);
}

export function listAttemptedScoutNotifications(db: Database.Database): ScoutNotification[] {
  const rows = db.prepare("SELECT * FROM scout_notifications WHERE state = 'attempted' ORDER BY attempted_at, id")
    .all() as ScoutNotificationRow[];
  return rows.map(toScoutNotification);
}

export function claimScoutNotificationAttempt(
  db: Database.Database,
  notificationId: number,
  attemptedAt: number,
  payload: ScoutNotificationPayload,
): boolean {
  return db.prepare(
    `UPDATE scout_notifications
     SET state = 'attempted', attempted_at = ?, payload_json = ?
     WHERE id = ? AND state = 'scheduled' AND due_at <= ?`,
  ).run(attemptedAt, JSON.stringify(payload), notificationId, attemptedAt).changes === 1;
}

export function markScoutNotificationSent(
  db: Database.Database,
  notificationId: number,
  messageId: string,
  sentAt: number,
): boolean {
  return db.prepare(
    `UPDATE scout_notifications SET state = 'sent', message_id = ?, sent_at = ?
     WHERE id = ? AND state = 'attempted'`,
  ).run(messageId, sentAt, notificationId).changes === 1;
}

export function skipScheduledScoutNotification(
  db: Database.Database,
  notificationId: number,
  reason: string,
): boolean {
  return db.prepare(
    `UPDATE scout_notifications SET state = 'skipped', skipped_reason = ?
     WHERE id = ? AND state = 'scheduled'`,
  ).run(reason, notificationId).changes === 1;
}

export function hasScoutNotificationAttemptSince(
  db: Database.Database,
  setupId: number,
  kind: ScoutNotificationKind,
  gameNumber: 1 | 2 | null,
  since: number,
): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM scout_notifications
     WHERE setup_id = ? AND kind = ? AND game_number IS ?
       AND state IN ('attempted', 'sent') AND attempted_at >= ?
     LIMIT 1`,
  ).get(setupId, kind, gameNumber, since));
}
