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
