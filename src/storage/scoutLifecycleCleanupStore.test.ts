import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cancelScoutSetupIfVersion,
  createScoutSetup,
  finishScoutSetupIfVersion,
  getScoutCompletion,
  getScoutNotificationByDedupeKey,
  listScoutEvents,
  scheduleScoutNotification,
  setScoutSetupSignupMessage,
} from '../db/index.js';
import { openApplicationStorage } from './index.js';

test('lifecycle cleanup cancels an open Scout only at its fixed three-hour deadline', async () => {
  const storage = openApplicationStorage({ sqlitePath: ':memory:' });
  try {
    const division = await storage.divisions.upsertDivision({
      guildId: 'guild', divisionKey: 'vanaheim', displayName: 'Vanaheim',
    });
    const setup = createScoutSetup(storage.legacyDatabase, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 2_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(storage.legacyDatabase, setup.id, 'signup');
    const notification = scheduleScoutNotification(storage.legacyDatabase, {
      setupId: setup.id, kind: 'manual_roster', dedupeKey: `manual:${setup.id}:deadline`,
      nonce: 'deadline', channelId: 'signups', dueAt: 3_000,
    }).notification;

    assert.deepEqual(await storage.scoutLifecycleCleanup.listDueSetups(12_799), []);
    assert.equal(
      (await storage.scoutLifecycleCleanup.closeDueSetup(setup.id, 12_799, 'ratatoskr')).status,
      'not_due',
    );

    assert.deepEqual(
      (await storage.scoutLifecycleCleanup.listDueSetups(12_800)).map((candidate) => candidate.id),
      [setup.id],
    );
    assert.equal(
      (await storage.scoutLifecycleCleanup.closeDueSetup(setup.id, 12_800, 'ratatoskr')).status,
      'cancelled',
    );
    assert.equal((await storage.scoutLifecycleCleanup.getSetup(setup.id))?.status, 'cancelled');
    assert.deepEqual(await storage.scoutLifecycleCleanup.getCleanup(setup.id), {
      setupId: setup.id,
      action: 'cancelled',
      statusBefore: 'open',
      reason: 'automatic_deadline',
      scheduledStartAt: 2_000,
      deadlineAt: 12_800,
      processedAt: 12_800,
      actorUserId: 'ratatoskr',
      discordState: 'pending',
      discordReconciledAt: null,
      alertAttemptedAt: null,
      alertReference: null,
      alertDeliveredAt: null,
      lastErrorAt: null,
    });
    assert.equal(getScoutNotificationByDedupeKey(storage.legacyDatabase, notification.dedupeKey)?.state, 'skipped');
  } finally {
    await storage.close();
  }
});

test('due lifecycle paging prioritizes closable setups ahead of retained recovery rows', async () => {
  const storage = openApplicationStorage({ sqlitePath: ':memory:' });
  try {
    const division = await storage.divisions.upsertDivision({
      guildId: 'guild', divisionKey: 'vanaheim', displayName: 'Vanaheim',
    });
    for (let index = 0; index < 25; index += 1) {
      const recovery = createScoutSetup(storage.legacyDatabase, {
        guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
        divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
        resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
        emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
        startAt: 2_000, roleLimit: 2,
      });
      storage.legacyDatabase.prepare("UPDATE scout_setups SET status = 'posting_failed' WHERE id = ?")
        .run(recovery.id);
    }
    const closable = createScoutSetup(storage.legacyDatabase, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 2_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(storage.legacyDatabase, closable.id, 'closable-signup');

    const due = await storage.scoutLifecycleCleanup.listDueSetups(12_800, 25);
    assert.equal(due[0]?.id, closable.id);
    assert.equal(due.filter((setup) => ['open', 'roster_ready', 'published'].includes(setup.status)).length, 1);
  } finally {
    await storage.close();
  }
});

test('posting recovery paging advances past previously attempted failures', async () => {
  const storage = openApplicationStorage({ sqlitePath: ':memory:' });
  try {
    const division = await storage.divisions.upsertDivision({
      guildId: 'guild', divisionKey: 'vanaheim', displayName: 'Vanaheim',
    });
    const ids: number[] = [];
    for (let index = 0; index < 26; index += 1) {
      const setup = createScoutSetup(storage.legacyDatabase, {
        guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
        divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
        resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
        emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
        startAt: 2_000, roleLimit: 2,
      });
      storage.legacyDatabase.prepare("UPDATE scout_setups SET status = 'posting_failed' WHERE id = ?")
        .run(setup.id);
      ids.push(setup.id);
    }
    const firstPage = await storage.scoutLifecycleCleanup.listDueSetups(12_800, 25);
    assert.deepEqual(firstPage.map((setup) => setup.id), ids.slice(0, 25));
    for (const setup of firstPage) {
      await storage.scoutLifecycleCleanup.recordRecoveryAttempt(setup.id, 12_800);
    }
    assert.equal((await storage.scoutLifecycleCleanup.listDueSetups(12_815, 1))[0]?.id, ids[25]);
  } finally {
    await storage.close();
  }
});

test('pending Discord cleanup paging advances past failing rows', async () => {
  const storage = openApplicationStorage({ sqlitePath: ':memory:' });
  try {
    const division = await storage.divisions.upsertDivision({
      guildId: 'guild', divisionKey: 'vanaheim', displayName: 'Vanaheim',
    });
    const ids: number[] = [];
    for (let index = 0; index < 26; index += 1) {
      const setup = createScoutSetup(storage.legacyDatabase, {
        guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
        divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
        resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
        emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
        startAt: 2_000, roleLimit: 2,
      });
      setScoutSetupSignupMessage(storage.legacyDatabase, setup.id, `signup-${index}`);
      await storage.scoutLifecycleCleanup.closeDueSetup(setup.id, 12_800, 'ratatoskr');
      ids.push(setup.id);
    }
    const firstPage = await storage.scoutLifecycleCleanup.listPendingCleanups(25);
    assert.deepEqual(firstPage.map((cleanup) => cleanup.setupId), ids.slice(0, 25));
    for (const cleanup of firstPage) {
      await storage.scoutLifecycleCleanup.recordDiscordFailure(cleanup.setupId, 12_800);
    }
    assert.equal((await storage.scoutLifecycleCleanup.listPendingCleanups(1))[0]?.setupId, ids[25]);
  } finally {
    await storage.close();
  }
});

test('an overdue two-game roster-ready Scout cancels as one setup', async () => {
  const storage = openApplicationStorage({ sqlitePath: ':memory:' });
  try {
    const division = await storage.divisions.upsertDivision({
      guildId: 'guild', divisionKey: 'helheim', displayName: 'Helheim',
    });
    const setup = createScoutSetup(storage.legacyDatabase, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 2_000, roleLimit: 4,
    });
    setScoutSetupSignupMessage(storage.legacyDatabase, setup.id, 'signup-two-games');
    storage.legacyDatabase.prepare("UPDATE scout_setups SET status = 'roster_ready', game_count = 2 WHERE id = ?").run(setup.id);

    assert.equal(
      (await storage.scoutLifecycleCleanup.closeDueSetup(setup.id, 12_800, 'ratatoskr')).status,
      'cancelled',
    );
    assert.equal((await storage.scoutLifecycleCleanup.getCleanup(setup.id))?.statusBefore, 'roster_ready');
    assert.equal((await storage.scoutLifecycleCleanup.getSetup(setup.id))?.gameCount, 2);
  } finally {
    await storage.close();
  }
});

test('manual and automatic terminal races leave exactly one authoritative action', async () => {
  const storage = openApplicationStorage({ sqlitePath: ':memory:' });
  try {
    const division = await storage.divisions.upsertDivision({
      guildId: 'guild', divisionKey: 'asgard', displayName: 'Asgard',
    });
    const makePublished = (suffix: string) => {
      const setup = createScoutSetup(storage.legacyDatabase, {
        guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
        divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
        resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
        emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
        startAt: 2_000, roleLimit: 2,
      });
      setScoutSetupSignupMessage(storage.legacyDatabase, setup.id, `signup-${suffix}`);
      storage.legacyDatabase.prepare(`UPDATE scout_setups
        SET status = 'published', result_message_id = ?, signup_post_reconciled = 1
        WHERE id = ?`).run(`result-${suffix}`, setup.id);
      return setup;
    };

    const manualWinner = makePublished('manual');
    assert.equal(finishScoutSetupIfVersion(storage.legacyDatabase, manualWinner.id, 0, 'staff'), 'finished');
    assert.equal(
      (await storage.scoutLifecycleCleanup.closeDueSetup(manualWinner.id, 12_800, 'ratatoskr')).status,
      'already_final',
    );
    assert.equal(await storage.scoutLifecycleCleanup.getCleanup(manualWinner.id), undefined);

    const automaticWinner = makePublished('automatic');
    assert.equal(
      (await storage.scoutLifecycleCleanup.closeDueSetup(automaticWinner.id, 12_800, 'ratatoskr')).status,
      'finished',
    );
    assert.equal(
      finishScoutSetupIfVersion(storage.legacyDatabase, automaticWinner.id, 0, 'staff'),
      'already_finished',
    );
    assert.equal((await storage.scoutLifecycleCleanup.getCleanup(automaticWinner.id))?.actorUserId, 'ratatoskr');

    const manualCancelWinner = createScoutSetup(storage.legacyDatabase, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 2_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(storage.legacyDatabase, manualCancelWinner.id, 'signup-manual-cancel');
    assert.equal(cancelScoutSetupIfVersion(storage.legacyDatabase, manualCancelWinner.id, 0), 'cancelled');
    assert.equal(
      (await storage.scoutLifecycleCleanup.closeDueSetup(manualCancelWinner.id, 12_800, 'ratatoskr')).status,
      'already_final',
    );
    assert.equal(await storage.scoutLifecycleCleanup.getCleanup(manualCancelWinner.id), undefined);

    const automaticCancelWinner = createScoutSetup(storage.legacyDatabase, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 2_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(storage.legacyDatabase, automaticCancelWinner.id, 'signup-automatic-cancel');
    assert.equal(
      (await storage.scoutLifecycleCleanup.closeDueSetup(automaticCancelWinner.id, 12_800, 'ratatoskr')).status,
      'cancelled',
    );
    assert.equal(
      cancelScoutSetupIfVersion(storage.legacyDatabase, automaticCancelWinner.id, 0),
      'already_cancelled',
    );
  } finally {
    await storage.close();
  }
});

test('lifecycle cleanup finishes a published Scout despite pending Discord repair and remains idempotent', async () => {
  const storage = openApplicationStorage({ sqlitePath: ':memory:' });
  try {
    const division = await storage.divisions.upsertDivision({
      guildId: 'guild', divisionKey: 'alfheim', displayName: 'Alfheim',
    });
    const setup = createScoutSetup(storage.legacyDatabase, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 5_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(storage.legacyDatabase, setup.id, 'signup');
    storage.legacyDatabase.prepare("UPDATE scout_setups SET status = 'published' WHERE id = ?").run(setup.id);
    storage.legacyDatabase.prepare(`INSERT INTO scout_roster_updates
      (setup_id, version, notice) VALUES (?, 0, 'pending roster repair')`).run(setup.id);

    const first = await storage.scoutLifecycleCleanup.closeDueSetup(setup.id, 15_800, 'ratatoskr');
    assert.equal(first.status, 'finished');
    assert.equal(getScoutCompletion(storage.legacyDatabase, setup.id)?.finished_by, 'ratatoskr');
    assert.equal((await storage.scoutLifecycleCleanup.getSetup(setup.id))?.version, 0);
    assert.ok(storage.legacyDatabase.prepare('SELECT 1 FROM scout_roster_updates WHERE setup_id = ?').get(setup.id));
    assert.equal((await storage.scoutLifecycleCleanup.getCleanup(setup.id))?.statusBefore, 'published');

    assert.equal(
      (await storage.scoutLifecycleCleanup.closeDueSetup(setup.id, 15_801, 'ratatoskr')).status,
      'already_final',
    );
    assert.equal(
      listScoutEvents(storage.legacyDatabase, setup.id)
        .filter((event) => event.eventType === 'scout_automatically_finished').length,
      1,
    );
  } finally {
    await storage.close();
  }
});
