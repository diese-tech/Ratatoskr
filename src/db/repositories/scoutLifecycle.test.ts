import assert from 'node:assert/strict';
import test from 'node:test';
import { SCOUT_ROLES, SCOUT_TEAMS, type ScoutRosterSlot } from '../../domain/index.js';
import { closeDatabase, openDatabase } from '../client.js';
import { upsertDivision } from './divisions.js';
import { changeScoutOrganizerIfVersion, getScoutCoordination } from './scoutCoordination.js';
import {
  changeScoutGameHostIfVersion,
  initializeScoutGameHosts,
  listScoutGameHosts,
  reassignScoutGameHostIfVersion,
} from './scoutGameHosts.js';
import {
  getScoutNotificationByDedupeKey,
  listDueScoutNotifications,
  scheduleScoutNotificationIfCooldownAvailable,
} from './scoutNotifications.js';
import {
  createScoutSetup,
  getScoutSetupById,
  listScoutRosterSlots,
  prepareScoutPublication,
  reconcileScoutWorkingRoster,
  replaceScoutRosterSlotIfVersion,
  seatScoutRosterSlotIfVersion,
  setScoutSetupSignupMessage,
  swapScoutRosterSlotsIfVersion,
} from './scoutSetups.js';

const emojiByRole = {
  solo: 'emoji-solo', jungle: 'emoji-jungle', mid: 'emoji-mid',
  support: 'emoji-support', carry: 'emoji-carry', fill: 'emoji-fill',
} as const;

function setupDatabase() {
  const db = openDatabase(':memory:');
  const division = upsertDivision(db, {
    guildId: 'guild', divisionKey: 'alfheim', displayName: 'Alfheim',
    roleId: 'division-role', managerRoleId: 'manager-role',
    captainRoleId: 'captain-role', categoryId: 'division-category',
  });
  const setup = createScoutSetup(db, {
    guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
    divisionDisplayName: division.displayName, createdBy: 'organizer',
    signupChannelId: 'signups', resultsChannelId: 'results', operationsChannelId: 'ops',
    divisionRoleId: 'division-role', emojiByRole, startAt: 2_000_000_000, roleLimit: 2,
  });
  setScoutSetupSignupMessage(db, setup.id, 'signup-message');
  return { db, setup };
}

function completeSlots(prefix = 'player'): ScoutRosterSlot[] {
  return SCOUT_ROLES.flatMap((role) => SCOUT_TEAMS.map((team, index) => ({
    gameNumber: 1, team, role, userId: `${prefix}-${role}-${index}`,
  })));
}

test('working roster reconciliation persists partial seats and versions only material readiness changes', () => {
  const { db, setup } = setupDatabase();
  try {
    const partial = completeSlots().slice(0, 8);
    assert.equal(reconcileScoutWorkingRoster(db, {
      setupId: setup.id, expectedVersion: 0, slots: partial, source: 'signup',
    }), 'updated');
    assert.equal(listScoutRosterSlots(db, setup.id).length, 8);
    assert.equal(getScoutSetupById(db, setup.id)?.status, 'open');
    assert.equal(getScoutSetupById(db, setup.id)?.version, 1);

    assert.equal(reconcileScoutWorkingRoster(db, {
      setupId: setup.id, expectedVersion: 1, slots: partial, source: 'signup',
    }), 'unchanged');
    assert.equal(getScoutSetupById(db, setup.id)?.version, 1);

    const complete = completeSlots();
    assert.equal(reconcileScoutWorkingRoster(db, {
      setupId: setup.id, expectedVersion: 1, slots: complete, source: 'signup',
    }), 'updated');
    assert.equal(getScoutSetupById(db, setup.id)?.status, 'roster_ready');
    assert.equal(getScoutSetupById(db, setup.id)?.version, 2);

    assert.equal(reconcileScoutWorkingRoster(db, {
      setupId: setup.id, expectedVersion: 2, slots: complete.slice(0, 9), source: 'membership',
    }), 'updated');
    assert.equal(getScoutSetupById(db, setup.id)?.status, 'open');
    assert.equal(getScoutSetupById(db, setup.id)?.version, 3);
    assert.equal(reconcileScoutWorkingRoster(db, {
      setupId: setup.id, expectedVersion: 2, slots: complete, source: 'signup',
    }), 'stale');
  } finally {
    closeDatabase(db);
  }
});

