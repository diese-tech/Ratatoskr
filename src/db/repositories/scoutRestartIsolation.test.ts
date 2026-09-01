import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type Database from 'better-sqlite3';
import { SCOUT_ROLES, SCOUT_TEAMS, type ScoutRosterSlot } from '../../domain/index.js';
import { closeDatabase, openDatabase } from '../client.js';
import { upsertDivision } from './divisions.js';
import {
  addScoutSignup,
  cancelScoutSetupIfVersion,
  claimScoutPublish,
  createScoutSetup,
  getScoutSetupById,
  listScoutRosterSlots,
  listScoutSignups,
  replacePublishedScoutRosterSlotIfVersion,
  replaceScoutRosterSlotIfVersion,
  setScoutResultMessage,
  setScoutSetupSignupMessage,
  tryCreateInitialScoutRoster,
} from './scoutSetups.js';

const emojiByRole = {
  solo: 'emoji-solo', jungle: 'emoji-jungle', mid: 'emoji-mid', support: 'emoji-support', carry: 'emoji-carry',
} as const;

function roster(prefix: string): ScoutRosterSlot[] {
  return SCOUT_ROLES.flatMap((role) =>
    SCOUT_TEAMS.map((team, index) => ({ team, role, userId: `${prefix}-${role}-${index}` })),
  );
}

test('persisted controls and three simultaneous setups remain isolated across restarts and stale races', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ratatoskr-scout-restart-'));
  const databasePath = join(directory, 'ratatoskr.db');
  let db: Database.Database | undefined;
  try {
    db = openDatabase(databasePath);
    const vanaheim = upsertDivision(db, {
      guildId: 'guild', divisionKey: 'vanaheim', displayName: 'Vanaheim', roleId: 'vanaheim-role',
      managerRoleId: 'vanaheim-manager', captainRoleId: 'vanaheim-captain', categoryId: 'vanaheim-category',
    });
    const alfheim = upsertDivision(db, {
      guildId: 'guild', divisionKey: 'alfheim', displayName: 'Alfheim', roleId: 'alfheim-role',
      managerRoleId: 'alfheim-manager', captainRoleId: 'alfheim-captain', categoryId: 'alfheim-category',
    });
    const create = (division: typeof vanaheim, suffix: string) => {
      const setup = createScoutSetup(db!, {
        guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
        divisionDisplayName: division.displayName, createdBy: 'manager', signupChannelId: `signups-${division.id}`,
        resultsChannelId: `results-${division.id}`, divisionRoleId: `role-${division.id}`, emojiByRole,
        startAt: 2_000_000_000 + Number(suffix) * 60, roleLimit: 2,
      });
      assert.equal(setScoutSetupSignupMessage(db!, setup.id, `signup-message-${suffix}`), true);
      return setup;
    };
    const first = create(vanaheim, '1');
    const second = create(vanaheim, '2');
    const otherDivision = create(alfheim, '3');
    const firstRoster = roster('first');
    const otherRoster = roster('other');
    for (const slot of firstRoster) addScoutSignup(db, first.id, slot.userId, slot.role);
    for (const slot of otherRoster) addScoutSignup(db, otherDivision.id, slot.userId, slot.role);
    addScoutSignup(db, second.id, 'second-open-player', 'solo');
    assert.equal(tryCreateInitialScoutRoster(db, first.id, firstRoster), true);
    assert.equal(tryCreateInitialScoutRoster(db, first.id, firstRoster), false);
    assert.equal(tryCreateInitialScoutRoster(db, otherDivision.id, otherRoster), true);

    closeDatabase(db);
    db = openDatabase(databasePath);
    assert.equal(getScoutSetupById(db, second.id)?.status, 'open');
    assert.equal(getScoutSetupById(db, first.id)?.status, 'roster_ready');
    assert.equal(getScoutSetupById(db, otherDivision.id)?.status, 'roster_ready');

    const firstSlot = listScoutRosterSlots(db, first.id)[0]!;
    assert.equal(replaceScoutRosterSlotIfVersion(db, first.id, 0, firstSlot.id, 'first-edited', true), 'updated');
    assert.equal(replaceScoutRosterSlotIfVersion(db, first.id, 0, firstSlot.id, 'stale-edit', true), 'stale');
    assert.equal(claimScoutPublish(db, first.id, 1), 'claimed');
    assert.equal(claimScoutPublish(db, first.id, 1), 'stale');
    assert.equal(setScoutResultMessage(db, first.id, 'result-first'), true);
    assert.equal(claimScoutPublish(db, otherDivision.id, 0), 'claimed');
    assert.equal(setScoutResultMessage(db, otherDivision.id, 'result-other'), true);
    assert.equal(cancelScoutSetupIfVersion(db, second.id, 0), 'cancelled');
    assert.equal(cancelScoutSetupIfVersion(db, second.id, 0), 'already_cancelled');

    closeDatabase(db);
    db = openDatabase(databasePath);
    const publishedFirstSlot = listScoutRosterSlots(db, first.id).find((slot) => slot.id === firstSlot.id)!;
    assert.equal(replacePublishedScoutRosterSlotIfVersion(db, first.id, 1, publishedFirstSlot.id, 'first-published-replacement'), 'updated');
    assert.equal(replacePublishedScoutRosterSlotIfVersion(db, first.id, 1, publishedFirstSlot.id, 'stale-replacement'), 'stale');

    closeDatabase(db);
    db = openDatabase(databasePath);
    assert.deepEqual(
      [getScoutSetupById(db, first.id)?.status, getScoutSetupById(db, second.id)?.status, getScoutSetupById(db, otherDivision.id)?.status],
      ['published', 'cancelled', 'published'],
    );
    assert.equal(getScoutSetupById(db, first.id)?.resultMessageId, 'result-first');
    assert.equal(getScoutSetupById(db, otherDivision.id)?.resultMessageId, 'result-other');
    assert.equal(listScoutSignups(db, second.id).map((signup) => signup.userId).join(','), 'second-open-player');
    assert.equal(listScoutRosterSlots(db, first.id).find((slot) => slot.id === firstSlot.id)?.userId, 'first-published-replacement');
    assert.equal(listScoutRosterSlots(db, otherDivision.id)[0]?.userId.startsWith('other-'), true);
  } finally {
    if (db?.open) closeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  }
});
