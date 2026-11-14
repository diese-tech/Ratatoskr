import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LEAGUE_DIVISIONS, LEAGUE_DIVISION_METADATA, compareDivisions, divisionAlternation, isLeagueDivision, parseLeagueDivision,
} from './leagueDivisions.js';

test('league divisions keep the existing order with Niflheim last and layered on Svartalfheim', () => {
  assert.deepEqual(LEAGUE_DIVISIONS, ['Vanaheim', 'Alfheim', 'Svartalfheim', 'Niflheim']);
  assert.deepEqual(['Niflheim', 'Unknown', 'Svartalfheim', 'Vanaheim', 'Alfheim'].sort(compareDivisions),
    ['Vanaheim', 'Alfheim', 'Svartalfheim', 'Niflheim', 'Unknown']);
  assert.deepEqual(LEAGUE_DIVISION_METADATA.Niflheim, { publicTab: 'Niflheim Roster', hasPublicFreeAgentList: false, layeredOn: 'Svartalfheim' });
  for (const division of ['Vanaheim', 'Alfheim', 'Svartalfheim'] as const) {
    assert.deepEqual(LEAGUE_DIVISION_METADATA[division], { publicTab: `${division} Roster`, hasPublicFreeAgentList: true });
  }
});

test('division parsing accepts exact names only and keeps the existing error wording', () => {
  assert.equal(parseLeagueDivision('Niflheim'), 'Niflheim');
  assert.equal(isLeagueDivision('niflheim'), false);
  assert.throws(() => parseLeagueDivision(''), /^Error: Unsupported league division: \(blank\)\.$/);
  assert.throws(() => parseLeagueDivision('Midgard'), /Unsupported league division: Midgard\./);
});

test('the division alternation matches whole division names in issue strings', () => {
  const pattern = new RegExp(`^(${divisionAlternation()}) (.+) public roster does not match Current Rosters\\.$`);
  assert.deepEqual('Niflheim The Rat Pack public roster does not match Current Rosters.'.match(pattern)?.slice(1), ['Niflheim', 'The Rat Pack']);
  assert.equal('Midgard The Rat Pack public roster does not match Current Rosters.'.match(pattern), null);
});