test('manual seating requires off-role confirmation and records assignment metadata atomically', () => {
  const { db, setup } = setupDatabase();
  try {
    db.prepare("INSERT INTO scout_signups (setup_id, user_id, role) VALUES (?, 'exact', 'solo'), (?, 'off-role', 'mid')")
      .run(setup.id, setup.id);

    assert.equal(seatScoutRosterSlotIfVersion(db, {
      setupId: setup.id, expectedVersion: 0, gameNumber: 1, team: 'team_one', role: 'solo',
      userId: 'off-role', actorUserId: 'staff', confirmOffRole: false,
    }), 'off_role_confirmation');
    assert.equal(listScoutRosterSlots(db, setup.id).length, 0);

    assert.equal(seatScoutRosterSlotIfVersion(db, {
      setupId: setup.id, expectedVersion: 0, gameNumber: 1, team: 'team_one', role: 'solo',
      userId: 'off-role', actorUserId: 'staff', confirmOffRole: true,
    }), 'updated');
    assert.match(seatScoutRosterSlotIfVersion(db, {
      setupId: setup.id, expectedVersion: 1, gameNumber: 1, team: 'team_two', role: 'solo',
      userId: 'off-role', actorUserId: 'staff', confirmOffRole: true,
    }), /duplicate/);
    assert.equal(seatScoutRosterSlotIfVersion(db, {
      setupId: setup.id, expectedVersion: 1, gameNumber: 1, team: 'team_one', role: 'solo',
      userId: 'exact', actorUserId: 'staff', confirmOffRole: false,
    }), 'occupied');
    assert.equal(seatScoutRosterSlotIfVersion(db, {
      setupId: setup.id, expectedVersion: 1, gameNumber: 1, team: 'team_two', role: 'solo',
      userId: 'not-signed-up', actorUserId: 'staff', confirmOffRole: false,
    }), 'ineligible');

    const slot = listScoutRosterSlots(db, setup.id)[0]!;
    assert.equal(slot.userId, 'off-role');
    assert.equal(slot.staffAssigned, true);
    assert.equal(slot.offRole, true);
    assert.equal(slot.assignedByUserId, 'staff');
    assert.equal(slot.replacementNeeded, false);
  } finally {
    closeDatabase(db);
  }
});

test('swap moves assignment metadata while replacement clears availability and recomputes incoming metadata', () => {
  const { db, setup } = setupDatabase();
  try {
    const slots = completeSlots();
    assert.equal(reconcileScoutWorkingRoster(db, {
      setupId: setup.id, expectedVersion: 0, slots, source: 'signup',
    }), 'updated');
    const [first, second] = listScoutRosterSlots(db, setup.id);
    assert.ok(first && second);
    db.prepare(
      `UPDATE scout_roster_slots SET staff_assigned = 1, off_role = 1,
       assigned_by_user_id = 'staff-a', replacement_needed = 1,
       replacement_requested_at = '2026-09-06T12:00:00.000Z' WHERE id = ?`,
    ).run(first.id);

    assert.equal(swapScoutRosterSlotsIfVersion(
      db, setup.id, 1, first.id, second.id, false,
    ), true);
    const afterSwap = listScoutRosterSlots(db, setup.id);
    const moved = afterSwap.find((slot) => slot.id === second.id)!;
    assert.equal(moved.userId, first.userId);
    assert.equal(moved.staffAssigned, true);
    assert.equal(moved.offRole, true);
    assert.equal(moved.assignedByUserId, 'staff-a');
    assert.equal(moved.replacementNeeded, true);
    assert.equal(moved.replacementRequestedAt, '2026-09-06T12:00:00.000Z');

    db.prepare("INSERT INTO scout_signups (setup_id, user_id, role) VALUES (?, 'incoming', 'mid')")
      .run(setup.id);
    assert.equal(replaceScoutRosterSlotIfVersion(
      db, setup.id, 2, moved.id, 'incoming', true, 'staff-b',
    ), 'updated');
    const replaced = listScoutRosterSlots(db, setup.id).find((slot) => slot.id === moved.id)!;
    assert.equal(replaced.userId, 'incoming');
    assert.equal(replaced.staffAssigned, true);
    assert.equal(replaced.offRole, moved.role !== 'mid');
    assert.equal(replaced.assignedByUserId, 'staff-b');
    assert.equal(replaced.replacementNeeded, false);
    assert.equal(replaced.replacementRequestedAt, null);
  } finally {
    closeDatabase(db);
  }
});

