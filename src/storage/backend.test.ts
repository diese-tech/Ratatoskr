import assert from 'node:assert/strict';
import test from 'node:test';
import { openApplicationStorage, resolveDatabaseBackend } from './index.js';

test('database backend defaults to sqlite even when DATABASE_URL exists', () => {
  assert.equal(resolveDatabaseBackend({}), 'sqlite');
  assert.equal(resolveDatabaseBackend({ DATABASE_URL: 'postgresql://must-not-select-a-backend' }), 'sqlite');
});

test('database backend accepts only an explicit supported selector', () => {
  assert.equal(resolveDatabaseBackend({ DATABASE_BACKEND: 'sqlite' }), 'sqlite');
  assert.equal(resolveDatabaseBackend({ DATABASE_BACKEND: 'postgres' }), 'postgres');
  assert.throws(
    () => resolveDatabaseBackend({ DATABASE_BACKEND: 'mysql' }),
    /DATABASE_BACKEND must be either "sqlite" or "postgres"/,
  );
});

test('explicit postgres selection fails closed until its adapter is implemented', () => {
  assert.throws(
    () => openApplicationStorage({ environment: { DATABASE_BACKEND: 'postgres' }, sqlitePath: ':memory:' }),
    /Postgres storage is not implemented/,
  );
});

test('sqlite storage exposes asynchronous season operations and closes cleanly', async () => {
  const storage = openApplicationStorage({ environment: { DATABASE_BACKEND: 'sqlite' }, sqlitePath: ':memory:' });

  assert.equal(storage.backend, 'sqlite');
  const pendingSeason = storage.seasons.getActiveSeason('guild-1');
  assert.ok(pendingSeason instanceof Promise);
  assert.equal(await pendingSeason, undefined);

  await storage.close();
  assert.equal(storage.legacyDatabase.open, false);
});
