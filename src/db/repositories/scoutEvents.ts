import type Database from 'better-sqlite3';
import type { ScoutEvent } from '../types.js';

type ScoutEventRow = {
  id: number;
  setup_id: number;
  setup_version: number;
  event_type: string;
  actor_user_id: string | null;
  payload_json: string;
  created_at: string;
};

function toScoutEvent(row: ScoutEventRow): ScoutEvent {
  return {
    id: row.id,
    setupId: row.setup_id,
    setupVersion: row.setup_version,
    eventType: row.event_type,
    actorUserId: row.actor_user_id,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

export type AppendScoutEventInput = {
  setupId: number;
  setupVersion: number;
  eventType: string;
  actorUserId?: string | null;
  payload?: Record<string, unknown>;
};

export function appendScoutEvent(db: Database.Database, input: AppendScoutEventInput): ScoutEvent {
  const row = db.prepare(
    `INSERT INTO scout_events (setup_id, setup_version, event_type, actor_user_id, payload_json)
     VALUES (?, ?, ?, ?, ?) RETURNING *`,
  ).get(
    input.setupId,
    input.setupVersion,
    input.eventType,
    input.actorUserId ?? null,
    JSON.stringify(input.payload ?? {}),
  ) as ScoutEventRow;
  return toScoutEvent(row);
}

export function listScoutEvents(db: Database.Database, setupId: number): ScoutEvent[] {
  const rows = db.prepare('SELECT * FROM scout_events WHERE setup_id = ? ORDER BY id')
    .all(setupId) as ScoutEventRow[];
  return rows.map(toScoutEvent);
}
