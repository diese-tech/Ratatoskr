import assert from 'node:assert/strict';
import test from 'node:test';
import type { ScoutRosterSlotRecord, ScoutSetup, ScoutSignup } from '../db/types.js';
import { buildScoutWorkingRosterView } from './scoutReview.js';

const setup = {
  id: 87,
  guildId: 'guild',
  divisionDisplayName: 'Alfheim',
  startAt: 2_000_000_000,
  gameCount: 1,
  version: 4,
  status: 'open',
} as ScoutSetup;

const baseSlot = {
  id: 1, setupId: 87, gameNumber: 1, team: 'team_one', role: 'solo', userId: 'solo',
  staffAssigned: false, offRole: false, assignedByUserId: null, replacementNeeded: false,
  replacementRequestedAt: null, createdAt: 'now', updatedAt: 'now',
} as ScoutRosterSlotRecord;

test('working Scout Ops view shows partial assignments, OPEN seats, unseated roles and guarded controls', () => {
  const slots: ScoutRosterSlotRecord[] = [
    baseSlot,
    { ...baseSlot, id: 2, team: 'team_two', userId: 'manual', staffAssigned: true, offRole: true },
  ];
  const signups = [
    { id: 1, setupId: 87, userId: 'solo', role: 'solo', createdAt: 'now' },
    { id: 2, setupId: 87, userId: 'manual', role: 'mid', createdAt: 'now' },
    { id: 3, setupId: 87, userId: 'waiting', role: 'jungle', createdAt: 'now' },
    { id: 4, setupId: 87, userId: 'waiting', role: 'support', createdAt: 'now' },
  ] as ScoutSignup[];
  const view = buildScoutWorkingRosterView(setup, slots, signups);

  assert.match(view.content, /2\/10 seated/);
  assert.match(view.content, /needs Jungle, Mid, Support, Carry/);
  assert.match(view.content, /Solo: <@solo>/);
  assert.match(view.content, /Solo: <@manual> \*\(manual, off-role\)\*/);
  assert.match(view.content, /Jungle: \*\*OPEN\*\*/);
  assert.match(view.content, /Unseated signups \(1\)/);
  assert.match(view.content, /<@waiting> · Jungle, Support/);
  const controls = view.components.flatMap((row) => row.toJSON().components);
  assert.deepEqual(controls.map((control) => 'label' in control ? control.label : undefined), [
    'Seat player', 'Swap players', 'Refresh draft', 'Publish roster', 'Cancel setup',
  ]);
  assert.equal('disabled' in controls[3]! && controls[3]!.disabled, true);
});

test('working Scout Ops view reserves room for summaries and warnings within Discord limits', () => {
  const twoGameSetup = { ...setup, gameCount: 2 } as ScoutSetup;
  const roles = ['solo', 'jungle', 'mid', 'support', 'carry'] as const;
  const teams = ['team_one', 'team_two'] as const;
  const slots = [1, 2].flatMap((gameNumber) => teams.flatMap((team) => roles.map((role, index) => ({
    ...baseSlot,
    id: gameNumber * 100 + (team === 'team_one' ? 0 : 10) + index,
    gameNumber,
    team,
    role,
    userId: `${gameNumber}${team === 'team_one' ? '1' : '2'}${String(index).padStart(16, '0')}`,
  })))) as ScoutRosterSlotRecord[];
  const eligible = Array.from({ length: 60 }, (_, index) => ({
    id: 1_000 + index, setupId: setup.id, userId: `31${String(index).padStart(16, '0')}`,
    role: roles[index % roles.length], createdAt: 'now',
  })) as ScoutSignup[];
  const ineligible = Array.from({ length: 30 }, (_, index) => ({
    signup: {
      id: 2_000 + index, setupId: setup.id, userId: `41${String(index).padStart(16, '0')}`,
      role: roles[index % roles.length], createdAt: 'now',
    } as ScoutSignup,
    reason: { kind: 'missing_role' as const, roleId: '123456789012345678' },
  }));

  const view = buildScoutWorkingRosterView(
    twoGameSetup, slots, eligible, new Set([slots[0]!.userId]), ineligible,
  );

  assert.ok(view.content.length <= 2_000);
  assert.match(view.content, /additional signup/);
  assert.match(view.content, /additional ineligible signup/);
  assert.match(view.content, /need staff attention/);
});
