import assert from 'node:assert/strict';
import test from 'node:test';
import { closeDatabase, openDatabase } from '../db/client.js';
import { upsertDivision } from '../db/repositories/divisions.js';
import {
  createScoutSetup,
  getScoutSetupById,
  listScoutRosterSlots,
  seatScoutRosterSlotIfVersion,
  setScoutSetupSignupMessage,
} from '../db/repositories/scoutSetups.js';
import {
  prioritizeObservedScoutSignups,
  reconcileWorkingScoutRoster,
  scoutRoleForEmoji,
  selectReconciledScoutSignups,
} from './scoutSignups.js';

test('signup reaction role resolution uses the setup emoji snapshot', () => {
  const snapshot = {
    solo: 'old-solo',
    jungle: 'old-jungle',
    mid: 'old-mid',
    support: 'old-support',
    carry: 'old-carry',
    fill: 'old-fill',
  } as const;

  assert.equal(scoutRoleForEmoji(snapshot, 'old-mid'), 'mid');
  assert.equal(scoutRoleForEmoji(snapshot, 'old-fill'), 'fill');
  assert.equal(scoutRoleForEmoji(snapshot, 'new-mid'), undefined);
  assert.equal(scoutRoleForEmoji(snapshot, null), undefined);
});

test('restart reconciliation preserves existing signup priority before accepting offline additions', () => {
  const observed = [
    { userId: 'player-1', role: 'solo' as const },
    { userId: 'player-1', role: 'jungle' as const },
    { userId: 'player-1', role: 'mid' as const },
  ];
  const prioritized = prioritizeObservedScoutSignups(observed, [
    { userId: 'player-1', role: 'mid' },
    { userId: 'player-1', role: 'solo' },
  ]);

  assert.deepEqual(selectReconciledScoutSignups(prioritized, 2), {
    accepted: [observed[2], observed[0]],
    rejected: [observed[1]],
  });
});

test('restart reconciliation keeps deterministic role-limit signups and identifies excess reactions', () => {
  const observed = [
    { userId: 'player-1', role: 'solo' as const },
    { userId: 'player-1', role: 'jungle' as const },
    { userId: 'player-1', role: 'mid' as const },
    { userId: 'player-2', role: 'fill' as const },
    { userId: 'player-1', role: 'solo' as const },
  ];

  assert.deepEqual(selectReconciledScoutSignups(observed, 2), {
    accepted: observed.slice(0, 2).concat(observed.slice(3, 4)),
    rejected: [observed[2]],
  });
});

test('eligible signup reconciliation preserves fixed staff seats while refreshing automatic seats', () => {
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
      startAt: 2_000_000_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(db, setup.id, 'message');
    db.prepare("INSERT INTO scout_signups (setup_id, user_id, role) VALUES (?, 'manual', 'mid')").run(setup.id);
    assert.equal(seatScoutRosterSlotIfVersion(db, {
      setupId: setup.id, expectedVersion: 0, gameNumber: 1, team: 'team_one', role: 'solo',
      userId: 'manual', actorUserId: 'staff', confirmOffRole: true,
    }), 'updated');

    assert.equal(reconcileWorkingScoutRoster(db, setup.id, [
      { userId: 'automatic', role: 'jungle', createdAt: '2026-01-01' },
    ], 'signup'), 'updated');
    const roster = listScoutRosterSlots(db, setup.id);
    assert.equal(roster.find((slot) => slot.userId === 'manual')?.staffAssigned, true);
    assert.equal(roster.find((slot) => slot.userId === 'automatic')?.staffAssigned, false);
    assert.equal(getScoutSetupById(db, setup.id)?.version, 2);
  } finally {
    closeDatabase(db);
  }
});
