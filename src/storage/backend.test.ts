import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createScoutSetup,
  getScoutNotificationByDedupeKey,
  scheduleScoutNotification,
  setScoutOperationsChannel,
} from '../db/index.js';
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

test('sqlite storage exposes asynchronous Scout configuration creation', async () => {
  const storage = openApplicationStorage({ sqlitePath: ':memory:' });

  try {
    const pendingConfig = storage.scoutConfiguration.ensureScoutConfig('guild-1');
    assert.ok(pendingConfig instanceof Promise);
    const config = await pendingConfig;
    assert.equal(config.guildId, 'guild-1');
    assert.equal(config.timezone, 'America/New_York');
  } finally {
    await storage.close();
  }
});

test('Scout configuration storage applies every existing mutation without resetting other fields', async () => {
  const storage = openApplicationStorage({ sqlitePath: ':memory:' });

  try {
    const roles = storage.scoutConfiguration.setScoutAuthorizedRoleIds('guild-1', ['staff-a', 'staff-b']);
    assert.ok(roles instanceof Promise);
    await roles;
    await storage.scoutConfiguration.setScoutOperationsChannel('guild-1', 'ops-category', 'ops-channel');
    await storage.scoutConfiguration.setScoutTimezone('guild-1', 'America/Chicago');
    const updated = await storage.scoutConfiguration.setScoutEmojiByRole('guild-1', {
      solo: 'emoji-solo',
      jungle: 'emoji-jungle',
      mid: 'emoji-mid',
      support: 'emoji-support',
      carry: 'emoji-carry',
      fill: null,
    });

    assert.deepEqual(updated.authorizedRoleIds, ['staff-a', 'staff-b']);
    assert.equal(updated.operationsCategoryId, 'ops-category');
    assert.equal(updated.operationsChannelId, 'ops-channel');
    assert.equal(updated.timezone, 'America/Chicago');
    assert.equal(updated.emojiByRole.support, 'emoji-support');
    assert.equal(updated.emojiByRole.fill, null);
  } finally {
    await storage.close();
  }
});

test('sqlite storage exposes asynchronous Scout notification delivery reads', async () => {
  const storage = openApplicationStorage({ sqlitePath: ':memory:' });

  try {
    const division = await storage.divisions.upsertDivision({
      guildId: 'guild-1',
      divisionKey: 'vanaheim',
      displayName: 'Vanaheim',
      roleId: 'division-role',
      managerRoleId: 'manager-role',
      captainRoleId: 'captain-role',
      categoryId: 'category',
    });
    const setup = createScoutSetup(storage.legacyDatabase, {
      guildId: 'guild-1',
      divisionId: division.id,
      divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName,
      createdBy: 'organizer',
      signupChannelId: 'signups',
      resultsChannelId: 'results',
      operationsChannelId: 'ops',
      divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 2_000_000_000,
      roleLimit: 2,
    });
    const notification = scheduleScoutNotification(storage.legacyDatabase, {
      setupId: setup.id,
      kind: 'manual_roster',
      dedupeKey: `manual:${setup.id}:storage-test`,
      nonce: 'storage-test',
      channelId: 'signups',
      dueAt: 100,
    }).notification;
    const pendingDue = storage.scoutNotificationDelivery.listDueNotifications(2_000_000_000, 25);
    assert.ok(pendingDue instanceof Promise);
    assert.deepEqual((await pendingDue).map((row) => row.id), [notification.id]);
    assert.equal((await storage.scoutNotificationDelivery.getSetup(setup.id))?.id, setup.id);
    assert.equal(await storage.scoutNotificationDelivery.hasCompletion(setup.id), false);

    const claim = storage.scoutNotificationDelivery.claimAttempt(notification.id, 100, {
      content: 'payload', links: [], allowedUserIds: [],
    });
    assert.ok(claim instanceof Promise);
    assert.equal(await claim, true);
    assert.deepEqual(
      (await storage.scoutNotificationDelivery.listAttemptedNotifications()).map((row) => row.id),
      [notification.id],
    );
    assert.equal(await storage.scoutNotificationDelivery.markSent(notification.id, 'message-1', 101), true);
    assert.equal(getScoutNotificationByDedupeKey(storage.legacyDatabase, notification.dedupeKey)?.state, 'sent');

    const skipped = scheduleScoutNotification(storage.legacyDatabase, {
      setupId: setup.id,
      kind: 'manual_roster',
      dedupeKey: `manual:${setup.id}:skipped-storage-test`,
      nonce: 'skip-test',
      channelId: 'signups',
      dueAt: 102,
    }).notification;
    assert.equal(await storage.scoutNotificationDelivery.skip(skipped.id, 'test_reason'), true);
    assert.equal(getScoutNotificationByDedupeKey(storage.legacyDatabase, skipped.dedupeKey)?.skippedReason, 'test_reason');
  } finally {
    await storage.close();
  }
});

test('sqlite storage exposes asynchronous Scout signup lifecycle reads', async () => {
  const storage = openApplicationStorage({ sqlitePath: ':memory:' });

  try {
    const pendingSetups = storage.scoutSignups.listActiveSetups();
    assert.ok(pendingSetups instanceof Promise);
    assert.deepEqual(await pendingSetups, []);
    assert.deepEqual(await storage.scoutSignups.listSignups(999), []);
    assert.deepEqual(await storage.scoutSignups.listRosterSlots(999), []);
  } finally {
    await storage.close();
  }
});
