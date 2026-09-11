import assert from 'node:assert/strict';
import test from 'node:test';
import type { Client } from 'discord.js';
import { closeDatabase, openDatabase } from '../db/client.js';
import { upsertDivision } from '../db/repositories/divisions.js';
import { finishScoutSetupIfVersion } from '../db/repositories/scoutCompletions.js';
import {
  claimScoutNotificationAttempt,
  getScoutNotificationByDedupeKey,
  listDueScoutNotifications,
  scheduleScoutNotification,
} from '../db/repositories/scoutNotifications.js';
import { listScoutEvents } from '../db/repositories/scoutEvents.js';
import {
  createScoutSetup,
  prepareScoutPublication,
  reconcileScoutWorkingRoster,
  setScoutResultMessage,
  setScoutSetupSignupMessage,
} from '../db/repositories/scoutSetups.js';
import { SCOUT_ROLES, SCOUT_TEAMS } from '../domain/index.js';
import {
  processDueScoutNotifications,
  reportUncertainScoutNotifications,
  resolveScoutNotification,
} from './scoutNotifications.js';
import { tryAcquireDivisionOperation } from './divisionOperation.js';
import { createSqliteScoutNotificationDeliveryStore } from '../storage/index.js';
import type { ScoutNotificationDeliveryStore } from '../storage/index.js';
import type { ScoutNotification, ScoutSetup } from '../db/types.js';

function notificationFixture(id: number, setupId: number): ScoutNotification {
  return {
    id,
    setupId,
    gameNumber: null,
    kind: 'manual_roster',
    dedupeKey: `manual:${setupId}:${id}`,
    nonce: `notice-${id}`,
    channelId: `channel-${setupId}`,
    dueAt: 100,
    payload: null,
    state: 'scheduled',
    attemptedAt: null,
    sentAt: null,
    messageId: null,
    skippedReason: null,
    createdAt: '2026-09-10T00:00:00.000Z',
  };
}

function setupFixture(id: number): ScoutSetup {
  return {
    id,
    guildId: 'guild',
    divisionId: id,
    divisionKey: `division-${id}`,
    divisionDisplayName: `Division ${id}`,
    createdBy: 'organizer',
    signupChannelId: `channel-${id}`,
    resultsChannelId: `channel-${id}`,
    operationsChannelId: `ops-${id}`,
    divisionRoleId: `role-${id}`,
    eligibilityRoleId: null,
    signupMessageId: 'signup',
    resultMessageId: 'result',
    controlMessageId: null,
    signupPostReconciled: true,
    emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c', fill: null },
    startAt: 2_000,
    roleLimit: 2,
    note: null,
    status: 'published',
    gameCount: 1,
    version: 1,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
  };
}

