import assert from 'node:assert/strict';
import test from 'node:test';
import { closeDatabase, openDatabase } from '../client.js';
import { upsertDivision } from './divisions.js';
import {
  addScoutSignup,
  createScoutSetup,
  getScoutSetupBySignupMessageId,
  listScoutSignups,
  listScoutRosterSlots,
  replaceScoutRosterIfVersion,
  replaceScoutRosterSlotIfVersion,
  removeScoutSignup,
  setScoutSetupSignupMessage,
  swapScoutRosterSlotsIfVersion,
  tryCreateInitialScoutRoster,
  withdrawnScoutRosterUserIds,
} from './scoutSetups.js';
import { SCOUT_ROLES, SCOUT_TEAMS, type ScoutRosterSlot } from '../../domain/index.js';

function setupDatabase() {
  const db = openDatabase(':memory:');
  const division = upsertDivision(db, {
    guildId: 'guild-1',
    divisionKey: 'vanaheim',
    displayName: 'Vanaheim',
    roleId: 'division-role',
    captainAccessRoleId: 'captain-role',
    categoryId: 'division-category',
  });
  return { db, division };
}

const emojiByRole = {
  solo: 'emoji-solo',
  jungle: 'emoji-jungle',
  mid: 'emoji-mid',
  support: 'emoji-support',
  carry: 'emoji-carry',
} as const;

test('scout setup snapshots division routing and resolves durably by signup message ID', () => {
  const { db, division } = setupDatabase();
  try {
    const first = createScoutSetup(db, {
      guildId: 'guild-1',
      divisionId: division.id,
      divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName,
      createdBy: 'captain-1',
      signupChannelId: 'signups-1',
      resultsChannelId: 'results-1',
      divisionRoleId: 'division-role',
      emojiByRole,
      startAt: 2_000_000_000,
      roleLimit: 2,
      note: 'First lobby',
    });
    const second = createScoutSetup(db, {
      guildId: 'guild-1',
      divisionId: division.id,
      divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName,
      createdBy: 'captain-2',
      signupChannelId: 'signups-1',
      resultsChannelId: 'results-1',
      divisionRoleId: 'division-role',
      emojiByRole,
      startAt: 2_000_003_600,
      roleLimit: 1,
    });

    setScoutSetupSignupMessage(db, first.id, 'message-1');
    setScoutSetupSignupMessage(db, second.id, 'message-2');

    const restored = getScoutSetupBySignupMessageId(db, 'message-1');
    assert.equal(restored?.id, first.id);
    assert.equal(restored?.divisionId, division.id);
    assert.equal(restored?.signupChannelId, 'signups-1');
    assert.equal(restored?.resultsChannelId, 'results-1');
    assert.equal(restored?.divisionRoleId, 'division-role');
    assert.deepEqual(restored?.emojiByRole, emojiByRole);
    assert.equal(getScoutSetupBySignupMessageId(db, 'message-2')?.id, second.id);
  } finally {
    closeDatabase(db);
  }
});

test('scout signup limits and withdrawals are isolated per setup', () => {
  const { db, division } = setupDatabase();
  try {
    let setupNumber = 0;
    const create = (roleLimit: number) => {
      const setup = createScoutSetup(db, {
        guildId: 'guild-1',
        divisionId: division.id,
        divisionKey: division.divisionKey,
        divisionDisplayName: division.displayName,
        createdBy: 'captain-1',
        signupChannelId: 'signups-1',
        resultsChannelId: 'results-1',
        divisionRoleId: 'division-role',
        emojiByRole,
        startAt: 2_000_000_000,
        roleLimit,
      });
      setupNumber += 1;
      setScoutSetupSignupMessage(db, setup.id, `message-${setupNumber}`);
      return getScoutSetupBySignupMessageId(db, `message-${setupNumber}`)!;
    };

    const first = create(1);
    const second = create(2);
    assert.deepEqual(addScoutSignup(db, first.id, 'player-1', 'solo'), { status: 'added' });
    assert.deepEqual(addScoutSignup(db, first.id, 'player-1', 'jungle'), {
      status: 'over_limit',
      limit: 1,
    });
    assert.deepEqual(addScoutSignup(db, second.id, 'player-1', 'jungle'), { status: 'added' });
    assert.equal(listScoutSignups(db, first.id).length, 1);
    assert.equal(listScoutSignups(db, second.id).length, 1);

    removeScoutSignup(db, first.id, 'player-1', 'solo');
    assert.equal(listScoutSignups(db, first.id).length, 0);
    assert.equal(listScoutSignups(db, second.id).length, 1);
  } finally {
    closeDatabase(db);
  }
});

