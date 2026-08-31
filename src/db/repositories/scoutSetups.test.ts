import assert from 'node:assert/strict';
import test from 'node:test';
import { closeDatabase, openDatabase } from '../client.js';
import { upsertDivision } from './divisions.js';
import {
  addScoutSignup,
  createScoutSetup,
  getScoutSetupBySignupMessageId,
  listScoutSignups,
  removeScoutSignup,
  setScoutSetupSignupMessage,
} from './scoutSetups.js';

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
