import type Database from 'better-sqlite3';
import type { ScoutCoordination } from '../types.js';
import { appendScoutEvent } from './scoutEvents.js';

type ScoutCoordinationRow = {
  setup_id: number;
  organizer_user_id: string;
  created_at: string;
  updated_at: string;
};

function toScoutCoordination(row: ScoutCoordinationRow): ScoutCoordination {
  return {
    setupId: row.setup_id,
    organizerUserId: row.organizer_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getScoutCoordination(
  db: Database.Database,
  setupId: number,
): ScoutCoordination | undefined {
  const row = db.prepare('SELECT * FROM scout_coordination WHERE setup_id = ?')
    .get(setupId) as ScoutCoordinationRow | undefined;
  return row ? toScoutCoordination(row) : undefined;
}

export type ChangeScoutOrganizerOutcome = 'updated' | 'unchanged' | 'stale';

export function changeScoutOrganizerIfVersion(
  db: Database.Database,
  setupId: number,
  expectedVersion: number,
  organizerUserId: string,
  actorUserId: string,
): ChangeScoutOrganizerOutcome {
  if (!organizerUserId) return 'stale';
  return db.transaction((): ChangeScoutOrganizerOutcome => {
    const current = getScoutCoordination(db, setupId);
    if (current?.organizerUserId === organizerUserId) return 'unchanged';
    const claimed = db.prepare(
      `UPDATE scout_setups SET version = version + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND version = ? AND status = 'published'
         AND result_message_id IS NOT NULL AND signup_post_reconciled = 1
         AND NOT EXISTS (SELECT 1 FROM scout_roster_updates WHERE setup_id = scout_setups.id)
         AND NOT EXISTS (SELECT 1 FROM scout_completions WHERE setup_id = scout_setups.id)`,
    ).run(setupId, expectedVersion);
    if (claimed.changes !== 1 || !current) return 'stale';
    db.prepare(
      `UPDATE scout_coordination SET organizer_user_id = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE setup_id = ?`,
    ).run(organizerUserId, setupId);
    db.prepare("INSERT INTO scout_roster_updates (setup_id, version, notice) VALUES (?, ?, '')")
      .run(setupId, expectedVersion + 1);
    appendScoutEvent(db, {
      setupId,
      setupVersion: expectedVersion + 1,
      eventType: 'organizer_changed',
      actorUserId,
      payload: { previousUserId: current.organizerUserId, organizerUserId },
    });
    return 'updated';
  })();
}
