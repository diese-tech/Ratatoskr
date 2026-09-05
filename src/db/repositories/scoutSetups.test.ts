import assert from 'node:assert/strict';
import test from 'node:test';
import { closeDatabase, openDatabase } from '../client.js';
import { upsertDivision } from './divisions.js';
import { finishScoutSetupIfVersion, markScoutCompletionReconciled } from './scoutCompletions.js';
import {
  addScoutSignup,
  cancelScoutSetupIfVersion,
  claimScoutPublish,
  createScoutSetup,
  getScoutSetupById,
  expandScoutRosterToTwoGamesIfVersion,
  getScoutSetupBySignupMessageId,
  listScoutSignups,
  listScoutRosterSlots,
  listCancellableScoutSetups,
  listDivisionScoutLifecycleBlockers,
  listOverlappingScoutSetups,
  listActiveScoutSetups,
  listPostingScoutSetups,
  listScoutPublishesNeedingReconciliation,
  listCancelledScoutSetupsNeedingSignupPostReconciliation,
  listRosterReadyScoutSetups,
  replaceScoutRosterIfVersion,
  replaceScoutSignups,
  replaceScoutRosterSlotIfVersion,
  replacePublishedScoutRosterSlotIfVersion,
  getScoutRosterUpdate,
  markScoutRosterUpdateEdited,
  completeScoutRosterUpdate,
  releaseScoutPublishClaim,
  removeScoutSignup,
  setScoutSetupSignupMessage,
  setScoutPostingMessage,
  activatePostedScoutSetup,
  setScoutPendingResultMessage,
  markPublishedScoutSignupPostReconciled,
  setScoutResultMessage,
  setScoutControlMessage,
  markCancelledScoutSignupPostReconciled,
  replaceScoutControlMessage,
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
    managerRoleId: 'manager-role',
    captainRoleId: 'captain-role',
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

test('publication claim transitions an unpublished legacy destination while preserving pending/published history', () => {
  const { db, division } = setupDatabase();
  try {
    const setup = createScoutSetup(db, {
      guildId: 'guild-1', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'staff', signupChannelId: 'signups',
      resultsChannelId: 'legacy-results', divisionRoleId: 'division-role', emojiByRole,
      startAt: 2_000_000_000, roleLimit: 2,
    });
    db.prepare("UPDATE scout_setups SET status = 'published' WHERE id = ?").run(setup.id);
    assert.equal(claimScoutPublish(db, setup.id, 0), 'stale');
    assert.equal(getScoutSetupById(db, setup.id)?.resultsChannelId, 'legacy-results');
    db.prepare("UPDATE scout_setups SET result_message_id = 'old-roster', signup_post_reconciled = 1 WHERE id = ?").run(setup.id);
    assert.equal(claimScoutPublish(db, setup.id, 0), 'stale');
    assert.equal(getScoutSetupById(db, setup.id)?.resultMessageId, 'old-roster');
    db.prepare("UPDATE scout_setups SET status = 'roster_ready', result_message_id = NULL, signup_post_reconciled = 0 WHERE id = ?").run(setup.id);
    assert.equal(claimScoutPublish(db, setup.id, 9), 'stale');
    assert.equal(getScoutSetupById(db, setup.id)?.resultsChannelId, 'legacy-results');
    assert.equal(claimScoutPublish(db, setup.id, 0), 'claimed');
    assert.equal(getScoutSetupById(db, setup.id)?.resultsChannelId, 'signups');
    assert.equal(claimScoutPublish(db, setup.id, 0), 'stale');
  } finally { closeDatabase(db); }
});

test('posting and unfinished publication block teardown until finish reconciliation settles history', () => {
  const { db, division } = setupDatabase();
  try {
    const setup = createScoutSetup(db, {
      guildId: 'guild-1', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'staff', signupChannelId: 'signups',
      resultsChannelId: 'results', divisionRoleId: 'division-role', emojiByRole,
      startAt: 2_000_000_000, roleLimit: 2,
    });
    assert.equal(listDivisionScoutLifecycleBlockers(db, 'guild-1', division.id).length, 1);
    assert.equal(listCancellableScoutSetups(db, 'guild-1', division.id).length, 0);
    db.prepare("UPDATE scout_setups SET status = 'published' WHERE id = ?").run(setup.id);
    assert.equal(listDivisionScoutLifecycleBlockers(db, 'guild-1', division.id).length, 1);
    db.prepare("UPDATE scout_setups SET result_message_id = 'roster' WHERE id = ?").run(setup.id);
    assert.equal(listDivisionScoutLifecycleBlockers(db, 'guild-1', division.id).length, 1);
    db.prepare('UPDATE scout_setups SET signup_post_reconciled = 1 WHERE id = ?').run(setup.id);
    assert.equal(listDivisionScoutLifecycleBlockers(db, 'guild-1', division.id).length, 1);
    assert.equal(finishScoutSetupIfVersion(db, setup.id, 0, 'staff'), 'finished');
    assert.equal(listDivisionScoutLifecycleBlockers(db, 'guild-1', division.id).length, 1);
    markScoutCompletionReconciled(db, setup.id);
    assert.equal(listDivisionScoutLifecycleBlockers(db, 'guild-1', division.id).length, 0);
  } finally { closeDatabase(db); }
});

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
      operationsChannelId: 'scout-ops',
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
    assert.equal(restored?.operationsChannelId, 'scout-ops');
    assert.equal(restored?.controlMessageId, null);
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
      resultsChannelId: 'results-1', operationsChannelId: 'scout-ops', divisionRoleId: 'division-role', emojiByRole,
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
    assert.deepEqual(listRosterReadyScoutSetups(db).map((candidate) => candidate.id), [setup.id]);
    assert.equal(setScoutControlMessage(db, setup.id, 'control-message'), true);
    assert.equal(setScoutControlMessage(db, setup.id, 'second-control-message'), false);
    assert.equal(getScoutSetupBySignupMessageId(db, 'message-roster')?.controlMessageId, 'control-message');
    assert.deepEqual(listRosterReadyScoutSetups(db).map((candidate) => candidate.id), [setup.id]);
    assert.equal(replaceScoutControlMessage(db, setup.id, 'wrong-message', 'replacement-message'), false);
    assert.equal(replaceScoutControlMessage(db, setup.id, 'control-message', 'replacement-message'), true);
    assert.equal(getScoutSetupBySignupMessageId(db, 'message-roster')?.controlMessageId, 'replacement-message');

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
    assert.equal(getScoutRosterUpdate(db, setup.id)?.version, 1);
    assert.equal(replacePublishedScoutRosterSlotIfVersion(db, setup.id, 1, firstSlot.id, 'blocked-pending'), 'stale');
    assert.equal(listDivisionScoutLifecycleBlockers(db, 'guild-1', division.id).length, 1);
    markScoutRosterUpdateEdited(db, setup.id, 1);
    assert.equal(completeScoutRosterUpdate(db, setup.id, 0), false);
    assert.equal(completeScoutRosterUpdate(db, setup.id, 1), true);
    const publishedSlots = listScoutRosterSlots(db, setup.id);
    const secondSlot = publishedSlots.find((slot) => slot.id !== firstSlot.id)!;
    const firstBeforeSwap = publishedSlots.find((slot) => slot.id === firstSlot.id)!;
    assert.equal(swapPublishedScoutRosterSlotsIfVersion(db, setup.id, 1, firstSlot.id, secondSlot.id), true);
    assert.equal(swapPublishedScoutRosterSlotsIfVersion(db, setup.id, 1, firstSlot.id, secondSlot.id), false);
    assert.equal(getScoutRosterUpdate(db, setup.id)?.version, 2);
    assert.equal(listScoutRosterSlots(db, setup.id).find((slot) => slot.id === firstSlot.id)?.userId, secondSlot.userId);
    assert.equal(getScoutSetupBySignupMessageId(db, 'message-publish')?.resultMessageId, 'result-1');
    assert.equal(listScoutRosterSlots(db, setup.id).find((slot) => slot.id === secondSlot.id)?.userId, firstBeforeSwap.userId);
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
      managerRoleId: 'alfheim-manager', captainRoleId: 'alfheim-captain', categoryId: 'alfheim-category',
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
    assert.deepEqual(
      listCancelledScoutSetupsNeedingSignupPostReconciliation(db).map((setup) => setup.id),
      [first.id],
    );
    assert.equal(markCancelledScoutSignupPostReconciled(db, first.id), true);
    assert.equal(markCancelledScoutSignupPostReconciled(db, first.id), false);
    assert.deepEqual(listCancelledScoutSetupsNeedingSignupPostReconciliation(db), []);
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
    assert.deepEqual(listDivisionScoutLifecycleBlockers(db, 'guild-1', division.id).map((setup) => setup.id), [second.id]);
    assert.equal(finishScoutSetupIfVersion(db, second.id, 0, 'captain-1'), 'finished');
    markScoutCompletionReconciled(db, second.id);
    assert.deepEqual(listDivisionScoutLifecycleBlockers(db, 'guild-1', division.id), []);
    assert.deepEqual(listDivisionScoutLifecycleBlockers(db, 'guild-1', otherDivision.id).map((setup) => setup.id), [other.id]);
  } finally {
    closeDatabase(db);
  }
});

