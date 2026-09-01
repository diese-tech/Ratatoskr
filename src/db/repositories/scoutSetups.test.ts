import assert from 'node:assert/strict';
import test from 'node:test';
import { closeDatabase, openDatabase } from '../client.js';
import { upsertDivision } from './divisions.js';
import {
  addScoutSignup,
  cancelScoutSetupIfVersion,
  claimScoutPublish,
  createScoutSetup,
  expandScoutRosterToTwoGamesIfVersion,
  getScoutSetupBySignupMessageId,
  listScoutSignups,
  listScoutRosterSlots,
  listCancellableScoutSetups,
  listDivisionScoutLifecycleBlockers,
  listOverlappingScoutSetups,
  replaceScoutRosterIfVersion,
  replaceScoutRosterSlotIfVersion,
  replacePublishedScoutRosterSlotIfVersion,
  rollbackPublishedScoutRosterReplacement,
  rollbackPublishedScoutRosterSwap,
  releaseScoutPublishClaim,
  removeScoutSignup,
  setScoutSetupSignupMessage,
  setScoutResultMessage,
  swapScoutRosterSlotsIfVersion,
  swapPublishedScoutRosterSlotsIfVersion,
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
  fill: 'emoji-fill',
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
      eligibilityRoleId: 'silver-role',
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
    assert.equal(restored?.eligibilityRoleId, 'silver-role');
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
    assert.deepEqual(addScoutSignup(db, second.id, 'player-1', 'fill'), { status: 'added' });
    assert.equal(listScoutSignups(db, first.id).length, 1);
    assert.deepEqual(listScoutSignups(db, second.id).map((signup) => signup.role), ['jungle', 'fill']);

    removeScoutSignup(db, first.id, 'player-1', 'solo');
    assert.equal(listScoutSignups(db, first.id).length, 0);
    assert.equal(listScoutSignups(db, second.id).length, 2);
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

test('a roster-ready setup expands atomically to two games and rejects stale expansion', () => {
  const { db, division } = setupDatabase();
  try {
    const setup = createScoutSetup(db, {
      guildId: 'guild-1', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'captain-1', signupChannelId: 'signups-1',
      resultsChannelId: 'results-1', divisionRoleId: 'division-role', emojiByRole,
      startAt: 2_000_000_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(db, setup.id, 'message-expand');
    const oneGame: ScoutRosterSlot[] = SCOUT_ROLES.flatMap((role) =>
      SCOUT_TEAMS.map((team, index) => ({ gameNumber: 1, team, role, userId: `g1-${role}-${index}` })),
    );
    const twoGames: ScoutRosterSlot[] = [1, 2].flatMap((gameNumber) =>
      SCOUT_ROLES.flatMap((role) => SCOUT_TEAMS.map((team, index) => ({
        gameNumber, team, role, userId: `g${gameNumber}-${role}-${index}`,
      }))),
    );
    tryCreateInitialScoutRoster(db, setup.id, oneGame);

    assert.equal(expandScoutRosterToTwoGamesIfVersion(db, setup.id, 0, twoGames), true);
    assert.equal(expandScoutRosterToTwoGamesIfVersion(db, setup.id, 0, twoGames), false);
    assert.equal(getScoutSetupBySignupMessageId(db, 'message-expand')?.gameCount, 2);
    assert.equal(getScoutSetupBySignupMessageId(db, 'message-expand')?.version, 1);
    assert.equal(listScoutRosterSlots(db, setup.id).length, 20);
    assert.deepEqual(new Set(listScoutRosterSlots(db, setup.id).map((slot) => slot.gameNumber)), new Set([1, 2]));
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

test('publishing is an exclusive retryable claim and published replacement is versioned', () => {
  const { db, division } = setupDatabase();
  try {
    const setup = createScoutSetup(db, {
      guildId: 'guild-1', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'captain-1', signupChannelId: 'signups-1',
      resultsChannelId: 'results-1', divisionRoleId: 'division-role', emojiByRole,
      startAt: 2_000_000_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(db, setup.id, 'message-publish');
    const slots: ScoutRosterSlot[] = SCOUT_ROLES.flatMap((role) =>
      SCOUT_TEAMS.map((team, index) => ({ team, role, userId: `${role}-${index}` })),
    );
    for (const slot of slots) addScoutSignup(db, setup.id, slot.userId, slot.role);
    const fillAssigned = slots.find((slot) => slot.team === 'team_two' && slot.role === 'support')!;
    removeScoutSignup(db, setup.id, fillAssigned.userId, fillAssigned.role);
    addScoutSignup(db, setup.id, fillAssigned.userId, 'fill');
    tryCreateInitialScoutRoster(db, setup.id, slots);

    assert.deepEqual(withdrawnScoutRosterUserIds(db, setup.id), []);

    const firstSlot = listScoutRosterSlots(db, setup.id)[0]!;
    removeScoutSignup(db, setup.id, firstSlot.userId, firstSlot.role);
    assert.equal(claimScoutPublish(db, setup.id, 0), 'withdrawals');
    addScoutSignup(db, setup.id, firstSlot.userId, firstSlot.role);
    assert.equal(claimScoutPublish(db, setup.id, 0), 'claimed');
    assert.equal(claimScoutPublish(db, setup.id, 0), 'stale');
    assert.equal(releaseScoutPublishClaim(db, setup.id), true);
    assert.equal(claimScoutPublish(db, setup.id, 0), 'claimed');
    assert.equal(setScoutResultMessage(db, setup.id, 'result-1'), true);
    assert.equal(releaseScoutPublishClaim(db, setup.id), false);

    assert.equal(replacePublishedScoutRosterSlotIfVersion(db, setup.id, 0, firstSlot.id, 'replacement'), 'updated');
    assert.equal(replacePublishedScoutRosterSlotIfVersion(db, setup.id, 0, firstSlot.id, 'stale-replacement'), 'stale');
    assert.equal(rollbackPublishedScoutRosterReplacement(db, setup.id, 1, firstSlot.id, 'replacement', firstSlot.userId, firstSlot.staffAssigned), true);
    assert.equal(replacePublishedScoutRosterSlotIfVersion(db, setup.id, 0, firstSlot.id, 'replacement-final'), 'updated');
    const publishedSlots = listScoutRosterSlots(db, setup.id);
    const secondSlot = publishedSlots.find((slot) => slot.id !== firstSlot.id)!;
    const firstBeforeSwap = publishedSlots.find((slot) => slot.id === firstSlot.id)!;
    assert.equal(swapPublishedScoutRosterSlotsIfVersion(db, setup.id, 1, firstSlot.id, secondSlot.id), true);
    assert.equal(swapPublishedScoutRosterSlotsIfVersion(db, setup.id, 1, firstSlot.id, secondSlot.id), false);
    assert.equal(rollbackPublishedScoutRosterSwap(db, setup.id, 2, firstSlot.id, secondSlot.id), true);
    assert.equal(listScoutRosterSlots(db, setup.id).find((slot) => slot.id === firstSlot.id)?.userId, firstBeforeSwap.userId);
    assert.equal(getScoutSetupBySignupMessageId(db, 'message-publish')?.resultMessageId, 'result-1');
    assert.equal(listScoutRosterSlots(db, setup.id).find((slot) => slot.id === firstSlot.id)?.userId, 'replacement-final');
  } finally {
    closeDatabase(db);
  }
});

test('same-time overlap lookup is coordinator-scoped and ignores cancelled setups', () => {
  const { db, division } = setupDatabase();
  try {
    const create = (createdBy: string, startAt: number) => createScoutSetup(db, {
      guildId: 'guild-1', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy, signupChannelId: 'signups-1',
      resultsChannelId: 'results-1', divisionRoleId: 'division-role', emojiByRole,
      startAt, roleLimit: 2,
    });
    const active = create('captain-1', 2_000_000_000);
    setScoutSetupSignupMessage(db, active.id, 'active-message');
    const cancelled = create('captain-1', 2_000_000_000);
    setScoutSetupSignupMessage(db, cancelled.id, 'cancelled-message');
    cancelScoutSetupIfVersion(db, cancelled.id, 0);
    create('captain-2', 2_000_000_000);
    create('captain-1', 2_000_003_600);

    assert.deepEqual(listOverlappingScoutSetups(db, 'guild-1', 'captain-1', 2_000_000_000).map((setup) => setup.id), [active.id]);
  } finally {
    closeDatabase(db);
  }
});

test('cancellation is division-scoped, atomic, and only active setups block division lifecycle', () => {
  const { db, division } = setupDatabase();
  try {
    const otherDivision = upsertDivision(db, {
      guildId: 'guild-1', divisionKey: 'alfheim', displayName: 'Alfheim', roleId: 'alfheim-role',
      captainAccessRoleId: 'alfheim-captain', categoryId: 'alfheim-category',
    });
    const create = (messageId: string, targetDivision = division) => {
      const setup = createScoutSetup(db, {
        guildId: 'guild-1', divisionId: targetDivision.id, divisionKey: targetDivision.divisionKey,
        divisionDisplayName: targetDivision.displayName, createdBy: 'captain-1', signupChannelId: `signups-${targetDivision.id}`,
        resultsChannelId: `results-${targetDivision.id}`, divisionRoleId: `division-role-${targetDivision.id}`, emojiByRole,
        startAt: 2_000_000_000, roleLimit: 2,
      });
      setScoutSetupSignupMessage(db, setup.id, messageId);
      return setup;
    };
    const first = create('cancel-1');
    const second = create('cancel-2');
    const other = create('cancel-other', otherDivision);

    assert.deepEqual(listCancellableScoutSetups(db, 'guild-1', division.id).map((setup) => setup.id), [first.id, second.id]);
    assert.deepEqual(listCancellableScoutSetups(db, 'guild-1', otherDivision.id).map((setup) => setup.id), [other.id]);
    assert.deepEqual(listDivisionScoutLifecycleBlockers(db, 'guild-1', division.id).map((setup) => setup.id), [first.id, second.id]);
    assert.equal(cancelScoutSetupIfVersion(db, first.id, 0), 'cancelled');
    assert.equal(cancelScoutSetupIfVersion(db, first.id, 0), 'already_cancelled');
    assert.deepEqual(listCancellableScoutSetups(db, 'guild-1', division.id).map((setup) => setup.id), [second.id]);
    assert.deepEqual(listDivisionScoutLifecycleBlockers(db, 'guild-1', division.id).map((setup) => setup.id), [second.id]);

    const slots: ScoutRosterSlot[] = SCOUT_ROLES.flatMap((role) =>
      SCOUT_TEAMS.map((team, index) => ({ team, role, userId: `cancel-${role}-${index}` })),
    );
    for (const slot of slots) addScoutSignup(db, second.id, slot.userId, slot.role);
    assert.equal(tryCreateInitialScoutRoster(db, second.id, slots), true);
    assert.equal(claimScoutPublish(db, second.id, 0), 'claimed');
    assert.equal(setScoutResultMessage(db, second.id, 'cancel-result'), true);
    assert.equal(cancelScoutSetupIfVersion(db, second.id, 0), 'published');
    assert.deepEqual(listDivisionScoutLifecycleBlockers(db, 'guild-1', division.id), []);
    assert.deepEqual(listDivisionScoutLifecycleBlockers(db, 'guild-1', otherDivision.id).map((setup) => setup.id), [other.id]);
  } finally {
    closeDatabase(db);
  }
});
