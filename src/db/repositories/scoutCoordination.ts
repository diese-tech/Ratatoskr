import type Database from 'better-sqlite3';
import type { ScoutCoordination } from '../types.js';

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
