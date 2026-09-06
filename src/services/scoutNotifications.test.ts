import assert from 'node:assert/strict';
import test from 'node:test';
import { closeDatabase, openDatabase } from '../db/client.js';
import { upsertDivision } from '../db/repositories/divisions.js';
import { finishScoutSetupIfVersion } from '../db/repositories/scoutCompletions.js';
import { listDueScoutNotifications } from '../db/repositories/scoutNotifications.js';
import {
  createScoutSetup,
  prepareScoutPublication,
  reconcileScoutWorkingRoster,
  setScoutResultMessage,
  setScoutSetupSignupMessage,
} from '../db/repositories/scoutSetups.js';
import { SCOUT_ROLES, SCOUT_TEAMS } from '../domain/index.js';
import { resolveScoutNotification } from './scoutNotifications.js';

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
    assert.deepEqual(resolveScoutNotification(db, notification), { status: 'skip', reason: 'finished' });
  } finally {
    closeDatabase(db);
  }
});
