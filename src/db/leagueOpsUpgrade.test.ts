import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrations } from './migrations.js';
import { runMigrations } from './migrate.js';
import { getLeagueAuditState } from './repositories/leagueAudits.js';
import { getLeaguePreviewApproval, getLeagueTransactionPreviewFingerprint } from './repositories/leagueOperations.js';
import { enqueueLeagueJob } from './repositories/leagueJobs.js';
test('migration 30 preserves v29 preview approvals and authoritative audit card identity, and is idempotent', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE schema_migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL)');
    for (const migration of migrations.filter((m) => m.id < 30)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(migration.id, migration.name);
    }
    db.prepare(
      "INSERT INTO league_transaction_previews(guild_id,actor_user_id,intent_key,plan_fingerprint) VALUES('g','admin','intent','approved')",
    ).run();
    db.prepare(
      "INSERT INTO league_audit_cards(guild_id,result,findings_json,run_reference,run_at,trigger,phase,current_message_id) VALUES('g','dirty','[]','old-reference','2026-10-05T12:00:00Z','startup','settled','existing-card')",
    ).run();
    runMigrations(db);
    runMigrations(db);
    assert.equal(getLeagueAuditState(db, 'g')?.currentMessageId, 'existing-card');
    assert.equal(getLeagueTransactionPreviewFingerprint(db, 'g', 'admin', 'intent'), 'approved');
    assert.equal(getLeaguePreviewApproval(db, 'g', 'admin', 'intent'), 'approved');
    const job = enqueueLeagueJob(db, {
      guildId: 'g',
      type: 'transaction',
      payload: { selections: 'intent' },
      dedupeKey: 'approved',
    });
    assert.equal(job.status, 'QUEUED');
    assert.ok(job.reference.length <= 25);
    assert.equal(
      (db.prepare('SELECT count(*) count FROM schema_migrations WHERE id=30').get() as { count: number }).count,
      1,
    );
  } finally {
    db.close();
  }
});