test('posting, offline signup, and interrupted publish state expose durable restart transitions', () => {
  const { db, division } = setupDatabase();
  try {
    const setup = createScoutSetup(db, {
      guildId: 'guild-1', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'captain-1', signupChannelId: 'restart-signups',
      resultsChannelId: 'restart-results', operationsChannelId: 'scout-ops', divisionRoleId: 'division-role',
      emojiByRole, startAt: 2_000_000_000, roleLimit: 2,
    });
    assert.deepEqual(listPostingScoutSetups(db).map((candidate) => candidate.id), [setup.id]);
    assert.equal(setScoutPostingMessage(db, setup.id, 'restart-signup-message'), true);
    assert.equal(activatePostedScoutSetup(db, setup.id), true);
    assert.deepEqual(listActiveScoutSetups(db).map((candidate) => candidate.id), [setup.id]);

    assert.equal(replaceScoutSignups(db, setup.id, [
      { userId: 'player-1', role: 'solo' },
      { userId: 'player-1', role: 'jungle' },
      { userId: 'player-1', role: 'mid' },
      { userId: 'player-2', role: 'fill' },
    ]), true);
    assert.deepEqual(
      listScoutSignups(db, setup.id).map(({ userId, role }) => `${userId}:${role}`).sort(),
      ['player-1:jungle', 'player-1:solo', 'player-2:fill'],
    );
    db.prepare(
      "UPDATE scout_signups SET created_at = '2020-01-01T00:00:00.000Z' WHERE setup_id = ? AND user_id = 'player-1' AND role = 'solo'",
    ).run(setup.id);
    assert.equal(replaceScoutSignups(db, setup.id, [
      { userId: 'player-1', role: 'solo' },
      { userId: 'player-1', role: 'jungle' },
      { userId: 'player-2', role: 'fill' },
    ]), true);
    assert.equal(
      listScoutSignups(db, setup.id).find((signup) => signup.userId === 'player-1' && signup.role === 'solo')?.createdAt,
      '2020-01-01T00:00:00.000Z',
    );

    const slots: ScoutRosterSlot[] = SCOUT_ROLES.flatMap((role) =>
      SCOUT_TEAMS.map((team, index) => ({ team, role, userId: `restart-${role}-${index}` })),
    );
    assert.equal(replaceScoutSignups(
      db,
      setup.id,
      slots.map((slot) => ({ userId: slot.userId, role: slot.role })),
    ), true);
    assert.equal(tryCreateInitialScoutRoster(db, setup.id, slots), true);
    assert.equal(claimScoutPublish(db, setup.id, 0), 'claimed');
    assert.deepEqual(listScoutPublishesNeedingReconciliation(db).map((candidate) => candidate.id), [setup.id]);
    assert.equal(setScoutPendingResultMessage(db, setup.id, 'pending-result'), true);
    assert.deepEqual(listScoutPublishesNeedingReconciliation(db).map((candidate) => candidate.id), [setup.id]);
    assert.equal(markPublishedScoutSignupPostReconciled(db, setup.id, 'pending-result'), true);
    assert.deepEqual(listScoutPublishesNeedingReconciliation(db), []);
    assert.equal(releaseScoutPublishClaim(db, setup.id, 'pending-result'), true);
  } finally {
    closeDatabase(db);
  }
});
