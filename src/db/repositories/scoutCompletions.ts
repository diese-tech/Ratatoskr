import type Database from 'better-sqlite3';
import { getScoutSetupById } from './scoutSetups.js';

export type ScoutCompletion = { setup_id: number; finished_by: string; finished_at: string; posts_reconciled: 0 | 1 };

export function getScoutCompletion(db: Database.Database, setupId: number): ScoutCompletion | undefined {
  return db.prepare('SELECT * FROM scout_completions WHERE setup_id = ?').get(setupId) as ScoutCompletion | undefined;
}

export function listPendingScoutCompletions(db: Database.Database): ScoutCompletion[] {
  return db.prepare('SELECT * FROM scout_completions WHERE posts_reconciled = 0 ORDER BY setup_id').all() as ScoutCompletion[];
}

export function markScoutCompletionReconciled(db: Database.Database, setupId: number): void {
  db.prepare('UPDATE scout_completions SET posts_reconciled = 1 WHERE setup_id = ?').run(setupId);
}

/** Completion preserves published history; it is a separate terminal record, not a cancelled match. */
export function finishScoutSetupIfVersion(db: Database.Database, setupId: number, expectedVersion: number, actorId: string):
  'finished' | 'already_finished' | 'stale' | 'not_published' | 'pending' {
  return db.transaction(() => {
    if (getScoutCompletion(db, setupId)) return 'already_finished';
    const setup = getScoutSetupById(db, setupId);
    if (!setup || setup.version !== expectedVersion) return 'stale';
    if (setup.status !== 'published') return 'not_published';
    if (!setup.resultMessageId || !setup.signupPostReconciled
      || db.prepare('SELECT 1 FROM scout_roster_updates WHERE setup_id = ?').get(setupId)) return 'pending';
    db.prepare('INSERT INTO scout_completions (setup_id, finished_by) VALUES (?, ?)').run(setupId, actorId);
    db.prepare("UPDATE scout_setups SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(setupId);
    return 'finished';
  })();
}
