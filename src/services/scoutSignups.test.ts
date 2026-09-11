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
import { createSqliteScoutSignupStore, type ScoutSignupStore } from '../storage/index.js';
import { withScoutSetupLock } from './scoutSetupLock.js';

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

test('eligible signup reconciliation preserves fixed staff seats while refreshing automatic seats', async () => {
  const db = openDatabase(':memory:');
  try {
    const storage = createSqliteScoutSignupStore(db);
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

    assert.equal(await reconcileWorkingScoutRoster(storage, setup.id, [
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

test('working-roster reconciliation awaits asynchronous state before committing the generated roster', async () => {
  let releaseSetup!: () => void;
  let announceSetupRead!: () => void;
  const setupGate = new Promise<void>((resolve) => { releaseSetup = resolve; });
  const setupRead = new Promise<void>((resolve) => { announceSetupRead = resolve; });
  const events: string[] = [];
  const setup = {
    id: 7,
    status: 'open',
    version: 3,
    gameCount: 1,
  } as Awaited<ReturnType<ScoutSignupStore['getSetup']>>;
  const storage = {
    async getSetup() {
      events.push('setup-read-started');
      announceSetupRead();
      await setupGate;
      events.push('setup-read-complete');
      return setup;
    },
    async listRosterSlots() {
      events.push('slots-read');
      return [];
    },
    async reconcileWorkingRoster(input: { expectedVersion: number }) {
      events.push(`reconcile:${input.expectedVersion}`);
      return 'updated' as const;
    },
  } as unknown as ScoutSignupStore;

  const reconciliation = reconcileWorkingScoutRoster(storage, 7, [
    { userId: 'player', role: 'solo', createdAt: '2026-01-01' },
  ], 'signup');
  await setupRead;
  assert.deepEqual(events, ['setup-read-started']);
  releaseSetup();

  assert.equal(await reconciliation, 'updated');
  assert.deepEqual(events, ['setup-read-started', 'setup-read-complete', 'slots-read', 'reconcile:3']);
});

test('Scout signup locking serializes one setup while allowing another setup to progress', async () => {
  const scope = {};
  const events: string[] = [];
  let releaseFirst!: () => void;
  let announceFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>((resolve) => { announceFirst = resolve; });
  const first = withScoutSetupLock(scope, 1, async () => {
    events.push('first-start');
    announceFirst();
    await firstGate;
    events.push('first-finish');
  });
  await firstStarted;
  const second = withScoutSetupLock(scope, 1, async () => { events.push('second'); });
  const other = withScoutSetupLock(scope, 2, async () => { events.push('other'); });
  await other;
  assert.deepEqual(events, ['first-start', 'other']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'other', 'first-finish', 'second']);
});

test('signup roster reconciliation retries a stale staff-mutation race with fresh fixed seats', async () => {
  let version = 3;
  const expectedVersions: number[] = [];
  const storage = {
    async getSetup() {
      return { id: 7, status: 'open', version, gameCount: 1 };
    },
    async listRosterSlots() {
      return version === 3 ? [] : [{
        gameNumber: 1,
        team: 'team_one',
        role: 'mid',
        userId: 'staff-seat',
        staffAssigned: true,
      }];
    },
    async reconcileWorkingRoster(input: { expectedVersion: number; slots: readonly { userId: string }[] }) {
      expectedVersions.push(input.expectedVersion);
      if (expectedVersions.length === 1) {
        version = 4;
        return 'stale' as const;
      }
      assert.ok(input.slots.some((slot) => slot.userId === 'staff-seat'));
      return 'updated' as const;
    },
  } as unknown as ScoutSignupStore;

  assert.equal(await reconcileWorkingScoutRoster(storage, 7, [
    { userId: 'automatic', role: 'solo', createdAt: '2026-01-01' },
  ], 'signup'), 'updated');
  assert.deepEqual(expectedVersions, [3, 4]);
});
