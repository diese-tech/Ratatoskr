import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { test } from 'node:test';
import { STAFF_ROLES } from './divisions.js';
import { resolveChannelPermissionOverwrites } from './serverBootstrap.js';
import { evaluateSeasonCreateEligibility, seasonChannelLogicalKey, SEASON_CHANNELS } from './seasonBootstrap.js';

const EVERYONE_ID = 'everyone-role-id';
const roleIds: Record<string, string> = { Aesir: 'aesir-id', Allfather: 'allfather-id', Valkyries: 'valkyries-id' };
const resolveRoleId = (name: string) => roleIds[name];

test('SEASON_CHANNELS is exactly the five canonical season channels, all read-only', () => {
  const names = SEASON_CHANNELS.map((channel) => channel.name);
  assert.deepEqual(names, ['banned-content', 'schedule', 'standings', 'rosters', 'transactions']);
  for (const spec of SEASON_CHANNELS) {
    assert.equal(spec.readOnly, true);
  }
  // No season-announcements or season-specific rules channel -- those stay
  // permanent/global (#announcements in WELCOME, #league-rules in LEAGUE
  // INFORMATION), never duplicated per season. No separate free-agency
  // channel either -- rosters and free agents share one linked Google Sheet,
  // so #rosters is the single home for both.
  assert.ok(!names.some((name) => name.includes('announcement')));
  assert.ok(!names.some((name) => name.includes('rules')));
  assert.ok(!names.includes('free-agency'));
});

test('seasonChannelLogicalKey is stable and namespaced by season number', () => {
  assert.equal(seasonChannelLogicalKey(2, 'schedule'), 'season:2:channel:schedule:text_channel');
  assert.notEqual(seasonChannelLogicalKey(1, 'schedule'), seasonChannelLogicalKey(2, 'schedule'));
});

test('seasonChannelLogicalKey: renaming a channel spec\'s display name alone (key unchanged) never changes the key -- #31 Defect 2', () => {
  // seasonChannelLogicalKey takes spec.key directly and has no name-based
  // parameter at all -- so unlike the server domain (which derives a key
  // from a whole structure object), this property holds by construction
  // rather than needing to be proven against a structure. This test pins
  // that guarantee against the real SEASON_CHANNELS config, computing keys
  // from an edited copy that only changes `name`, to make the invariant
  // explicit and catch any future refactor that reintroduces a name-derived
  // key (e.g. switching the function to accept the whole spec object).
  const before = SEASON_CHANNELS.map((spec) => seasonChannelLogicalKey(1, spec.key));
  const renamedDisplayNamesOnly = SEASON_CHANNELS.map((spec) => ({ ...spec, name: `${spec.name}-renamed` }));
  const after = renamedDisplayNamesOnly.map((spec) => seasonChannelLogicalKey(1, spec.key));
  assert.deepEqual(after, before);
});

test('season channels are publicly viewable but read-only for non-staff members', () => {
  const result = resolveChannelPermissionOverwrites(EVERYONE_ID, resolveRoleId, [...STAFF_ROLES], SEASON_CHANNELS[0]);
  assert.ok(result);

  const everyone = result!.find((entry) => entry.id === EVERYONE_ID);
  assert.ok(!everyone?.deny.includes(PermissionFlagsBits.ViewChannel), 'season channels must stay publicly viewable');
  assert.ok(everyone?.deny.includes(PermissionFlagsBits.SendMessages), 'non-staff must not be able to post');

  const staff = result!.find((entry) => entry.id === roleIds.Aesir);
  assert.ok(staff?.allow.includes(PermissionFlagsBits.SendMessages), 'staff must retain posting access');
});

test('evaluateSeasonCreateEligibility blocks creation when a season is already active', () => {
  const result = evaluateSeasonCreateEligibility({ seasonNumber: 1 }, undefined);
  assert.equal(result.outcome, 'blocked-active-season');
  assert.equal(result.outcome === 'blocked-active-season' && result.activeSeasonNumber, 1);
});

test('evaluateSeasonCreateEligibility blocks creation for an active season regardless of the requested number', () => {
  // Requesting season 5 while season 1 is active must still fail closed --
  // the active-season check always wins, independent of which number was
  // asked for.
  const result = evaluateSeasonCreateEligibility({ seasonNumber: 1 }, { id: 9, status: 'inactive' });
  assert.equal(result.outcome, 'blocked-active-season');
});

test('evaluateSeasonCreateEligibility allows creation when no season is active and none exists for this number', () => {
  const result = evaluateSeasonCreateEligibility(undefined, undefined);
  assert.equal(result.outcome, 'create-new');
});

test('evaluateSeasonCreateEligibility treats an existing inactive row for this number as a retry, not a fresh create', () => {
  const result = evaluateSeasonCreateEligibility(undefined, { id: 7, status: 'inactive' });
  assert.equal(result.outcome, 'retry-existing');
  assert.equal(result.outcome === 'retry-existing' && result.seasonId, 7);
});

test('evaluateSeasonCreateEligibility blocks creation for an archived season number without touching it', () => {
  const result = evaluateSeasonCreateEligibility(undefined, { id: 7, status: 'archived' });
  assert.equal(result.outcome, 'blocked-archived-conflict');
});
