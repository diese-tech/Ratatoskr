import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendScoutEvent, createScoutSetup, listScoutEvents, setScoutSetupSignupMessage } from '../db/index.js';
import { openApplicationStorage } from '../storage/index.js';
import { processDueScoutLifecycleCleanups } from './scoutLifecycleCleanup.js';
import { tryAcquireDivisionOperation } from './divisionOperation.js';

test('the lifecycle worker closes and reconciles an overdue open Scout once', async () => {
  const application = openApplicationStorage({ sqlitePath: ':memory:' });
  try {
    const division = await application.divisions.upsertDivision({
      guildId: 'guild', divisionKey: 'vanaheim', displayName: 'Vanaheim',
    });
    const setup = createScoutSetup(application.legacyDatabase, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 2_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(application.legacyDatabase, setup.id, 'signup');
    const reconciled: string[] = [];
    const dependencies = {
      storage: application.scoutLifecycleCleanup,
      operationScope: application.operationScope,
      actorUserId: 'ratatoskr',
      recoverPostingSetup: async () => undefined,
      reconcileCancelled: async (setupId: number) => { reconciled.push(`cancel:${setupId}`); },
      reconcileFinished: async (setupId: number) => { reconciled.push(`finish:${setupId}`); },
      refreshStatusCard: async (setupId: number) => { reconciled.push(`card:${setupId}`); },
      reportError: async () => ({ reference: 'unused', staffDelivered: true }),
    };

    await processDueScoutLifecycleCleanups(dependencies, 12_800);
    await processDueScoutLifecycleCleanups(dependencies, 12_801);

    assert.deepEqual(reconciled, [`cancel:${setup.id}`, `card:${setup.id}`]);
    assert.equal((await application.scoutLifecycleCleanup.getCleanup(setup.id))?.discordState, 'reconciled');
  } finally {
    await application.close();
  }
});

test('the lifecycle worker reports an overdue setup as blocked while its division lock is busy', async () => {
  const application = openApplicationStorage({ sqlitePath: ':memory:' });
  try {
    const division = await application.divisions.upsertDivision({
      guildId: 'guild', divisionKey: 'vanaheim', displayName: 'Vanaheim',
    });
    const setup = createScoutSetup(application.legacyDatabase, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 2_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(application.legacyDatabase, setup.id, 'signup');
    const release = tryAcquireDivisionOperation(
      application.operationScope,
      setup.guildId,
      setup.divisionKey,
    )!;
    try {
      const readyForNotifications = await processDueScoutLifecycleCleanups({
        storage: application.scoutLifecycleCleanup,
        operationScope: application.operationScope,
        actorUserId: 'ratatoskr',
        recoverPostingSetup: async () => undefined,
        reconcileCancelled: async () => undefined,
        reconcileFinished: async () => undefined,
        refreshStatusCard: async () => undefined,
        reportError: async () => ({ reference: 'unused', staffDelivered: true }),
      }, 12_800);
      assert.equal(readyForNotifications, false);
      assert.equal((await application.scoutLifecycleCleanup.getSetup(setup.id))?.status, 'open');
    } finally {
      release();
    }
  } finally {
    await application.close();
  }
});

test('the lifecycle worker defers notifications until every overdue closable page is drained', async () => {
  const application = openApplicationStorage({ sqlitePath: ':memory:' });
  try {
    const division = await application.divisions.upsertDivision({
      guildId: 'guild', divisionKey: 'vanaheim', displayName: 'Vanaheim',
    });
    for (let index = 0; index < 26; index += 1) {
      const setup = createScoutSetup(application.legacyDatabase, {
        guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
        divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
        resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
        emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
        startAt: 2_000, roleLimit: 2,
      });
      setScoutSetupSignupMessage(application.legacyDatabase, setup.id, `signup-${index}`);
    }
    const dependencies = {
      storage: application.scoutLifecycleCleanup,
      operationScope: application.operationScope,
      actorUserId: 'ratatoskr',
      recoverPostingSetup: async () => undefined,
      reconcileCancelled: async () => undefined,
      reconcileFinished: async () => undefined,
      refreshStatusCard: async () => undefined,
      reportError: async () => ({ reference: 'unused', staffDelivered: true }),
    };

    assert.equal(await processDueScoutLifecycleCleanups(dependencies, 12_800, 25), false);
    assert.equal(
      (await application.scoutLifecycleCleanup.listDueSetups(12_800, 1))[0]?.status,
      'open',
    );
    assert.equal(await processDueScoutLifecycleCleanups(dependencies, 12_800, 25), true);
    assert.deepEqual(await application.scoutLifecycleCleanup.listDueSetups(12_800, 1), []);
  } finally {
    await application.close();
  }
});

test('restart catch-up uses the original scheduled deadline', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ratatoskr-lifecycle-cleanup-'));
  const path = join(directory, 'restart.db');
  try {
    const beforeRestart = openApplicationStorage({ sqlitePath: path });
    const division = await beforeRestart.divisions.upsertDivision({
      guildId: 'guild', divisionKey: 'vanaheim', displayName: 'Vanaheim',
    });
    const setup = createScoutSetup(beforeRestart.legacyDatabase, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 2_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(beforeRestart.legacyDatabase, setup.id, 'signup');
    await beforeRestart.close();

    const afterRestart = openApplicationStorage({ sqlitePath: path });
    try {
      const dependencies = {
        storage: afterRestart.scoutLifecycleCleanup,
        operationScope: afterRestart.operationScope,
        actorUserId: 'ratatoskr',
        recoverPostingSetup: async () => undefined,
        reconcileCancelled: async () => undefined,
        reconcileFinished: async () => undefined,
        refreshStatusCard: async () => undefined,
        reportError: async () => ({ reference: 'unused', staffDelivered: true }),
      };
      await processDueScoutLifecycleCleanups(dependencies, 20_000);
      assert.equal((await afterRestart.scoutLifecycleCleanup.getSetup(setup.id))?.status, 'cancelled');
      assert.equal((await afterRestart.scoutLifecycleCleanup.getCleanup(setup.id))?.deadlineAt, 12_800);
    } finally {
      await afterRestart.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('overdue posting states never force-close and alert staff once per unresolved setup', async () => {
  const application = openApplicationStorage({ sqlitePath: ':memory:' });
  try {
    const division = await application.divisions.upsertDivision({
      guildId: 'guild', divisionKey: 'jotunheim', displayName: 'Jotunheim',
    });
    const setup = createScoutSetup(application.legacyDatabase, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 2_000, roleLimit: 2,
    });
    const postingFailed = createScoutSetup(application.legacyDatabase, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 2_000, roleLimit: 2,
    });
    application.legacyDatabase.prepare("UPDATE scout_setups SET status = 'posting_failed' WHERE id = ?")
      .run(postingFailed.id);
    let recoveryAttempts = 0;
    const reports: string[] = [];
    const dependencies = {
      storage: application.scoutLifecycleCleanup,
      operationScope: application.operationScope,
      actorUserId: 'ratatoskr',
      recoverPostingSetup: async () => { recoveryAttempts += 1; },
      reconcileCancelled: async () => undefined,
      reconcileFinished: async () => undefined,
      refreshStatusCard: async () => undefined,
      reportError: async (context: { action: string }) => {
        reports.push(context.action);
        return { reference: 'posting-reference', staffDelivered: true };
      },
    };

    await processDueScoutLifecycleCleanups(dependencies, 12_800);
    await processDueScoutLifecycleCleanups(dependencies, 12_815);

    assert.equal(recoveryAttempts, 4);
    assert.equal((await application.scoutLifecycleCleanup.getSetup(setup.id))?.status, 'posting');
    assert.equal((await application.scoutLifecycleCleanup.getSetup(postingFailed.id))?.status, 'posting_failed');
    assert.equal(await application.scoutLifecycleCleanup.getCleanup(setup.id), undefined);
    assert.equal(await application.scoutLifecycleCleanup.getCleanup(postingFailed.id), undefined);
    assert.deepEqual(reports, [
      'Automatic Scout lifecycle recovery',
      'Automatic Scout lifecycle recovery',
    ]);
    assert.equal(
      listScoutEvents(application.legacyDatabase, setup.id)
        .filter((event) => event.eventType === 'scout_automatic_cleanup_recovery_alerted').length,
      1,
    );
    assert.equal(
      listScoutEvents(application.legacyDatabase, postingFailed.id)
        .filter((event) => event.eventType === 'scout_automatic_cleanup_recovery_alerted').length,
      1,
    );
  } finally {
    await application.close();
  }
});

test('an unresolved publication recovery retries a failed staff alert before recording delivery', async () => {
  const application = openApplicationStorage({ sqlitePath: ':memory:' });
  try {
    const division = await application.divisions.upsertDivision({
      guildId: 'guild', divisionKey: 'jotunheim', displayName: 'Jotunheim',
    });
    const setup = createScoutSetup(application.legacyDatabase, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 2_000, roleLimit: 2,
    });
    const references: string[] = [];
    const dependencies = {
      storage: application.scoutLifecycleCleanup,
      operationScope: application.operationScope,
      actorUserId: 'ratatoskr',
      recoverPostingSetup: async () => undefined,
      reconcileCancelled: async () => undefined,
      reconcileFinished: async () => undefined,
      refreshStatusCard: async () => undefined,
      reportError: async (_context: unknown, _error: unknown, reference: string) => {
        references.push(reference);
        return { reference, staffDelivered: references.length > 1 };
      },
    };

    await processDueScoutLifecycleCleanups(dependencies, 12_800);
    assert.equal(listScoutEvents(application.legacyDatabase, setup.id)
      .filter((event) => event.eventType === 'scout_automatic_cleanup_recovery_alerted').length, 0);
    await processDueScoutLifecycleCleanups(dependencies, 12_815);
    assert.equal(references.length, 1, 'staff delivery retries are rate-limited');
    await processDueScoutLifecycleCleanups(dependencies, 12_860);
    await processDueScoutLifecycleCleanups(dependencies, 12_875);

    assert.equal(references.length, 2);
    assert.ok(references[0]);
    assert.equal(references[1], references[0]);
    assert.equal(listScoutEvents(application.legacyDatabase, setup.id)
      .filter((event) => event.eventType === 'scout_automatic_cleanup_recovery_alerted').length, 1);
  } finally {
    await application.close();
  }
});

test('a legacy recovery-alert event does not suppress unconfirmed staff delivery', async () => {
  const application = openApplicationStorage({ sqlitePath: ':memory:' });
  try {
    const division = await application.divisions.upsertDivision({
      guildId: 'guild', divisionKey: 'jotunheim', displayName: 'Jotunheim',
    });
    const setup = createScoutSetup(application.legacyDatabase, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 2_000, roleLimit: 2,
    });
    appendScoutEvent(application.legacyDatabase, {
      setupId: setup.id,
      setupVersion: setup.version,
      eventType: 'scout_automatic_cleanup_recovery_alerted',
      actorUserId: 'ratatoskr',
      payload: { attemptedAt: 12_800 },
    });
    let alertAttempts = 0;
    const dependencies = {
      storage: application.scoutLifecycleCleanup,
      operationScope: application.operationScope,
      actorUserId: 'ratatoskr',
      recoverPostingSetup: async () => undefined,
      reconcileCancelled: async () => undefined,
      reconcileFinished: async () => undefined,
      refreshStatusCard: async () => undefined,
      reportError: async (_context: unknown, _error: unknown, reference: string) => {
        alertAttempts += 1;
        return { reference, staffDelivered: true };
      },
    };

    await processDueScoutLifecycleCleanups(dependencies, 12_860);
    await processDueScoutLifecycleCleanups(dependencies, 12_875);

    assert.equal(alertAttempts, 1);
    assert.equal(listScoutEvents(application.legacyDatabase, setup.id)
      .filter((event) => event.eventType === 'scout_automatic_cleanup_recovery_alerted').length, 1);
  } finally {
    await application.close();
  }
});

test('Discord cleanup retries while its staff alert is durably deduplicated', async () => {
  const application = openApplicationStorage({ sqlitePath: ':memory:' });
  try {
    const division = await application.divisions.upsertDivision({
      guildId: 'guild', divisionKey: 'midgard', displayName: 'Midgard',
    });
    const setup = createScoutSetup(application.legacyDatabase, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 2_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(application.legacyDatabase, setup.id, 'signup');
    let attempts = 0;
    const reports: string[] = [];
    const dependencies = {
      storage: application.scoutLifecycleCleanup,
      operationScope: application.operationScope,
      actorUserId: 'ratatoskr',
      recoverPostingSetup: async () => undefined,
      reconcileCancelled: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('Discord edit failed');
      },
      reconcileFinished: async () => undefined,
      refreshStatusCard: async () => undefined,
      reportError: async (context: { action: string }, _error: unknown, reference: string) => {
        reports.push(context.action);
        return { reference, staffDelivered: true };
      },
    };

    await processDueScoutLifecycleCleanups(dependencies, 12_800);
    await processDueScoutLifecycleCleanups(dependencies, 12_815);
    const firstAlertReference = (await application.scoutLifecycleCleanup.getCleanup(setup.id))?.alertReference;
    assert.ok(firstAlertReference);
    assert.equal((await application.scoutLifecycleCleanup.getCleanup(setup.id))?.discordState, 'pending');
    assert.deepEqual(reports, ['Automatic Scout cancellation cleanup']);

    await processDueScoutLifecycleCleanups(dependencies, 12_830);
    assert.equal(attempts, 3);
    assert.deepEqual(await application.scoutLifecycleCleanup.getCleanup(setup.id), {
      setupId: setup.id,
      action: 'cancelled',
      statusBefore: 'open',
      reason: 'automatic_deadline',
      scheduledStartAt: 2_000,
      deadlineAt: 12_800,
      processedAt: 12_800,
      actorUserId: 'ratatoskr',
      discordState: 'reconciled',
      discordReconciledAt: 12_830,
      alertAttemptedAt: 12_800,
      alertReference: firstAlertReference,
      alertDeliveredAt: 12_800,
      lastErrorAt: 12_815,
    });
  } finally {
    await application.close();
  }
});

test('a failed cleanup staff alert retries with one reference until delivery is confirmed', async () => {
  const application = openApplicationStorage({ sqlitePath: ':memory:' });
  try {
    const division = await application.divisions.upsertDivision({
      guildId: 'guild', divisionKey: 'midgard', displayName: 'Midgard',
    });
    const setup = createScoutSetup(application.legacyDatabase, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 2_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(application.legacyDatabase, setup.id, 'signup');
    const references: string[] = [];
    const dependencies = {
      storage: application.scoutLifecycleCleanup,
      operationScope: application.operationScope,
      actorUserId: 'ratatoskr',
      recoverPostingSetup: async () => undefined,
      reconcileCancelled: async () => { throw new Error('Discord edit failed'); },
      reconcileFinished: async () => undefined,
      refreshStatusCard: async () => undefined,
      reportError: async (_context: unknown, _error: unknown, reference: string) => {
        references.push(reference);
        return { reference, staffDelivered: references.length > 1 };
      },
    };

    await processDueScoutLifecycleCleanups(dependencies, 12_800);
    await processDueScoutLifecycleCleanups(dependencies, 12_815);
    assert.equal(references.length, 1, 'staff delivery retries are rate-limited');
    await processDueScoutLifecycleCleanups(dependencies, 12_860);
    await processDueScoutLifecycleCleanups(dependencies, 12_875);

    assert.equal(references.length, 2);
    assert.ok(references[0]);
    assert.equal(references[1], references[0]);
    assert.equal((await application.scoutLifecycleCleanup.getCleanup(setup.id))?.alertReference, references[0]);
    assert.equal((await application.scoutLifecycleCleanup.getCleanup(setup.id))?.alertDeliveredAt, 12_860);
  } finally {
    await application.close();
  }
});

test('pending lifecycle staff alerts survive restart and retain their references', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ratatoskr-lifecycle-alerts-'));
  const path = join(directory, 'restart.db');
  try {
    const beforeRestart = openApplicationStorage({ sqlitePath: path });
    const division = await beforeRestart.divisions.upsertDivision({
      guildId: 'guild', divisionKey: 'midgard', displayName: 'Midgard',
    });
    const makeSetup = () => createScoutSetup(beforeRestart.legacyDatabase, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 2_000, roleLimit: 2,
    });
    const cleanupSetup = makeSetup();
    setScoutSetupSignupMessage(beforeRestart.legacyDatabase, cleanupSetup.id, 'signup');
    const recoverySetup = makeSetup();
    const firstReferences = new Map<string, string>();
    let deliveredAttempts = 0;
    const dependencies = (application: ReturnType<typeof openApplicationStorage>, delivered: boolean) => ({
      storage: application.scoutLifecycleCleanup,
      operationScope: application.operationScope,
      actorUserId: 'ratatoskr',
      recoverPostingSetup: async () => undefined,
      reconcileCancelled: async () => { throw new Error('Discord edit failed'); },
      reconcileFinished: async () => undefined,
      refreshStatusCard: async () => undefined,
      reportError: async (context: { action: string }, _error: unknown, reference: string) => {
        if (!delivered) firstReferences.set(context.action, reference);
        else {
          deliveredAttempts += 1;
          assert.equal(reference, firstReferences.get(context.action));
        }
        return { reference, staffDelivered: delivered };
      },
    });
    await processDueScoutLifecycleCleanups(dependencies(beforeRestart, false), 12_800);
    assert.equal(firstReferences.size, 2);
    await beforeRestart.close();

    const afterRestart = openApplicationStorage({ sqlitePath: path });
    try {
      await processDueScoutLifecycleCleanups(dependencies(afterRestart, true), 12_860);
      await processDueScoutLifecycleCleanups(dependencies(afterRestart, true), 12_875);
      assert.equal(deliveredAttempts, 2);
      assert.equal((await afterRestart.scoutLifecycleCleanup.getCleanup(cleanupSetup.id))?.alertDeliveredAt, 12_860);
      assert.equal(listScoutEvents(afterRestart.legacyDatabase, recoverySetup.id)
        .filter((event) => event.eventType === 'scout_automatic_cleanup_recovery_alerted').length, 1);
    } finally {
      await afterRestart.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a resolved Discord cleanup does not send its formerly pending staff alert', async () => {
  const application = openApplicationStorage({ sqlitePath: ':memory:' });
  try {
    const division = await application.divisions.upsertDivision({
      guildId: 'guild', divisionKey: 'midgard', displayName: 'Midgard',
    });
    const setup = createScoutSetup(application.legacyDatabase, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 2_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(application.legacyDatabase, setup.id, 'signup');
    let repairAttempts = 0;
    let alertAttempts = 0;
    const dependencies = {
      storage: application.scoutLifecycleCleanup,
      operationScope: application.operationScope,
      actorUserId: 'ratatoskr',
      recoverPostingSetup: async () => undefined,
      reconcileCancelled: async () => {
        repairAttempts += 1;
        if (repairAttempts === 1) throw new Error('Discord edit failed');
      },
      reconcileFinished: async () => undefined,
      refreshStatusCard: async () => undefined,
      reportError: async (_context: unknown, _error: unknown, reference: string) => {
        alertAttempts += 1;
        return { reference, staffDelivered: false };
      },
    };

    await processDueScoutLifecycleCleanups(dependencies, 12_800);
    await processDueScoutLifecycleCleanups(dependencies, 12_815);
    await processDueScoutLifecycleCleanups(dependencies, 12_860);

    assert.equal(alertAttempts, 1);
    assert.equal((await application.scoutLifecycleCleanup.getCleanup(setup.id))?.discordState, 'reconciled');
    assert.equal((await application.scoutLifecycleCleanup.getCleanup(setup.id))?.alertDeliveredAt, null);
  } finally {
    await application.close();
  }
});
