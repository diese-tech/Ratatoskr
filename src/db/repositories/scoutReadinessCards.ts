import type Database from 'better-sqlite3';
import type { ScoutReadinessSnapshot } from '../../domain/scoutReadiness.js';

export type ScoutReadinessCard = { setup_id: number; telemetry_message_id: string | null;
  telemetry_attempted: number; control_attempted: number; snapshot_json: string | null };

export function ensureScoutReadinessCard(db: Database.Database, setupId: number): ScoutReadinessCard {
  db.prepare(`INSERT OR IGNORE INTO scout_readiness_cards (setup_id, control_attempted)
    SELECT id, CASE WHEN control_message_id IS NULL THEN 0 ELSE 1 END FROM scout_setups WHERE id = ?`).run(setupId);
  return db.prepare('SELECT * FROM scout_readiness_cards WHERE setup_id = ?').get(setupId) as ScoutReadinessCard;
}

export function patchScoutReadinessCard(db: Database.Database, setupId: number,
  changes: Partial<Omit<ScoutReadinessCard, 'setup_id'>>): void {
  const keys = (['telemetry_message_id', 'telemetry_attempted', 'control_attempted', 'snapshot_json'] as const)
    .filter((key) => changes[key] !== undefined);
  if (keys.length) db.prepare(`UPDATE scout_readiness_cards SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE setup_id = ?`)
    .run(...keys.map((key) => changes[key]), setupId);
}

export function readScoutReadinessSnapshot(card: ScoutReadinessCard): ScoutReadinessSnapshot | undefined {
  return card.snapshot_json ? JSON.parse(card.snapshot_json) as ScoutReadinessSnapshot : undefined;
}

export function listScoutReadinessSetupIds(db: Database.Database): number[] {
  return (db.prepare(`SELECT s.id FROM scout_setups s WHERE s.operations_channel_id IS NOT NULL
    AND s.status IN ('open', 'roster_ready', 'published', 'cancelled')
    AND (s.status IN ('open', 'roster_ready') OR s.control_message_id IS NOT NULL
      OR EXISTS (SELECT 1 FROM scout_readiness_cards c WHERE c.setup_id = s.id)) ORDER BY s.id`).all() as { id: number }[]).map((row) => row.id);
}
