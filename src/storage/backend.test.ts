import assert from 'node:assert/strict';
import test from 'node:test';
import { createScoutSetup, setScoutOperationsChannel } from '../db/index.js';
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

test('managed-resource storage persists parent reconciliation and purge tombstones', async () => {
  const storage = openApplicationStorage({ sqlitePath: ':memory:' });

  try {
    const inserted = await storage.managedResources.insertManagedResource({
      discordResourceId: 'channel-1',
      guildId: 'guild-1',
      resourceType: 'text_channel',
      logicalKey: 'division:vanaheim:channel:general:text_channel',
      parentResourceId: 'category-old',
      scaffoldDomain: 'division',
    });

    await storage.managedResources.setManagedResourceParent(inserted.id, 'category-new');
    assert.equal(
      (await storage.managedResources.getActiveManagedResourceByLogicalKey('guild-1', inserted.logicalKey))
        ?.parentResourceId,
      'category-new',
    );

    await storage.managedResources.markManagedResourcePurged(inserted.id);
    assert.equal(
      await storage.managedResources.getActiveManagedResourceByLogicalKey('guild-1', inserted.logicalKey),
      undefined,
    );
  } finally {
    await storage.close();
  }
});

test('sqlite storage exposes asynchronous division lifecycle operations', async () => {
  const storage = openApplicationStorage({ environment: { DATABASE_BACKEND: 'sqlite' }, sqlitePath: ':memory:' });

  try {
    const pendingDivision = storage.divisions.upsertDivision({
      guildId: 'guild-1',
      divisionKey: 'vanaheim',
      displayName: 'Vanaheim',
    });
    assert.ok(pendingDivision instanceof Promise);
    const division = await pendingDivision;
    setScoutOperationsChannel(storage.legacyDatabase, 'guild-1', 'scout-category', 'scout-ops');
    const setup = createScoutSetup(storage.legacyDatabase, {
      guildId: 'guild-1',
      divisionId: division.id,
      divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName,
      createdBy: 'staff-1',
      signupChannelId: 'signups',
      resultsChannelId: 'results',
      divisionRoleId: 'division-role',
      emojiByRole: {
        solo: 'solo',
        jungle: 'jungle',
        mid: 'mid',
        support: 'support',
        carry: 'carry',
        fill: null,
      },
      startAt: 2_000_000_000,
      roleLimit: 2,
    });

    assert.equal((await storage.divisions.getDivisionByKey('guild-1', 'vanaheim'))?.id, division.id);
    assert.deepEqual(
      (await storage.divisions.listDivisionScoutLifecycleBlockers('guild-1', division.id)).map((blocker) => blocker.id),
      [setup.id],
    );
    const pendingScoutConfig = storage.divisions.getScoutConfig('guild-1');
    assert.ok(pendingScoutConfig instanceof Promise);
    assert.equal((await pendingScoutConfig)?.operationsChannelId, 'scout-ops');

    await storage.divisions.setDivisionStatus('guild-1', 'vanaheim', 'archived');
    assert.equal((await storage.divisions.getDivisionByKey('guild-1', 'vanaheim'))?.status, 'archived');
  } finally {
    await storage.close();
  }
});
