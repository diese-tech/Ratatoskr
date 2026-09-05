import assert from 'node:assert/strict';
import test from 'node:test';
import { SCOUT_ROLES, SCOUT_TEAMS } from '../../domain/index.js';
import { closeDatabase, openDatabase } from '../client.js';
import { upsertDivision } from './divisions.js';
import { getScoutCoordination } from './scoutCoordination.js';
import { appendScoutEvent, listScoutEvents } from './scoutEvents.js';
import { initializeScoutGameHosts, listScoutGameHosts } from './scoutGameHosts.js';
import {
  claimScoutNotificationAttempt,
  getScoutNotificationByDedupeKey,
  hasScoutNotificationAttemptSince,
  listAttemptedScoutNotifications,
  listDueScoutNotifications,
  markScoutNotificationSent,
  scheduleScoutNotification,
  skipScheduledScoutNotification,
} from './scoutNotifications.js';
import { createScoutSetup } from './scoutSetups.js';

function setupDatabase() {
  const db = openDatabase(':memory:');
  const division = upsertDivision(db, {
    guildId: 'guild-1',
    divisionKey: 'vanaheim',
    displayName: 'Vanaheim',
    roleId: 'division-role',
  });
  const setup = createScoutSetup(db, {
    guildId: 'guild-1',
    divisionId: division.id,
    divisionKey: division.divisionKey,
    divisionDisplayName: division.displayName,
    createdBy: 'organizer-1',
    signupChannelId: 'signups',
    resultsChannelId: 'results',
    operationsChannelId: 'ops',
    divisionRoleId: 'division-role',
    emojiByRole: {
      solo: 'solo', jungle: 'jungle', mid: 'mid', support: 'support', carry: 'carry', fill: 'fill',
    },
    startAt: 2_000_000_000,
    roleLimit: 2,
  });
  return { db, setup };
}

test('new scout setup creates one setup-level Organizer and no game Hosts', () => {
  const { db, setup } = setupDatabase();
  try {
    assert.equal(getScoutCoordination(db, setup.id)?.organizerUserId, 'organizer-1');
    assert.deepEqual(listScoutGameHosts(db, setup.id), []);
  } finally {
    closeDatabase(db);
  }
});

test('game Host initialization requires exactly one rostered Host per published game', () => {
  const { db, setup } = setupDatabase();
  try {
    db.prepare("UPDATE scout_setups SET status = 'published', game_count = 2 WHERE id = ?").run(setup.id);
    const insert = db.prepare(
      'INSERT INTO scout_roster_slots (setup_id, game_number, team, role, user_id) VALUES (?, ?, ?, ?, ?)',
    );
    for (const gameNumber of [1, 2] as const) {
      for (const role of SCOUT_ROLES) {
        for (const team of SCOUT_TEAMS) insert.run(setup.id, gameNumber, team, role, `g${gameNumber}-${team}-${role}`);
      }
    }

    assert.equal(initializeScoutGameHosts(db, setup.id, [{ gameNumber: 1, userId: 'g2-team_one-solo' }]), false);
    assert.equal(initializeScoutGameHosts(db, setup.id, [
      { gameNumber: 1, userId: 'g1-team_one-solo' },
      { gameNumber: 2, userId: 'g2-team_two-carry' },
    ]), true);
    assert.deepEqual(
      listScoutGameHosts(db, setup.id).map(({ gameNumber, lobbyHostUserId }) => ({ gameNumber, lobbyHostUserId })),
      [
        { gameNumber: 1, lobbyHostUserId: 'g1-team_one-solo' },
        { gameNumber: 2, lobbyHostUserId: 'g2-team_two-carry' },
      ],
    );
    assert.equal(initializeScoutGameHosts(db, setup.id, [
      { gameNumber: 1, userId: 'g1-team_two-solo' },
      { gameNumber: 2, userId: 'g2-team_one-solo' },
    ]), false);
  } finally {
    closeDatabase(db);
  }
});

test('scout events preserve ordered structured history', () => {
  const { db, setup } = setupDatabase();
  try {
    appendScoutEvent(db, {
      setupId: setup.id,
      setupVersion: 0,
      eventType: 'manual_seat',
      actorUserId: 'staff-1',
      payload: { gameNumber: 1, userId: 'player-1' },
    });
    appendScoutEvent(db, {
      setupId: setup.id,
      setupVersion: 1,
      eventType: 'working_roster_refreshed',
    });

    const events = listScoutEvents(db, setup.id);
    assert.deepEqual(events.map((event) => event.eventType), ['manual_seat', 'working_roster_refreshed']);
    assert.deepEqual(events[0]?.payload, { gameNumber: 1, userId: 'player-1' });
    assert.deepEqual(events[1]?.payload, {});
  } finally {
    closeDatabase(db);
  }
});

