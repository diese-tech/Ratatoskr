import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { openApplicationStorage } from './index.js';
import { migrations } from '../db/migrations.js';
import { enqueueLeagueJob } from '../db/repositories/leagueJobs.js';

function temporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'ratatoskr-storage-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('local application storage creates a database and production reopens it with its data', async (t) => {
  const path = join(temporaryDirectory(t), 'local', 'ratatoskr.db');
  const local = openApplicationStorage({ environment: { DATABASE_PATH: path } });
  try {
    local.legacyDatabase.pragma('user_version = 123');
  } finally {
    await local.close();
  }

  const production = openApplicationStorage({
    environment: { RAILWAY_ENVIRONMENT_NAME: 'production', DATABASE_PATH: path },
  });
  try {
    assert.equal(production.legacyDatabase.pragma('user_version', { simple: true }), 123);
  } finally {
    await production.close();
  }
});

test('production requires an explicit absolute database path', () => {
  for (const path of [undefined, ' ', ':memory:', 'data/ratatoskr.db']) {
    assert.throws(
      () => openApplicationStorage({ environment: { NODE_ENV: 'production', DATABASE_PATH: path } }),
      /Production SQLite requires DATABASE_PATH/,
    );
  }
});

test('Railway production leaves a missing database and its directory absent', (t) => {
  const path = join(temporaryDirectory(t), 'missing-volume', 'ratatoskr.db');
  assert.throws(
    () => openApplicationStorage({ environment: { RAILWAY_ENVIRONMENT_NAME: 'production', DATABASE_PATH: path } }),
    /Production SQLite could not be opened/,
  );
  assert.equal(existsSync(dirname(path)), false);
});

test('production refuses empty, uninitialized, and corrupt databases before migrations', (t) => {
  const directory = temporaryDirectory(t);
  const uninitialized = join(directory, 'uninitialized.db');
  const db = new Database(uninitialized);
  db.pragma('user_version = 1');
  db.close();

  const empty = join(directory, 'empty.db');
  writeFileSync(empty, '');
  const corrupt = join(directory, 'corrupt.db');
  writeFileSync(corrupt, 'not a SQLite database');
  for (const path of [empty, uninitialized, corrupt]) {
    const before = readFileSync(path);
    assert.throws(
      () => openApplicationStorage({ environment: { NODE_ENV: 'production', DATABASE_PATH: path } }),
      /Production SQLite could not be opened/,
    );
    assert.deepEqual(readFileSync(path), before);
  }
});

test('production does not create a missing file in an existing writable directory', (t) => {
  const path = join(temporaryDirectory(t), 'missing.db');
  assert.throws(() => openApplicationStorage({ environment: { NODE_ENV: 'production', DATABASE_PATH: path } }),
    /Production SQLite could not be opened/);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(`${path}-wal`), false);
});

test('production rejects a conflicting sqlitePath override before opening either path', (t) => {
  const directory = temporaryDirectory(t);
  const configured = join(directory, 'configured.db');
  const override = join(directory, 'override.db');
  assert.throws(() => openApplicationStorage({ sqlitePath: override,
    environment: { NODE_ENV: 'production', DATABASE_PATH: configured } }), /must use the configured DATABASE_PATH/);
  assert.equal(existsSync(configured), false);
  assert.equal(existsSync(override), false);
});

test('production rejects an existing ledger without initialization marker without migrating', (t) => {
  const path = join(temporaryDirectory(t), 'missing-marker.db');
  const db = new Database(path);
  db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO schema_migrations VALUES (2, \'not initialized\');');
  db.close();
  const before = readFileSync(path);
  assert.throws(() => openApplicationStorage({ environment: { NODE_ENV: 'production', DATABASE_PATH: path } }),
    /Production SQLite could not be opened/);
  assert.deepEqual(readFileSync(path), before);
});

test('read-only inspection leaves an older database untouched; production migration preserves durable records', async (t) => {
  const path = join(temporaryDirectory(t), 'older.db');
  const db = new Database(path);
  db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT);');
  for (const migration of migrations.filter(item => item.id < 37)) {
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_migrations (id,name) VALUES (?,?)').run(migration.id, migration.name);
  }
  db.prepare(`INSERT INTO league_transactions (reference,guild_id,kind,actor_user_id,payload_json,status)
    VALUES ('retained-transaction','g','departure','actor','{}','reconciliation_required')`).run();
  const job = enqueueLeagueJob(db, { guildId: 'g', type: 'transaction', payload: { selections: '["departure","player",null]' },
    dedupeKey: 'retained-approval', now: new Date('2026-11-01T00:00:00Z') });
  const beforeJob = db.prepare('SELECT * FROM league_jobs WHERE reference=?').get(job.reference);
  const beforeApprovals = db.prepare('SELECT * FROM league_job_approvals').all();
  db.close();

  const bytes = readFileSync(path);
  const inspected = new Database(path, { readonly: true, fileMustExist: true });
  assert.equal(inspected.pragma('quick_check', { simple: true }), 'ok');
  assert.equal((inspected.prepare('SELECT max(id) AS id FROM schema_migrations').get() as { id: number }).id, 36);
  inspected.close();
  assert.deepEqual(readFileSync(path), bytes);

  const storage = openApplicationStorage({ environment: { NODE_ENV: 'production', DATABASE_PATH: path } });
  try {
    const migrated = storage.legacyDatabase;
    assert.equal((migrated.prepare('SELECT max(id) AS id FROM schema_migrations').get() as { id: number }).id, 37);
    assert.deepEqual(migrated.prepare('SELECT * FROM league_jobs WHERE reference=?').get(job.reference), beforeJob);
    assert.deepEqual(migrated.prepare('SELECT * FROM league_job_approvals').all(), beforeApprovals);
    assert.equal((migrated.prepare("SELECT status FROM league_transactions WHERE reference='retained-transaction'").get() as { status: string }).status, 'reconciliation_required');
  } finally { await storage.close(); }
});
