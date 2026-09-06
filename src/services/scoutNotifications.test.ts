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
import { processDueScoutNotifications, resolveScoutNotification } from './scoutNotifications.js';
import { tryAcquireDivisionOperation } from './divisionOperation.js';

test('T-30 resolves the complete current roster and all per-game Hosts, then skips a finished scout', () => {
  const db = openDatabase(':memory:');
  try {
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

    const resolved = resolveScoutNotification(db, notification);
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
    assert.deepEqual(resolveScoutNotification(db, notification), { status: 'skip', reason: 'finished' });
  } finally {
    closeDatabase(db);
  }
});

test('notification processing sends a claimed row once and never retries an attempted-uncertain row', async () => {
  const db = openDatabase(':memory:');
  try {
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
      send: async (payload: any) => { sent.push(payload); return { id: `message-${sent.length}` }; },
    }) } } as unknown as Client;
    const release = tryAcquireDivisionOperation(db, 'guild', 'vanaheim')!;
    await processDueScoutNotifications(client, db, 200);
    assert.equal(sent.length, 0, 'a concurrent lifecycle operation leaves the row unclaimed');
    release();
    await processDueScoutNotifications(client, db, 200);
    await processDueScoutNotifications(client, db, 200);
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /starts in 30 minutes/);
    assert.equal(getScoutNotificationByDedupeKey(db, `t30:${setup.id}`)?.state, 'sent');

    const uncertain = scheduleScoutNotification(db, {
      setupId: setup.id, kind: 'manual_roster', dedupeKey: `manual:${setup.id}:uncertain`,
      nonce: 'uncertain', channelId: 'signups', dueAt: 201,
    }).notification;
    assert.equal(claimScoutNotificationAttempt(db, uncertain.id, 201, {
      content: 'possibly delivered', links: [], allowedUserIds: [],
    }), true);
    await processDueScoutNotifications(client, db, 201);
    assert.equal(sent.length, 1);
    assert.equal(getScoutNotificationByDedupeKey(db, uncertain.dedupeKey)?.state, 'attempted');
  } finally {
    closeDatabase(db);
  }
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