test('notification outbox deduplicates, claims once, persists payload, and scopes Host cooldowns by game', () => {
  const { db, setup } = setupDatabase();
  try {
    assert.throws(() => scheduleScoutNotification(db, {
      setupId: setup.id,
      kind: 'host_organizer',
      dedupeKey: `host:${setup.id}:missing-game`,
      nonce: 'host-missing-game',
      channelId: 'ops',
      dueAt: 100,
    }), /require a game number/);

    const scheduled = scheduleScoutNotification(db, {
      setupId: setup.id,
      gameNumber: 1,
      kind: 'host_organizer',
      dedupeKey: `host:${setup.id}:1:100`,
      nonce: 'host-game-1-100',
      channelId: 'ops',
      dueAt: 100,
    });
    assert.equal(scheduled.created, true);
    assert.equal(scheduleScoutNotification(db, {
      setupId: setup.id,
      gameNumber: 1,
      kind: 'host_organizer',
      dedupeKey: `host:${setup.id}:1:100`,
      nonce: 'ignored-duplicate',
      channelId: 'different-channel',
      dueAt: 200,
    }).created, false);
    assert.deepEqual(listDueScoutNotifications(db, 99), []);
    assert.equal(listDueScoutNotifications(db, 100).length, 1);

    const payload = {
      content: '<@organizer> Game 1 needs help.',
      links: [{ label: 'View roster', url: 'https://discord.com/channels/guild/signups/roster' }],
      allowedUserIds: ['organizer'],
    };
    assert.equal(claimScoutNotificationAttempt(db, scheduled.notification.id, 99, payload), false);
    assert.equal(claimScoutNotificationAttempt(db, scheduled.notification.id, 100, payload), true);
    assert.equal(claimScoutNotificationAttempt(db, scheduled.notification.id, 100, payload), false);
    assert.deepEqual(getScoutNotificationByDedupeKey(db, scheduled.notification.dedupeKey)?.payload, payload);
    assert.equal(listAttemptedScoutNotifications(db).length, 1);
    assert.equal(hasScoutNotificationAttemptSince(db, setup.id, 'host_organizer', 1, 100), true);
    assert.equal(hasScoutNotificationAttemptSince(db, setup.id, 'host_organizer', 2, 100), false);
    assert.equal(markScoutNotificationSent(db, scheduled.notification.id, 'message-1', 101), true);
    assert.equal(markScoutNotificationSent(db, scheduled.notification.id, 'message-2', 102), false);
    assert.equal(hasScoutNotificationAttemptSince(db, setup.id, 'host_organizer', 1, 101), false);

    const skipped = scheduleScoutNotification(db, {
      setupId: setup.id,
      kind: 't30',
      dedupeKey: `t30:${setup.id}`,
      nonce: 't30-setup',
      channelId: 'signups',
      dueAt: 500,
    });
    assert.equal(skipScheduledScoutNotification(db, skipped.notification.id, 'late_publication'), true);
    assert.equal(skipScheduledScoutNotification(db, skipped.notification.id, 'again'), false);
    assert.equal(getScoutNotificationByDedupeKey(db, `t30:${setup.id}`)?.skippedReason, 'late_publication');
  } finally {
    closeDatabase(db);
  }
});

test('roster user uniqueness is enforced across games', () => {
  const { db, setup } = setupDatabase();
  try {
    db.prepare('UPDATE scout_setups SET game_count = 2 WHERE id = ?').run(setup.id);
    db.prepare(
      "INSERT INTO scout_roster_slots (setup_id, game_number, team, role, user_id) VALUES (?, 1, 'team_one', 'solo', 'same-user')",
    ).run(setup.id);
    assert.throws(() => db.prepare(
      "INSERT INTO scout_roster_slots (setup_id, game_number, team, role, user_id) VALUES (?, 2, 'team_one', 'solo', 'same-user')",
    ).run(setup.id), /UNIQUE constraint failed/);
  } finally {
    closeDatabase(db);
  }
});