test('Organizer changes are setup-scoped and Host changes are roster-validated and game-scoped', () => {
  const { db, setup } = setupDatabase();
  try {
    const slots = completeSlots();
    assert.equal(reconcileScoutWorkingRoster(db, {
      setupId: setup.id, expectedVersion: 0, slots, source: 'signup',
    }), 'updated');
    db.prepare(
      "UPDATE scout_setups SET status = 'published', result_message_id = 'roster', signup_post_reconciled = 1 WHERE id = ?",
    ).run(setup.id);
    assert.equal(initializeScoutGameHosts(db, setup.id, [{ gameNumber: 1, userId: slots[0]!.userId }]), true);

    assert.equal(changeScoutOrganizerIfVersion(db, setup.id, 1, 'new-organizer', 'staff'), 'updated');
    assert.equal(getScoutCoordination(db, setup.id)?.organizerUserId, 'new-organizer');
    assert.equal(changeScoutOrganizerIfVersion(db, setup.id, 1, 'stale-organizer', 'staff'), 'stale');

    assert.equal(changeScoutGameHostIfVersion(
      db, setup.id, 2, 1, 'not-rostered', 'staff',
    ), 'ineligible');
    assert.equal(changeScoutGameHostIfVersion(
      db, setup.id, 2, 1, slots[1]!.userId, 'staff',
    ), 'updated');
    assert.equal(listScoutGameHosts(db, setup.id)[0]?.lobbyHostUserId, slots[1]!.userId);

    db.prepare('UPDATE scout_roster_slots SET replacement_needed = 1 WHERE setup_id = ? AND user_id = ?')
      .run(setup.id, slots[1]!.userId);
    assert.equal(reassignScoutGameHostIfVersion(
      db, setup.id, 3, 1, slots[1]!.userId, 'staff', () => 0,
    ), 'updated');
    assert.notEqual(listScoutGameHosts(db, setup.id)[0]?.lobbyHostUserId, slots[1]!.userId);
  } finally {
    closeDatabase(db);
  }
});

test('notification cooldown insertion is atomic across scheduled and attempted rows', () => {
  const { db, setup } = setupDatabase();
  try {
    const first = scheduleScoutNotificationIfCooldownAvailable(db, {
      setupId: setup.id, gameNumber: null, kind: 'manual_roster',
      dedupeKey: `manual:${setup.id}:1000`, nonce: 'manual-1000', channelId: 'signups',
      dueAt: 1_000, cooldownSince: 700,
    });
    const concurrent = scheduleScoutNotificationIfCooldownAvailable(db, {
      setupId: setup.id, gameNumber: null, kind: 'manual_roster',
      dedupeKey: `manual:${setup.id}:1001`, nonce: 'manual-1001', channelId: 'signups',
      dueAt: 1_001, cooldownSince: 701,
    });
    assert.equal(first.status, 'created');
    assert.equal(concurrent.status, 'cooldown');
    assert.equal(listDueScoutNotifications(db, 1_001).length, 1);
  } finally {
    closeDatabase(db);
  }
});

test('publication atomically assigns one Host per game and persists one setup-level T-30 reminder', () => {
  const { db, setup } = setupDatabase();
  try {
    db.prepare('UPDATE scout_setups SET game_count = 2, start_at = 2000 WHERE id = ?').run(setup.id);
    const slots = [1, 2].flatMap((gameNumber) =>
      completeSlots(`g${gameNumber}`).map((slot) => ({ ...slot, gameNumber })),
    );
    const addSignup = db.prepare('INSERT INTO scout_signups (setup_id, user_id, role) VALUES (?, ?, ?)');
    for (const slot of slots) addSignup.run(setup.id, slot.userId, slot.role);
    assert.equal(reconcileScoutWorkingRoster(db, {
      setupId: setup.id, expectedVersion: 0, slots, source: 'signup',
    }), 'updated');

    const outcome = prepareScoutPublication(db, {
      setupId: setup.id, expectedVersion: 1, now: 0, random: () => 0,
    });
    assert.equal(outcome.status, 'claimed');
    assert.deepEqual(listScoutGameHosts(db, setup.id).map((host) => host.gameNumber), [1, 2]);
    const t30 = getScoutNotificationByDedupeKey(db, `t30:${setup.id}`);
    assert.equal(t30?.gameNumber, null);
    assert.equal(t30?.dueAt, 200);
    assert.equal(t30?.state, 'scheduled');
    assert.equal(getScoutSetupById(db, setup.id)?.status, 'published');
  } finally {
    closeDatabase(db);
  }
});
