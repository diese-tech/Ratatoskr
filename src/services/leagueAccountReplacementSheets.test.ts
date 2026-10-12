import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLeagueAccountReplacementPlan } from '../domain/leagueAccountReplacement.js';
import { buildTradePlan } from '../domain/leagueOperations.js';
import { accountReplacementSources } from './accountReplacement.test-support.js';

test('account replacement guards and writes only its existing roster/name cells, preserves draft status and historical IDs', async () => {
  const f = accountReplacementSources();
  const loaded = await f.sheets.load([...f.members.values()], 'fa');
  const plan = buildLeagueAccountReplacementPlan({ guildId: 'g', snapshot: loaded.snapshot,
    oldDiscordId: 'one', newDiscordId: 'new', oldMember: null, newMember: f.members.get('new')!, newNameSheetRow: 9 });
  const beforeHistory = structuredClone(f.gateway.rows('admin', 'Transaction History'));
  const beforeRoster = structuredClone(f.gateway.rows('admin', 'Current Rosters')[5]);
  const beforeAlias = structuredClone(f.gateway.rows('admin', 'Player Name History')[6]);
  const prepared = await f.sheets.prepareAccountReplacement(loaded, plan);
  assert.equal(f.gateway.writes.length, 0);
  await f.sheets.applyAccountReplacement(prepared, () => {});
  await f.sheets.verifyAccountReplacement(prepared);
  assert.deepEqual(f.gateway.rows('admin', 'Current Rosters')[5], beforeRoster!.map((cell, index) => index === 4 ? 'new' : cell));
  assert.deepEqual(f.gateway.rows('admin', 'Player Name History')[6], beforeAlias);
  assert.equal(f.gateway.rows('admin', 'Player Name History')[5]![3], 'Previous / Alternate');
  assert.equal(f.gateway.rows('admin', 'Player Name History')[8]![0], 'new');
  assert.deepEqual(f.gateway.rows('admin', 'Draft Picks')[5]!.slice(8), ['Moved · trade · legacy', 'new']);
  assert.equal(f.gateway.rows('admin', 'Draft Picks')[5]![5], 'new');
  assert.deepEqual(f.gateway.rows('admin', 'Transaction History'), beforeHistory);
  assert.equal(f.gateway.writes.filter((write) => write.workbook === 'public').length, 0);
  assert.equal(f.gateway.appends, 0);
});

test('changed name owns one public cell; pre-write drift and unavailable Draft Picks are explicit', async () => {
  for (const missingPicks of [false, true]) {
    const f = accountReplacementSources();
    f.gateway.missingDraftPicks = missingPicks;
    f.members.get('new')!.displayName = 'One New';
    const loaded = await f.sheets.load([...f.members.values()], 'fa');
    const plan = buildLeagueAccountReplacementPlan({ guildId: 'g', snapshot: loaded.snapshot,
      oldDiscordId: 'one', newDiscordId: 'new', oldMember: null, newMember: f.members.get('new')!, newNameSheetRow: 9 });
    const prepared = await f.sheets.prepareAccountReplacement(loaded, plan);
    assert.equal(prepared.draftVerification, missingPicks ? 'skipped:missing-tab' : 'verified');
    f.gateway.rows('admin', 'Current Rosters')[5]![8] = 'Unreviewed manual edit';
    await assert.rejects(() => f.sheets.applyAccountReplacement(prepared, () => assert.fail('must not enter write phase')), /before-values changed/i);
    assert.equal(f.gateway.writes.length, 0);
    f.gateway.rows('admin', 'Current Rosters')[5]![8] = 'Keep source';
    await f.sheets.applyAccountReplacement(prepared, () => {});
    await f.sheets.verifyAccountReplacement(prepared);
    assert.deepEqual(f.gateway.writes.find((write) => write.workbook === 'public')!.updates,
      [{ range: "'Vanaheim Roster'!C5", values: [['One New']] }]);
    assert.equal(f.gateway.writes.some((write) => write.updates.some((update) => update.range.includes('Transaction History'))), false);
  }
});

test('a subsequent legitimate move still detects the protected pick through the replacement ID', async () => {
  const f = accountReplacementSources();
  const before = await f.sheets.load([...f.members.values()], 'fa');
  const replacement = buildLeagueAccountReplacementPlan({ guildId: 'g', snapshot: before.snapshot,
    oldDiscordId: 'one', newDiscordId: 'new', oldMember: null, newMember: f.members.get('new')!, newNameSheetRow: 9 });
  await f.sheets.applyAccountReplacement(await f.sheets.prepareAccountReplacement(before, replacement), () => {});
  assert.equal(f.gateway.appends, 0);
  f.gateway.append = async (workbook, _range, rows) => { f.gateway.appends++; f.gateway.rows(workbook, 'Transaction History').push(...rows); };
  const after = await f.sheets.load([...f.members.values()], 'fa');
  const move = buildTradePlan(after.snapshot, 'new', 'two');
  const moved = await f.sheets.appendTransactionHistory(move, { reference: 'real-move', effectiveDate: '2026-10-11', processedById: 'admin', processedBy: 'Admin' });
  assert.equal(moved[0]?.discordId, 'new');
  assert.equal(f.gateway.rows('admin', 'Transaction History')[5]![6], 'one');
  assert.equal(f.gateway.rows('admin', 'Transaction History')[6]![6], 'new');
  assert.deepEqual(f.gateway.rows('admin', 'Draft Picks')[5]!.slice(8), ['Moved · trade · real-move', 'new']);
});
