import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTradePlan, type LeagueSnapshot } from '../domain/leagueOperations.js';
import { openDatabase } from '../db/client.js';
import { getLeagueTransaction, hasSuccessfulLeagueAudit } from '../db/repositories/leagueOperations.js';
import { LeagueSheetDriftError, LeagueSheetReconciliationRequiredError } from './leagueSheets.js';
import { buildLeagueAnnouncement, executeLeagueTransaction, reconcilePendingLeagueTransactions } from './leagueTransactions.js';

function snapshot(): LeagueSnapshot {
  return {
    teams: [
      { teamKey: 'Vanaheim|A', franchise: 'A', division: 'Vanaheim', teamRoleId: 'team-a', teamRole: 'A VD', divisionRoleId: 'division', active: true },
      { teamKey: 'Vanaheim|B', franchise: 'B', division: 'Vanaheim', teamRoleId: 'team-b', teamRole: 'B VD', divisionRoleId: 'division', active: true },
    ],
    rosters: [
      { sheetRow: 6, division: 'Vanaheim', franchise: 'A', teamRoleId: 'team-a', team: 'A VD', discordId: 'one', player: 'One', rosterStatus: 'Captain' },
      { sheetRow: 7, division: 'Vanaheim', franchise: 'B', teamRoleId: 'team-b', team: 'B VD', discordId: 'two', player: 'Two', rosterStatus: 'Player' },
    ],
    names: [
      { sheetRow: 6, discordId: 'one', currentLeagueName: 'One', knownName: 'One', nameStatus: 'Current Discord Name', division: 'Vanaheim', franchise: 'A', leagueStatus: 'Captain' },
      { sheetRow: 7, discordId: 'two', currentLeagueName: 'Two', knownName: 'Two', nameStatus: 'Current Discord Name', division: 'Vanaheim', franchise: 'B', leagueStatus: 'Player' },
    ],
    discordMembers: [
      { discordId: 'one', displayName: 'One', roleIds: ['team-a', 'division'] },
      { discordId: 'two', displayName: 'Two', roleIds: ['team-b', 'division'] },
    ],
    publicRosters: { Vanaheim: { teams: { A: ['One'], B: ['Two'] }, freeAgents: [] } },
    freeAgentRoleId: 'free-agent',
  };
}

function fixture(sheetFailure?: Error) {
  const db = openDatabase(':memory:');
  const events: string[] = [];
  const current = snapshot();
  const sheets = {
    load: async () => ({ snapshot: current, sources: {} as never }),
    assertUnchanged: async () => { events.push('sheet-preflight'); },
    apply: async () => { events.push('sheet-apply'); if (sheetFailure) throw sheetFailure; },
    appendTransactionHistory: async () => { events.push('history'); },
  };
  const discord = {
    applyRoleChange: async (change: { discordId: string }) => { events.push(`discord:${change.discordId}`); },
    rollbackRoleChange: async (change: { discordId: string }) => { events.push(`rollback:${change.discordId}`); },
    announce: async () => { events.push('announce'); return 'message'; },
  };
  return { db, events, current, sheets, discord };
}

test('first mutation of the league day audits before Discord and completes the durable sequence', async () => {
  const f = fixture();
  const result = await executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildTradePlan(current, 'one', 'two'),
  });
  assert.equal(hasSuccessfulLeagueAudit(f.db, 'guild', '2026-09-30'), true);
  assert.deepEqual(f.events, ['sheet-preflight', 'discord:one', 'discord:two', 'sheet-apply', 'announce', 'history']);
  assert.equal(getLeagueTransaction(f.db, result.reference)?.status, 'completed');
  assert.equal(getLeagueTransaction(f.db, result.reference)?.announcementId, 'message');
  f.db.close();
});

test('trade announcement uses the locked Yggdrasil copy and pings only both team roles', () => {
  const plan = buildTradePlan(snapshot(), 'one', 'two');
  assert.deepEqual(buildLeagueAnnouncement(plan, 'Admin'), {
    content: '<@&team-a> <@&team-b>',
    allowedRoleIds: ['team-a', 'team-b'],
    title: 'Word Travels the Branches',
    description: [
      'Ratatoskr carries news of an agreement between <@&team-a> and <@&team-b>.',
      '',
      '<@one> leaves <@&team-a> to join <@&team-b>.',
      '<@two> leaves <@&team-b> to join <@&team-a>.',
    ].join('\n'),
    footer: 'Posted by Admin',
  });
});

test('failed daily audit blocks every mutation and records no transaction', async () => {
  const f = fixture();
  f.current.publicRosters.Vanaheim!.teams.A = ['Wrong'];
  await assert.rejects(() => executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildTradePlan(current, 'one', 'two'),
  }), /daily league audit failed/i);
  assert.equal(hasSuccessfulLeagueAudit(f.db, 'guild', '2026-09-30'), false);
  assert.deepEqual(f.events, []);
  f.db.close();
});

test('a safe sheet preflight failure rolls Discord back and closes the attempt as failed', async () => {
  const f = fixture(new LeagueSheetDriftError('changed'));
  const reference = await executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildTradePlan(current, 'one', 'two'),
  }).then(() => '', (error: Error & { reference?: string }) => { assert.match(error.message, /changed/); return error.reference!; });
  assert.deepEqual(f.events.slice(-2), ['rollback:two', 'rollback:one']);
  assert.equal(getLeagueTransaction(f.db, reference)?.status, 'failed');
  f.db.close();
});

test('an ambiguous sheet write never rolls Discord back and requires reconciliation', async () => {
  const f = fixture(new LeagueSheetReconciliationRequiredError('partial'));
  const reference = await executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildTradePlan(current, 'one', 'two'),
  }).then(() => '', (error: Error & { reference?: string }) => error.reference!);
  assert.equal(f.events.some((event) => event.startsWith('rollback:')), false);
  assert.equal(getLeagueTransaction(f.db, reference)?.status, 'reconciliation_required');
  f.db.close();
});

test('startup recovery reuses a confirmed announcement and appends history idempotently', async () => {
  const f = fixture();
  f.discord.announce = async () => { f.events.push('announce'); throw new Error('temporary'); };
  const reference = await executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildTradePlan(current, 'one', 'two'),
  }).then(() => '', (error: Error & { reference?: string }) => error.reference!);
  assert.equal(getLeagueTransaction(f.db, reference)?.status, 'announcement_pending');
  f.discord.announce = async () => { f.events.push('recovered-announce'); return 'recovered-message'; };
  await reconcilePendingLeagueTransactions({ db: f.db, sheets: f.sheets, discord: f.discord });
  assert.equal(getLeagueTransaction(f.db, reference)?.status, 'completed');
  assert.equal(getLeagueTransaction(f.db, reference)?.announcementId, 'recovered-message');
  assert.deepEqual(f.events.slice(-2), ['recovered-announce', 'history']);
  await reconcilePendingLeagueTransactions({ db: f.db, sheets: f.sheets, discord: f.discord });
  assert.equal(f.events.filter((event) => event === 'recovered-announce').length, 1);
  f.db.close();
});
