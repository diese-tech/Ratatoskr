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

test('sqlite storage exposes asynchronous managed-resource operations', async () => {
  const storage = openApplicationStorage({ environment: { DATABASE_BACKEND: 'sqlite' }, sqlitePath: ':memory:' });

  try {
    const pendingInsert = storage.managedResources.insertManagedResource({
      discordResourceId: 'role-1',
      guildId: 'guild-1',
      resourceType: 'role',
      logicalKey: 'server:role:admin',
      scaffoldDomain: 'server',
    });
    assert.ok(pendingInsert instanceof Promise);
    const inserted = await pendingInsert;

    assert.equal(
      (await storage.managedResources.getActiveManagedResourceByLogicalKey('guild-1', 'server:role:admin'))?.id,
      inserted.id,
    );
    assert.deepEqual(
      (await storage.managedResources.listManagedResourcesByDomain('guild-1', 'server', 'active')).map(
        (resource) => resource.id,
      ),
      [inserted.id],
    );

    await storage.managedResources.markManagedResourceObsolete(inserted.id);
    assert.equal(
      await storage.managedResources.getActiveManagedResourceByLogicalKey('guild-1', 'server:role:admin'),
      undefined,
    );
  } finally {
    await storage.close();
  }
});
