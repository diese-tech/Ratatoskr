import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeName, parseDraftTab, resolveDraftPicks } from './draftPicks.js';

// Mirrors the live draft grid: header row, Pick/Name row, Cap: row, then one row per round.
function draftTab() {
  const rows: string[][] = Array.from({ length: 26 }, () => Array(15).fill(''));
  const block = (top: number, column: number, team: string, names: string[]) => {
    rows[top]![column] = team;
    rows[top + 1]![column] = 'Pick'; rows[top + 1]![column + 1] = 'Name';
    rows[top + 2]![column] = 'Cap:'; rows[top + 2]![column + 1] = `${team} Captain`;
    names.forEach((name, index) => { rows[top + 3 + index]![column] = String(index * 10 + 1); rows[top + 3 + index]![column + 1] = name; });
  };
  block(3, 1, 'The Sewer', ['thehofather', 'Albatross', 'Third', 'Fourth', 'Fifth']);
  block(14, 5, 'Something Spicy', ['A', 'B', 'C', 'D']);
  return rows;
}

test('draft parser takes rounds 1-4 under each Cap: line from every team block', () => {
  const picks = parseDraftTab('Svartalfheim', draftTab());
  assert.equal(picks.length, 8);
  assert.deepEqual(picks[1], { division: 'Svartalfheim', team: 'The Sewer', round: 2, pick: '11', draftName: 'Albatross' });
  assert.ok(!picks.some((pick) => pick.draftName.includes('Captain') || pick.draftName === 'Fifth'));
  assert.deepEqual(picks.filter((pick) => pick.team === 'Something Spicy').map((pick) => pick.round), [1, 2, 3, 4]);
});

test('name normalization ignores case, spacing, and parenthetical aliases', () => {
  assert.equal(normalizeName('Veroxas (mist)'), normalizeName('veroxas'));
  assert.equal(normalizeName('Certified Asian (NinjaXK)'), normalizeName('Certified Asian'));
});

test('resolver prefers vetting usernames, falls back to league names, and flags moves and unknowns', () => {
  const picks = [
    { division: 'Alfheim', team: 'Dream Walkers', round: 1, pick: '3', draftName: 'Jayfeather777' },
    { division: 'Alfheim', team: 'Little Monsters', round: 2, pick: '14', draftName: 'Veroxas' },
    { division: 'Svartalfheim', team: 'The Sewer', round: 2, pick: '16', draftName: 'Albatross' },
    { division: 'Alfheim', team: 'The Sewer', round: 3, pick: '20', draftName: 'Nobody' },
  ];
  const resolved = resolveDraftPicks(picks, {
    vetting: [['a1', '2 Alfheim', 'Jayfeather777', 'jay_user']],
    memberDirectory: [['id-jay', 'jay_user', 'Jay', 'Jay'], ['id-alba', 'alba', 'Albatross', 'Albatross']],
    nameHistory: [['id-vero', 'Veroxas (mist)', 'Veroxas (mist)'], ['id-jay', 'Jayfeather', 'Jayfeather']],
    rosters: [
      ['Alfheim', 'Dream Walkers', 'r', 'Dream Walkers AD', 'id-jay', 'Jayfeather'],
      ['Alfheim', 'Little Monsters', 'r', 'Little Monsters AD', 'id-vero', 'Veroxas (mist)'],
    ],
  });
  assert.deepEqual(resolved.map((pick) => [pick.discordId, pick.matchSource, pick.status]), [
    ['id-jay', 'Vetting → Member Directory', 'On drafted team'],
    ['id-vero', 'Player Name History', 'On drafted team'],
    ['id-alba', 'Member Directory name', 'Moved · before tracking · now not rostered'],
    ['', 'UNRESOLVED', 'Unknown'],
  ]);
});

test('re-seeding keeps staff-entered IDs and runtime move records', () => {
  const picks = [
    { division: 'Alfheim', team: 'The Sewer', round: 3, pick: '20', draftName: 'Nobody' },
    { division: 'Alfheim', team: 'The Sewer', round: 4, pick: '29', draftName: 'Someone' },
  ];
  const resolved = resolveDraftPicks(picks, {
    vetting: [], memberDirectory: [['id-some', 'someone', 'Someone', 'Someone']], nameHistory: [], rosters: [],
  }, [
    ['Alfheim', 'The Sewer', '3', '20', 'Nobody', 'id-typed', '', 'UNRESOLVED', 'Unknown'],
    ['Alfheim', 'The Sewer', '4', '29', 'Someone', 'id-some', '', 'Member Directory name', 'Moved · drop · YSL-TRX-1'],
  ]);
  assert.deepEqual(resolved.map((pick) => [pick.discordId, pick.matchSource, pick.status]), [
    ['id-typed', 'Manual', 'Moved · before tracking · now not rostered'],
    ['id-some', 'Member Directory name', 'Moved · drop · YSL-TRX-1'],
  ]);
});

test('a division-suffixed draft header still counts as the drafted team', () => {
  const [pick] = resolveDraftPicks(
    [{ division: 'Svartalfheim', team: 'The Sewer SD', round: 1, pick: '1', draftName: 'thehofather' }],
    {
      vetting: [], memberDirectory: [], nameHistory: [['id-ho', 'thehofather', 'thehofather']],
      rosters: [['Svartalfheim', 'The Sewer', 'r', 'The Sewer SD', 'id-ho', 'thehofather']],
    },
  );
  assert.equal(pick?.status, 'On drafted team');
});
