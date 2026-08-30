import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DivisionSpec } from '../config/guild-structure.js';
import { getDivisionSpec, getDivisionTemplate, getExpectedChannelNames, isDivisionKey } from './divisions.js';

test('isDivisionKey recognizes every configured division key and rejects unknown ones', () => {
  assert.equal(isDivisionKey('vanaheim'), true);
  assert.equal(isDivisionKey('svartalfheim'), true);
  assert.equal(isDivisionKey('niflheim'), false);
});

test('getDivisionSpec resolves a known key and throws on an unknown one', () => {
  assert.equal(getDivisionSpec('vanaheim').name, 'Vanaheim');
  assert.throws(() => getDivisionSpec('niflheim' as never), /Unknown division key: niflheim/);
});

test('getDivisionTemplate: renaming a division\'s display name alone (key unchanged) never changes any channel\'s key -- #31 Defect 1/Defect 2', () => {
  // This is the division-domain equivalent of the server/season config-side
  // rename regression tests: a display-name-only rename must change every
  // presentational channel *name* (they're slug-derived from the division's
  // current name) but must never change a channel's *key*, since the key --
  // not the name -- is what getActiveManagedResourceByLogicalKey resolves
  // identity by. If this ever regressed, a division rename would silently
  // orphan every one of its managed channels and create duplicates.
  const original: DivisionSpec = { key: 'vanaheim', name: 'Vanaheim' };
  const renamedDisplayNameOnly: DivisionSpec = { key: 'vanaheim', name: 'Vanir Prime' };

  const originalKeys = getDivisionTemplate(original).channels.map((channel) => channel.key);
  const renamedKeys = getDivisionTemplate(renamedDisplayNameOnly).channels.map((channel) => channel.key);
  assert.deepEqual(renamedKeys, originalKeys);

  const originalNames = getDivisionTemplate(original).channels.map((channel) => channel.name);
  const renamedNames = getDivisionTemplate(renamedDisplayNameOnly).channels.map((channel) => channel.name);
  assert.notDeepEqual(renamedNames, originalNames, 'channel names ARE expected to change -- they are presentational');
});

test('getDivisionTemplate: channel names are division-prefixed text (kebab-case) and title-cased voice, matching the existing live naming convention', () => {
  const template = getDivisionTemplate({ key: 'vanaheim', name: 'Vanaheim' });
  const byKey = new Map(template.channels.map((channel) => [channel.key, channel.name]));

  assert.equal(byKey.get('captain_chat'), 'vanaheim-captain-chat');
  assert.equal(byKey.get('general'), 'vanaheim-general');
  assert.equal(byKey.get('lobby'), 'Vanaheim Lobby');
});

test('getExpectedChannelNames returns exactly the seven canonical division channel names', () => {
  const names = getExpectedChannelNames({ key: 'alfheim', name: 'Alfheim' });
  assert.deepEqual(names, [
    'alfheim-captain-chat',
    'alfheim-announcements',
    'alfheim-general',
    'alfheim-tier-list',
    'alfheim-scheduling',
    'alfheim-match-reports',
    'Alfheim Lobby',
  ]);
});
