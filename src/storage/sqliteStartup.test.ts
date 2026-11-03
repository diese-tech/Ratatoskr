import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { openApplicationStorage } from './index.js';

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