test('initial roster transition is atomic and versioned replacement rejects stale shuffles', () => {
  const { db, division } = setupDatabase();
  try {
    const setup = createScoutSetup(db, {
      guildId: 'guild-1', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'captain-1', signupChannelId: 'signups-1',
      resultsChannelId: 'results-1', divisionRoleId: 'division-role', emojiByRole,
      startAt: 2_000_000_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(db, setup.id, 'message-roster');
    const slots: ScoutRosterSlot[] = SCOUT_ROLES.flatMap((role) =>
      SCOUT_TEAMS.map((team, index) => ({ team, role, userId: `${role}-${index}` })),
    );

    assert.equal(tryCreateInitialScoutRoster(db, setup.id, slots), true);
    assert.equal(tryCreateInitialScoutRoster(db, setup.id, slots), false);
    assert.equal(listScoutRosterSlots(db, setup.id).length, 10);
    assert.equal(getScoutSetupBySignupMessageId(db, 'message-roster')?.status, 'roster_ready');

    const replacement = slots.map((slot) => ({ ...slot, userId: `new-${slot.userId}` }));
    assert.equal(replaceScoutRosterIfVersion(db, setup.id, 0, replacement), true);
    assert.equal(replaceScoutRosterIfVersion(db, setup.id, 0, slots), false);
    assert.ok(listScoutRosterSlots(db, setup.id).every((slot) => slot.userId.startsWith('new-')));
    assert.equal(getScoutSetupBySignupMessageId(db, 'message-roster')?.version, 1);
  } finally {
    closeDatabase(db);
  }
});

test('roster edits preserve uniqueness, mark overrides, flag withdrawals, and reject stale versions', () => {
  const { db, division } = setupDatabase();
  try {
    const setup = createScoutSetup(db, {
      guildId: 'guild-1', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'captain-1', signupChannelId: 'signups-1',
      resultsChannelId: 'results-1', divisionRoleId: 'division-role', emojiByRole,
      startAt: 2_000_000_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(db, setup.id, 'message-edits');
    const slots: ScoutRosterSlot[] = SCOUT_ROLES.flatMap((role) =>
      SCOUT_TEAMS.map((team, index) => ({ team, role, userId: `${role}-${index}` })),
    );
    for (const slot of slots) addScoutSignup(db, setup.id, slot.userId, slot.role);
    tryCreateInitialScoutRoster(db, setup.id, slots);

    let stored = listScoutRosterSlots(db, setup.id);
    const soloOne = stored.find((slot) => slot.team === 'team_one' && slot.role === 'solo')!;
    const soloTwo = stored.find((slot) => slot.team === 'team_two' && slot.role === 'solo')!;
    assert.equal(swapScoutRosterSlotsIfVersion(db, setup.id, 0, soloOne.id, soloTwo.id, false), true);
    assert.ok(listScoutRosterSlots(db, setup.id).every((slot) => !slot.staffAssigned));

    stored = listScoutRosterSlots(db, setup.id);
    const changedSolo = stored.find((slot) => slot.team === 'team_one' && slot.role === 'solo')!;
    const jungle = stored.find((slot) => slot.team === 'team_one' && slot.role === 'jungle')!;
    assert.equal(swapScoutRosterSlotsIfVersion(db, setup.id, 1, changedSolo.id, jungle.id, true), true);
    assert.equal(listScoutRosterSlots(db, setup.id).filter((slot) => slot.staffAssigned).length, 2);

    const mid = listScoutRosterSlots(db, setup.id).find((slot) => slot.role === 'mid')!;
    removeScoutSignup(db, setup.id, mid.userId, mid.role);
    assert.deepEqual(withdrawnScoutRosterUserIds(db, setup.id), [mid.userId]);

    assert.equal(replaceScoutRosterSlotIfVersion(db, setup.id, 2, changedSolo.id, 'staff-sub', true), 'updated');
    assert.equal(replaceScoutRosterSlotIfVersion(db, setup.id, 2, jungle.id, 'another-sub', true), 'stale');
    assert.equal(replaceScoutRosterSlotIfVersion(db, setup.id, 3, jungle.id, mid.userId, false), 'duplicate');
    assert.equal(listScoutRosterSlots(db, setup.id).find((slot) => slot.userId === 'staff-sub')?.staffAssigned, true);
  } finally {
    closeDatabase(db);
  }
});