test('T-30 resolves the complete current roster and all per-game Hosts, then skips a finished scout', async () => {
  const db = openDatabase(':memory:');
  try {
    const storage = createSqliteScoutNotificationDeliveryStore(db);
    const division = upsertDivision(db, {
      guildId: 'guild', divisionKey: 'alfheim', displayName: 'Alfheim', roleId: 'division-role',
      managerRoleId: 'manager-role', captainRoleId: 'captain-role', categoryId: 'category',
    });
    const setup = createScoutSetup(db, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c', fill: 'f' },
      startAt: 2_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(db, setup.id, 'signup');
    const slots = SCOUT_ROLES.flatMap((role) => SCOUT_TEAMS.map((team, index) => ({
      gameNumber: 1, team, role, userId: `${role}-${index}`,
    })));
    const insert = db.prepare('INSERT INTO scout_signups (setup_id, user_id, role) VALUES (?, ?, ?)');
    for (const slot of slots) insert.run(setup.id, slot.userId, slot.role);
    reconcileScoutWorkingRoster(db, { setupId: setup.id, expectedVersion: 0, slots, source: 'signup' });
    prepareScoutPublication(db, { setupId: setup.id, expectedVersion: 1, now: 0, random: () => 0 });
    setScoutResultMessage(db, setup.id, 'roster');
    const notification = listDueScoutNotifications(db, 200)[0]!;

    const resolved = await resolveScoutNotification(storage, notification);
    assert.equal(resolved.status, 'deliver');
    if (resolved.status === 'deliver') {
      assert.equal(resolved.payload.allowedUserIds.length, 10);
      assert.match(resolved.payload.content, /starts in 30 minutes/);
      assert.match(resolved.payload.content, /Lobby Host/);
      assert.match(resolved.payload.content, /<@solo-0>/);
    }

    assert.equal(finishScoutSetupIfVersion(db, setup.id, 1, 'staff'), 'finished');
    assert.equal((db.prepare("SELECT state FROM scout_notifications WHERE id = ?").get(notification.id) as { state: string }).state, 'skipped');
    assert.equal(listScoutEvents(db, setup.id).at(-1)?.eventType, 'scout_finished');
    assert.deepEqual(await resolveScoutNotification(storage, notification), { status: 'skip', reason: 'finished' });
  } finally {
    closeDatabase(db);
  }
});

test('notification processing sends a claimed row once and never retries an attempted-uncertain row', async () => {
  const db = openDatabase(':memory:');
  try {
    const sqliteStorage = createSqliteScoutNotificationDeliveryStore(db);
    let delayClaims = false;
    let announceClaim!: () => void;
    let releaseClaim!: () => void;
    const claimStarted = new Promise<void>((resolve) => { announceClaim = resolve; });
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const ordering: string[] = [];
    const storage = {
      ...sqliteStorage,
      async claimAttempt(notificationId: number, attemptedAt: number, payload: any) {
        if (delayClaims) {
          ordering.push('claim-started');
          announceClaim();
          await claimGate;
        }
        const claimed = await sqliteStorage.claimAttempt(notificationId, attemptedAt, payload);
        if (delayClaims) ordering.push('claim-complete');
        return claimed;
      },
      async markSent(notificationId: number, messageId: string, sentAt: number) {
        ordering.push('sent-confirmed');
        return sqliteStorage.markSent(notificationId, messageId, sentAt);
      },
    };
    const reports: { context: any; error: unknown }[] = [];
    const dependencies = {
      storage,
      operationScope: db,
      reportError: async (context: any, error: unknown) => { reports.push({ context, error }); },
    };
    const division = upsertDivision(db, {
      guildId: 'guild', divisionKey: 'vanaheim', displayName: 'Vanaheim', roleId: 'division-role',
      managerRoleId: 'manager-role', captainRoleId: 'captain-role', categoryId: 'category',
    });
    const setup = createScoutSetup(db, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 2_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(db, setup.id, 'signup');
    const slots = SCOUT_ROLES.flatMap((role) => SCOUT_TEAMS.map((team, index) => ({
      gameNumber: 1, team, role, userId: `${role}-${index}`,
    })));
    const insert = db.prepare('INSERT INTO scout_signups (setup_id, user_id, role) VALUES (?, ?, ?)');
    for (const slot of slots) insert.run(setup.id, slot.userId, slot.role);
    reconcileScoutWorkingRoster(db, { setupId: setup.id, expectedVersion: 0, slots, source: 'signup' });
    prepareScoutPublication(db, { setupId: setup.id, expectedVersion: 1, now: 0, random: () => 0 });
    setScoutResultMessage(db, setup.id, 'roster');

    const sent: any[] = [];
    const client = { channels: { fetch: async () => ({
      isSendable: () => true,
      send: async (payload: any) => {
        ordering.push('discord-send');
        sent.push(payload);
        return { id: `message-${sent.length}` };
      },
    }) } } as unknown as Client;
    const release = tryAcquireDivisionOperation(db, 'guild', 'vanaheim')!;
    await processDueScoutNotifications(client, dependencies, 200);
    assert.equal(sent.length, 0, 'a concurrent lifecycle operation leaves the row unclaimed');
    release();
    delayClaims = true;
    const processing = processDueScoutNotifications(client, dependencies, 200);
    await claimStarted;
    assert.equal(sent.length, 0, 'Discord send must wait for the durable claim');
    releaseClaim();
    await processing;
    await processDueScoutNotifications(client, dependencies, 200);
    assert.equal(sent.length, 1);
    assert.deepEqual(ordering, ['claim-started', 'claim-complete', 'discord-send', 'sent-confirmed']);
    assert.match(sent[0].content, /starts in 30 minutes/);
    assert.equal(getScoutNotificationByDedupeKey(db, `t30:${setup.id}`)?.state, 'sent');

    const uncertain = scheduleScoutNotification(db, {
      setupId: setup.id, kind: 'manual_roster', dedupeKey: `manual:${setup.id}:uncertain`,
      nonce: 'uncertain', channelId: 'signups', dueAt: 201,
    }).notification;
    assert.equal(claimScoutNotificationAttempt(db, uncertain.id, 201, {
      content: 'possibly delivered', links: [], allowedUserIds: [],
    }), true);
    await processDueScoutNotifications(client, dependencies, 201);
    assert.equal(sent.length, 1);
    assert.equal(getScoutNotificationByDedupeKey(db, uncertain.dedupeKey)?.state, 'attempted');
    await reportUncertainScoutNotifications(dependencies);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.context.action, 'Scout notification recovery');
    assert.match(reports[0]?.context.next, /was not resent/);
  } finally {
    closeDatabase(db);
  }
});

test('concurrent notification polls serialize one setup while different setups progress independently', async () => {
  async function maximumConcurrentSends(setupIds: [number, number]): Promise<number> {
    const notifications = setupIds.map((setupId, index) => notificationFixture(index + 1, setupId));
    let dueCall = 0;
    const storage = {
      async listDueNotifications() { return [notifications[dueCall++]!]; },
      async getSetup(setupId: number) { return setupFixture(setupId); },
      async hasCompletion() { return false; },
      async listRosterSlots(setupId: number) {
        return Array.from({ length: 10 }, (_, index) => ({ userId: `${setupId}-player-${index}` }));
      },
      async listGameHosts(setupId: number) {
        return [{ gameNumber: 1, lobbyHostUserId: `${setupId}-player-0` }];
      },
      async getCoordination() { return undefined; },
      async listEvents() { return []; },
      async listAttemptedNotifications() { return []; },
      async claimAttempt() { return true; },
      async markSent() { return true; },
      async skip() { return true; },
    } as unknown as ScoutNotificationDeliveryStore;
    let active = 0;
    let maximum = 0;
    let announceFirst!: () => void;
    let releaseSends!: () => void;
    const firstStarted = new Promise<void>((resolve) => { announceFirst = resolve; });
    const sendGate = new Promise<void>((resolve) => { releaseSends = resolve; });
    const client = {
      channels: {
        fetch: async () => ({
          isSendable: () => true,
          send: async () => {
            active += 1;
            maximum = Math.max(maximum, active);
            announceFirst();
            await sendGate;
            active -= 1;
            return { id: 'message' };
          },
        }),
      },
    } as unknown as Client;
    const dependencies = { storage, operationScope: {}, reportError: async () => undefined };
    const processing = [
      processDueScoutNotifications(client, dependencies, 100),
      processDueScoutNotifications(client, dependencies, 100),
    ];
    await firstStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseSends();
    await Promise.all(processing);
    return maximum;
  }

  assert.equal(await maximumConcurrentSends([1, 1]), 1);
  assert.equal(await maximumConcurrentSends([1, 2]), 2);
});

test('publication after the T-30 cutoff records a durable skipped reminder', () => {
  const db = openDatabase(':memory:');
  try {
    const division = upsertDivision(db, {
      guildId: 'guild', divisionKey: 'midgard', displayName: 'Midgard', roleId: 'division-role',
      managerRoleId: 'manager-role', captainRoleId: 'captain-role', categoryId: 'category',
    });
    const setup = createScoutSetup(db, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c' },
      startAt: 2_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(db, setup.id, 'signup');
    const slots = SCOUT_ROLES.flatMap((role) => SCOUT_TEAMS.map((team, index) => ({
      gameNumber: 1, team, role, userId: `${role}-${index}`,
    })));
    const insert = db.prepare('INSERT INTO scout_signups (setup_id, user_id, role) VALUES (?, ?, ?)');
    for (const slot of slots) insert.run(setup.id, slot.userId, slot.role);
    reconcileScoutWorkingRoster(db, { setupId: setup.id, expectedVersion: 0, slots, source: 'signup' });
    prepareScoutPublication(db, { setupId: setup.id, expectedVersion: 1, now: 201, random: () => 0 });
    const reminder = getScoutNotificationByDedupeKey(db, `t30:${setup.id}`)!;
    assert.equal(reminder.state, 'skipped');
    assert.equal(reminder.skippedReason, 'late_publication');
  } finally {
    closeDatabase(db);
  }
});
